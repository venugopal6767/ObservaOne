// Package agent runs the ObservaOne agent: collect -> buffer -> upload, heartbeats, reloads and shutdown.
// It is platform independent; platform collectors are passed in.
package agent

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"observaone/agent/internal/collector"
	"observaone/agent/internal/core"
)

type payload struct {
	text        string
	collectedAt int64
}

// Agent holds the running state. All fields behind mu.
type Agent struct {
	Version    string
	ConfigPath string
	Collectors []collector.Collector
	Log        *slog.Logger

	mu          sync.Mutex
	cfg         *core.Config
	client      *core.Client
	id          *core.Identity
	cred        string
	env         *collector.Env
	buf         []payload
	dropped     uint64 // payloads thrown away because the buffer was full
	pushFailed  uint64 // failed uploads (counter, survives nothing: resets on restart)
	lastPushOK  time.Time
	lastHBOK    time.Time
	lastErr     string
	states      map[string]collector.State
	lastText    string
	remote      map[string]string
	wake        chan struct{}
	hbInterval  time.Duration
	serverState string
	pullSt      *pullState

	LogRing    *core.LogRing // recent log lines for diagnostics bundles (optional)
	started    time.Time
	done       map[int64]bool // actions already carried out (persisted)
	restart    chan struct{}
	removed    chan struct{} // closed when ObservaOne answered 410 (agent removed)
	removeOnce sync.Once
	applied    int64  // server settings version in effect
	cfgErr     string // why the server's latest settings were refused
	rejected   int64  // version refused (not retried until a newer one arrives)
}

// Load reads config, server settings saved from the last heartbeat, and the identity.
func (a *Agent) Load() error {
	remote := loadRemote(a.ConfigPath)
	cfg, err := core.LoadConfigWithRemote(a.ConfigPath, remote)
	if err != nil {
		return err
	}
	cl, err := core.NewClient(cfg, a.Version)
	if err != nil {
		return err
	}
	id, cred, err := core.LoadIdentity(cfg.StateDir)
	if err != nil {
		return err
	}
	if id == nil {
		return fmt.Errorf("this agent is not enrolled yet: run 'observaone-agent enroll' (the installer does this)")
	}
	if id.Server != "" && id.Server != cfg.Server {
		return fmt.Errorf("enrolled with %s but config says server = %s: re-enroll to move to another server", id.Server, cfg.Server)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.cfg, a.client, a.id, a.cred, a.remote = cfg, cl, id, cred, remote
	a.hbInterval = cfg.HeartbeatInterval
	a.applied, _ = strconv.ParseInt(remote["_version"], 10, 64)
	if a.removed == nil {
		a.removed = make(chan struct{})
	}
	if a.restart == nil {
		a.restart = make(chan struct{}, 1)
		a.started = time.Now()
	}
	if a.env == nil {
		a.env = &collector.Env{Rates: core.NewRates(), Version: a.Version}
	}
	a.env.Proc, a.env.Sys, a.env.Root, a.env.Cfg = cfg.ProcPath, cfg.SysPath, cfg.RootPath, cfg
	if a.states == nil {
		a.states = map[string]collector.State{}
	}
	if a.wake == nil {
		a.wake = make(chan struct{}, 1)
	}
	return nil
}

// Reload re-reads the configuration. An invalid new config is refused and the old one keeps running.
func (a *Agent) Reload() {
	remote := loadRemote(a.ConfigPath)
	cfg, err := core.LoadConfigWithRemote(a.ConfigPath, remote)
	if err == nil && cfg.Server != a.Config().Server {
		err = fmt.Errorf("server cannot change on reload (re-enroll to move to another server)")
	}
	if old := a.Config(); err == nil && (cfg.Mode != old.Mode || cfg.PullListen != old.PullListen) {
		err = fmt.Errorf("mode and pull.listen change only on restart: sudo systemctl restart observaone-agent")
	}
	var cl *core.Client
	if err == nil {
		cl, err = core.NewClient(cfg, a.Version)
	}
	if err != nil {
		a.Log.Error("reload refused, keeping the running configuration", "error", err.Error())
		a.setErr("config reload refused: " + err.Error())
		return
	}
	a.mu.Lock()
	a.cfg, a.client, a.remote = cfg, cl, remote
	a.hbInterval = cfg.HeartbeatInterval
	a.applied, _ = strconv.ParseInt(remote["_version"], 10, 64)
	a.env.Proc, a.env.Sys, a.env.Root, a.env.Cfg = cfg.ProcPath, cfg.SysPath, cfg.RootPath, cfg
	a.mu.Unlock()
	a.Log.Info("configuration reloaded", "collect_interval", cfg.CollectInterval.String(), "heartbeat_interval", cfg.HeartbeatInterval.String())
}

func (a *Agent) Config() *core.Config {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cfg
}

func (a *Agent) setErr(s string) {
	a.mu.Lock()
	if len(s) > 280 {
		s = s[:280]
	}
	a.lastErr = s
	a.mu.Unlock()
}

// Run blocks until ctx is cancelled. reload receives SIGHUP.
func (a *Agent) Run(ctx context.Context, reload <-chan struct{}) error {
	ctx, cancel := context.WithCancel(ctx) // cancelled on SIGTERM or when a restart is requested
	defer cancel()
	a.Log.Info("agent starting", "version", a.Version, "agent_id", a.id.AgentID, "host", a.id.Host, "server", a.cfg.Server, "mode", a.cfg.Mode)
	for _, f := range a.cfg.LegacyFiles {
		a.Log.Warn("old key = value configuration file; convert it with 'observaone-agent config migrate' (support ends in the next release)", "file", f)
	}
	push := a.cfg.Mode == "push"
	if d := a.loadDone(); d != nil {
		a.mu.Lock()
		a.done = d
		a.mu.Unlock()
	}
	var wg sync.WaitGroup
	wg.Add(3)
	go func() { defer wg.Done(); a.collectLoop(ctx) }()
	go func() {
		defer wg.Done()
		if push {
			a.uploadLoop(ctx)
		} else {
			a.pullLoop(ctx)
		}
	}()
	go func() { defer wg.Done(); a.heartbeatLoop(ctx) }()
	var srv *http.Server
	if l := a.cfg.Listen; l != "" {
		srv = a.localServer(l)
	}
	restartRequested, removed := false, false
	removedCh := a.removed
	for {
		select {
		case <-removedCh:
			removed = true
			removedCh = nil // fire once
			cancel()
		case <-reload:
			a.Reload()
		case <-a.restart:
			restartRequested = true
			cancel()
		case <-ctx.Done():
			if removed { // nothing more is accepted for this identity: do not send or keep anything
				if srv != nil {
					_ = srv.Close()
				}
				wg.Wait()
				a.writeStatus()
				return ErrRemoved
			}
			a.Log.Info("stopping: sending what is buffered (max 5 s)")
			fctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			a.flush(fctx)
			cancel()
			if a.diskEnabled() {
				if n := a.spillAll(); n > 0 {
					a.Log.Info("kept unsent collections in the disk buffer", "collections", n)
				}
			}
			if srv != nil {
				_ = srv.Close()
			}
			wg.Wait()
			a.writeStatus()
			a.Log.Info("agent stopped")
			if restartRequested {
				return ErrRestartRequested
			}
			return nil
		}
	}
}

// ---------------- collection ----------------

func (a *Agent) collectLoop(ctx context.Context) {
	a.collectOnce()
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(a.Config().CollectInterval):
			a.collectOnce()
		}
	}
}

func (a *Agent) collectOnce() {
	cfg := a.Config()
	now := time.Now()
	a.env.Now = now
	out := core.NewBatch()
	states := map[string]collector.State{}
	for _, c := range a.Collectors {
		if cfg.Disabled[c.Name()] {
			states[c.Name()] = collector.State{Status: "disabled"}
			continue
		}
		b := core.NewBatch()
		t := time.Now()
		err := safeCollect(c, a.env, b)
		if errors.Is(err, collector.ErrNotConfigured) {
			states[c.Name()] = collector.State{Status: "disabled"}
			continue
		}
		st := collector.Classify(err)
		st.Duration = time.Since(t)
		states[c.Name()] = st
		if err == nil {
			out.Merge(b) // a failed collector contributes nothing: its area shows as unavailable, not 0
		} else {
			a.Log.Warn("collector failed", "collector", c.Name(), "status", st.Status, "error", st.Error)
		}
		out.Add("observaone_agent_collector_success", core.Gauge, "1 if the collector succeeded in the last round.", boolf(err == nil), "collector", c.Name())
		out.Add("observaone_agent_collector_duration_seconds", core.Gauge, "Time the collector took.", st.Duration.Seconds(), "collector", c.Name())
	}
	for _, n := range a.env.TakeNotes() {
		a.Log.Info("collection note", "note", n)
	}
	a.env.Rates.Prune(now.Add(-10 * cfg.CollectInterval))
	a.mu.Lock()
	out.Add("observaone_agent_upload_failures_total", core.Counter, "Uploads that failed since the agent started.", float64(a.pushFailed))
	out.Add("observaone_agent_buffered_payloads", core.Gauge, "Collections waiting to be uploaded.", float64(len(a.buf)))
	out.Add("observaone_agent_dropped_payloads_total", core.Counter, "Collections thrown away because the buffer was full.", float64(a.dropped))
	text := out.Text(now.UnixMilli())
	a.lastText = out.Text(0)
	a.states = states
	if cfg.Mode == "push" { // pull mode: Prometheus reads lastText, nothing is buffered
		if len(a.buf) >= cfg.BufferPayloads { // bounded: the OLDEST goes to the disk buffer, or is dropped
			oldest := a.buf[0]
			a.buf = a.buf[1:]
			if cfg.DiskBuffer {
				a.mu.Unlock()
				err := a.spill(oldest)
				a.mu.Lock()
				if err != nil {
					a.dropped++
					a.Log.Warn("disk buffer write failed; collection dropped", "error", err.Error())
				}
			} else {
				a.dropped++
			}
		}
		a.buf = append(a.buf, payload{text: text, collectedAt: now.UnixMilli()})
	}
	a.mu.Unlock()
	select {
	case a.wake <- struct{}{}:
	default:
	}
}

// a panicking collector must not take the agent down
func safeCollect(c collector.Collector, env *collector.Env, b *core.Batch) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("collector crashed: %v", r)
		}
	}()
	return c.Collect(env, b)
}

func boolf(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

// ---------------- upload ----------------

func (a *Agent) uploadLoop(ctx context.Context) {
	bo := &core.Backoff{Base: 2 * time.Second, Max: 2 * time.Minute}
	for {
		select {
		case <-ctx.Done():
			return
		case <-a.wake:
		}
		for {
			err := a.flush(ctx)
			if err == nil {
				bo.Reset()
				break
			}
			wait := bo.Next()
			var ae *core.APIError
			if errors.As(err, &ae) && ae.Retry > wait {
				wait = ae.Retry
			}
			a.Log.Warn("upload failed, retrying later", "error", err.Error(), "retry_in", wait.Round(time.Second).String())
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
		}
	}
}

// flush sends buffered payloads oldest first (disk buffer, then memory). Stops at the first retryable error.
func (a *Agent) flush(ctx context.Context) error {
	if err := a.flushDisk(ctx); err != nil {
		return err
	}
	for {
		a.mu.Lock()
		if len(a.buf) == 0 {
			a.mu.Unlock()
			return nil
		}
		p := a.buf[0]
		cl, cred := a.client, a.cred
		a.mu.Unlock()

		err := cl.PostMetrics(ctx, a.id.AgentID, cred, p.text, p.collectedAt)
		var ae *core.APIError
		switch {
		case err == nil:
			a.mu.Lock()
			if len(a.buf) > 0 && a.buf[0].collectedAt == p.collectedAt {
				a.buf = a.buf[1:]
			}
			a.lastPushOK = time.Now()
			if strings.HasPrefix(a.lastErr, "upload") { // a problem that is over is not reported any more
				a.lastErr = ""
			}
			a.mu.Unlock()
		case errors.As(err, &ae) && ae.Status == 410:
			a.removedByServer(ae.Code)
			return err
		case errors.As(err, &ae) && !ae.Retryable() && ae.Status != 401 && ae.Status != 403:
			// the server refused THIS payload (bad data): drop it, keep going
			a.mu.Lock()
			a.pushFailed++
			if len(a.buf) > 0 && a.buf[0].collectedAt == p.collectedAt {
				a.buf = a.buf[1:]
			}
			a.mu.Unlock()
			a.setErr("upload refused: " + err.Error())
		default:
			a.mu.Lock()
			a.pushFailed++
			a.mu.Unlock()
			if errors.As(err, &ae) && (ae.Status == 401 || ae.Status == 403) {
				a.setErr("upload not authorised (agent removed, blocked or credential invalid): " + err.Error())
			} else {
				a.setErr("upload: " + err.Error())
			}
			return err
		}
	}
}

// ---------------- heartbeat ----------------

type hbAnswer struct {
	Status           string            `json:"status"`
	HeartbeatSeconds int               `json:"heartbeatSeconds"`
	LatestVersion    string            `json:"latestVersion"`
	Config           map[string]string `json:"config"`
	ConfigVersion    int64             `json:"configVersion"` // 0 = the server has no settings layer (older server)
	Actions          []Action          `json:"actions"`
	Rotate           bool              `json:"rotate"` // the server wants this agent to take a new credential
}

func (a *Agent) appliedVersion() int64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.applied
}

func (a *Agent) configErr() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cfgErr
}

func (a *Agent) heartbeatLoop(ctx context.Context) {
	bo := &core.Backoff{Base: 5 * time.Second, Max: 2 * time.Minute}
	for {
		wait := a.heartbeatOnce(ctx, bo)
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

func (a *Agent) heartbeatOnce(ctx context.Context, bo *core.Backoff) time.Duration {
	a.mu.Lock()
	cl, cred := a.client, a.cred
	interval := a.hbInterval
	body := map[string]any{
		"version":           a.Version,
		"collectors":        statusMap(a.states),
		"collectorErrors":   errorMap(a.states),
		"uploadFailedTotal": a.pushFailed,
		"bufferedPayloads":  len(a.buf),
		"droppedPayloads":   a.dropped,
		"lastError":         a.lastErr,
		"hostLocked":        a.cfg.HostLocked(),
		"mode":              a.cfg.Mode,
		"configVersion":     a.applied,
		"diskBuffered":      0,
		"configError":       a.cfgErr,
	}
	pullMode := a.cfg.Mode == "pull"
	diskOn := a.cfg.DiskBuffer
	if !a.lastPushOK.IsZero() {
		body["lastUploadAgoSeconds"] = int(time.Since(a.lastPushOK).Seconds())
	}
	a.mu.Unlock()
	if pullMode {
		body["pull"] = a.pullReport()
	}
	if diskOn {
		n, sz := a.diskStats()
		body["diskBuffered"], body["diskBufferedBytes"] = n, sz
	}
	if ips, _ := pullAddresses(&core.Config{}); len(ips) > 0 {
		body["addresses"] = ips // for reachability probes from the server (ping / TCP)
	}
	if up, bt, k := hostTimes(a.env); up > 0 {
		body["uptimeSeconds"], body["bootTime"], body["kernel"] = up, bt, k
	}
	var ans hbAnswer
	err := cl.PostJSON(ctx, core.AgentPath(a.id.AgentID, "heartbeat"), cred, body, &ans)
	if err != nil {
		var ae *core.APIError
		if errors.As(err, &ae) && ae.Status == 410 {
			a.removedByServer(ae.Code)
			return time.Hour
		} else if errors.As(err, &ae) && ae.Status == 401 {
			a.Log.Error("heartbeat refused: the credential is not valid any more (agent removed?). Re-enroll with a new token.")
		} else if errors.As(err, &ae) && ae.Status == 403 {
			a.Log.Error("heartbeat refused: this agent is blocked on the Agents page")
		} else {
			a.Log.Warn("heartbeat failed", "error", err.Error())
		}
		a.setErr("heartbeat: " + err.Error())
		a.writeStatus()
		d := bo.Next()
		if d > interval*4 {
			return d
		}
		return interval + d/4
	}
	bo.Reset()
	a.mu.Lock()
	a.lastHBOK = time.Now()
	a.serverState = ans.Status
	if strings.HasPrefix(a.lastErr, "heartbeat:") {
		a.lastErr = ""
	}
	if s := ans.HeartbeatSeconds; s >= 5 && s <= 300 && a.cfg.Sources["heartbeat_interval"] == "" {
		a.hbInterval = time.Duration(s) * time.Second // the server's choice, unless the host config pins it
	}
	interval = a.hbInterval
	a.mu.Unlock()
	a.applyServerSettings(ans)
	if ans.Rotate {
		a.rotateCredential(ctx)
	}
	a.handleActions(ctx, ans.Actions)
	a.checkUpgradeResult(ctx)
	a.writeStatus()
	// ±10% jitter so a fleet restarted together does not heartbeat in lockstep
	return interval + time.Duration((time.Now().UnixNano()%21-10)*int64(interval)/100)
}

// applyServerSettings: a newer settings version from the server is checked against the host files, saved
// (so it survives restarts) and applied with a reload. A version the host refuses is reported, not retried.
func (a *Agent) applyServerSettings(ans hbAnswer) {
	if ans.Config == nil {
		return
	}
	a.mu.Lock()
	applied, rejected := a.applied, a.rejected
	a.mu.Unlock()
	m := map[string]string{}
	for k, v := range ans.Config {
		m[k] = v
	}
	if ans.ConfigVersion > 0 {
		if ans.ConfigVersion <= applied || ans.ConfigVersion == rejected {
			return
		}
		m["_version"] = strconv.FormatInt(ans.ConfigVersion, 10)
	} else if sameMap(m, a.remoteCopy()) {
		return
	}
	if err := saveRemote(a.ConfigPath, m); err != nil {
		a.Log.Error("settings from the server refused", "version", ans.ConfigVersion, "error", err.Error())
		a.mu.Lock()
		a.rejected, a.cfgErr = ans.ConfigVersion, err.Error()
		a.mu.Unlock()
		return
	}
	a.Log.Info("new settings from the server, reloading", "version", ans.ConfigVersion)
	a.Reload()
	a.mu.Lock()
	a.cfgErr = ""
	a.mu.Unlock()
}

func (a *Agent) remoteCopy() map[string]string {
	a.mu.Lock()
	defer a.mu.Unlock()
	m := map[string]string{}
	for k, v := range a.remote {
		m[k] = v
	}
	return m
}

func statusMap(s map[string]collector.State) map[string]string {
	m := map[string]string{}
	for k, v := range s {
		m[k] = v.Status
	}
	return m
}

func errorMap(s map[string]collector.State) map[string]string {
	m := map[string]string{}
	for k, v := range s {
		if v.Error != "" {
			m[k] = v.Error
		}
	}
	return m
}

func sameMap(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

func hostTimes(env *collector.Env) (uptime float64, boot int64, kernel string) {
	if b, err := os.ReadFile(filepath.Join(env.Proc, "uptime")); err == nil {
		fmt.Sscanf(string(b), "%f", &uptime)
	}
	if uptime > 0 {
		boot = time.Now().Add(-time.Duration(uptime * float64(time.Second))).Unix()
	}
	if b, err := os.ReadFile(filepath.Join(env.Proc, "sys/kernel/osrelease")); err == nil {
		kernel = strings.TrimSpace(string(b))
	}
	return
}

// ---------------- server settings saved locally (so they survive restarts) ----------------

func remotePath(cfgPath string) string {
	c, err := core.LoadConfig(cfgPath)
	dir := "/var/lib/observaone-agent"
	if err == nil {
		dir = c.StateDir
	}
	return filepath.Join(dir, "server-settings.json")
}

// LoadRemote returns the settings last received from the server (what "config show" must include).
func LoadRemote(cfgPath string) map[string]string { return loadRemote(cfgPath) }

func loadRemote(cfgPath string) map[string]string {
	b, err := os.ReadFile(remotePath(cfgPath))
	if err != nil {
		return nil
	}
	var m map[string]string
	if json.Unmarshal(b, &m) != nil {
		return nil
	}
	return m
}

func saveRemote(cfgPath string, m map[string]string) error {
	// check before saving: a bad value from the server must never break the next start
	if _, err := core.LoadConfigWithRemote(cfgPath, m); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(m, "", "  ")
	return core.WriteFileAtomic(remotePath(cfgPath), b, 0o640)
}

// ---------------- status file + local endpoint ----------------

// Status is written to <state_dir>/status.json for 'observaone-agent status' (no secrets in it).
type Status struct {
	Version          string                     `json:"version"`
	AgentID          string                     `json:"agentId"`
	Host             string                     `json:"host"`
	Server           string                     `json:"server"`
	ServerStatus     string                     `json:"serverStatus"`
	LastHeartbeatOK  *time.Time                 `json:"lastHeartbeatOk"`
	LastUploadOK     *time.Time                 `json:"lastUploadOk"`
	BufferedPayloads int                        `json:"bufferedPayloads"`
	DroppedPayloads  uint64                     `json:"droppedPayloads"`
	UploadFailures   uint64                     `json:"uploadFailures"`
	DiskBuffered     int                        `json:"diskBuffered,omitempty"`
	LastError        string                     `json:"lastError"`
	Collectors       map[string]collector.State `json:"collectors"`
	PID              int                        `json:"pid"`
	WrittenAt        time.Time                  `json:"writtenAt"`
}

func (a *Agent) snapshot() Status {
	a.mu.Lock()
	defer a.mu.Unlock()
	t := func(x time.Time) *time.Time {
		if x.IsZero() {
			return nil
		}
		return &x
	}
	cs := map[string]collector.State{}
	for k, v := range a.states {
		cs[k] = v
	}
	disk := 0
	if a.cfg.DiskBuffer {
		a.mu.Unlock()
		disk, _ = a.diskStats()
		a.mu.Lock()
	}
	return Status{Version: a.Version, AgentID: a.id.AgentID, Host: a.id.Host, Server: a.cfg.Server, ServerStatus: a.serverState, DiskBuffered: disk,
		LastHeartbeatOK: t(a.lastHBOK), LastUploadOK: t(a.lastPushOK), BufferedPayloads: len(a.buf), DroppedPayloads: a.dropped,
		UploadFailures: a.pushFailed, LastError: a.lastErr, Collectors: cs, PID: os.Getpid(), WrittenAt: time.Now()}
}

func (a *Agent) writeStatus() {
	b, _ := json.MarshalIndent(a.snapshot(), "", "  ")
	if err := core.WriteFileAtomic(filepath.Join(a.Config().StateDir, "status.json"), b, 0o640); err != nil {
		a.Log.Warn("cannot write status file", "error", err.Error())
	}
}

func (a *Agent) localServer(addr string) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(a.snapshot())
	})
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		t := a.lastText
		a.mu.Unlock()
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = w.Write([]byte(t))
	})
	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		a.Log.Error("local diagnostics endpoint not started", "listen", addr, "error", err.Error())
		return nil
	}
	go func() { _ = srv.Serve(ln) }()
	a.Log.Info("local diagnostics endpoint", "url", "http://"+addr+"/metrics")
	return srv
}

// ---------------- enrollment ----------------

// EnrollRequest is what the agent tells the server about itself.
type EnrollRequest struct {
	Hostname    string            `json:"hostname"`
	Platform    string            `json:"platform"`
	OS          string            `json:"os"`
	Kernel      string            `json:"kernel"`
	Arch        string            `json:"arch"`
	Version     string            `json:"version"`
	Env         string            `json:"env,omitempty"`
	Role        string            `json:"role,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"`
	MachineHash string            `json:"machineHash,omitempty"`
	Mode        string            `json:"mode,omitempty"`
	// replay protection: a captured registration cannot be sent again (the server remembers the nonce
	// for 10 minutes and refuses timestamps more than 5 minutes off)
	Nonce     string `json:"nonce"`
	Timestamp int64  `json:"timestamp"`
}

type enrollAnswer struct {
	AgentID    string `json:"agentId"`
	Host       string `json:"host"`
	Renamed    bool   `json:"renamed"`
	Reenrolled bool   `json:"reenrolled"`
	Credential string `json:"credential"`
}

// Enroll exchanges a one-time/limited enrollment token for this agent's own credential.
// The token is only sent to the server, never logged or saved.
func Enroll(ctx context.Context, cfg *core.Config, version, token, osName, kernel string, log *slog.Logger) (*core.Identity, error) {
	token = strings.TrimSpace(token)
	if !strings.HasPrefix(token, "oat_") {
		return nil, fmt.Errorf("that does not look like an enrollment token (oat_...)")
	}
	host := cfg.Hostname
	if host == "" {
		h, err := os.Hostname()
		if err != nil {
			return nil, err
		}
		host = strings.SplitN(h, ".", 2)[0]
	}
	cl, err := core.NewClient(cfg, version)
	if err != nil {
		return nil, err
	}
	req := EnrollRequest{Hostname: host, Platform: "linux", OS: osName, Kernel: kernel, Arch: runtime.GOARCH, Version: version,
		Env: cfg.Env, Role: cfg.Role, Labels: cfg.Labels, MachineHash: machineHash(cfg.RootPath), Mode: cfg.Mode,
		Nonce: randomHex(16), Timestamp: time.Now().UnixMilli()}
	var ans enrollAnswer
	if err := cl.PostJSON(ctx, core.RegisterPath, token, req, &ans); err != nil {
		return nil, err
	}
	id := &core.Identity{AgentID: ans.AgentID, Host: ans.Host, Server: cfg.Server, EnrolledAt: time.Now().UTC()}
	if err := core.SaveIdentity(cfg.StateDir, id, ans.Credential); err != nil {
		return nil, fmt.Errorf("enrolled as %s but could not save the credential (%w); free disk space and enroll again", ans.AgentID, err)
	}
	if ans.Renamed {
		log.Warn("another enrolled machine already uses this host name; this one is shown as "+ans.Host, "requested", host)
	}
	return id, nil
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err) // no randomness = no safe secrets; never continue
	}
	return hex.EncodeToString(b)
}

// machineHash identifies the machine (not the install): lets a re-installed agent take back its old record.
// Only a hash leaves the host, salted so it cannot be matched with other tools' machine ids.
func machineHash(root string) string {
	for _, p := range []string{"etc/machine-id", "var/lib/dbus/machine-id"} {
		if b, err := os.ReadFile(filepath.Join(root, p)); err == nil && len(strings.TrimSpace(string(b))) >= 16 {
			h := sha256.Sum256([]byte("observaone-agent:" + strings.TrimSpace(string(b))))
			return hex.EncodeToString(h[:])
		}
	}
	return ""
}

// ReadStatus loads the status file written by the running agent.
func ReadStatus(stateDir string) (*Status, error) {
	b, err := os.ReadFile(filepath.Join(stateDir, "status.json"))
	if err != nil {
		return nil, err
	}
	var s Status
	return &s, json.Unmarshal(b, &s)
}

// SortedKeys is a small helper for printing.
func SortedKeys[M ~map[string]V, V any](m M) []string {
	k := make([]string, 0, len(m))
	for x := range m {
		k = append(k, x)
	}
	sort.Strings(k)
	return k
}
