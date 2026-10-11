// Package agent runs the ObservaOne agent: collect -> buffer -> upload, heartbeats, reloads and shutdown.
// It is platform independent; platform collectors are passed in.
package agent

import (
	"context"
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
	if a.env == nil {
		a.env = &collector.Env{Rates: core.NewRates(), Version: a.Version}
	}
	a.env.Proc, a.env.Sys, a.env.Root = cfg.ProcPath, cfg.SysPath, cfg.RootPath
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
	a.env.Proc, a.env.Sys, a.env.Root = cfg.ProcPath, cfg.SysPath, cfg.RootPath
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
	a.Log.Info("agent starting", "version", a.Version, "agent_id", a.id.AgentID, "host", a.id.Host, "server", a.cfg.Server)
	var wg sync.WaitGroup
	wg.Add(3)
	go func() { defer wg.Done(); a.collectLoop(ctx) }()
	go func() { defer wg.Done(); a.uploadLoop(ctx) }()
	go func() { defer wg.Done(); a.heartbeatLoop(ctx) }()
	var srv *http.Server
	if l := a.cfg.Listen; l != "" {
		srv = a.localServer(l)
	}
	for {
		select {
		case <-reload:
			a.Reload()
		case <-ctx.Done():
			a.Log.Info("stopping: sending what is buffered (max 5 s)")
			fctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			a.flush(fctx)
			cancel()
			if srv != nil {
				_ = srv.Close()
			}
			wg.Wait()
			a.writeStatus()
			a.Log.Info("agent stopped")
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
	if len(a.buf) >= cfg.BufferPayloads { // bounded: drop the OLDEST so memory never grows without limit
		a.buf = a.buf[1:]
		a.dropped++
	}
	a.buf = append(a.buf, payload{text: text, collectedAt: now.UnixMilli()})
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
	bo := &core.Backoff{Base: 2 * time.Second, Max: 5 * time.Minute}
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

// flush sends buffered payloads oldest first. Stops at the first retryable error.
func (a *Agent) flush(ctx context.Context) error {
	for {
		a.mu.Lock()
		if len(a.buf) == 0 {
			a.mu.Unlock()
			return nil
		}
		p := a.buf[0]
		cl, cred := a.client, a.cred
		a.mu.Unlock()

		err := cl.PostMetrics(ctx, cred, p.text, p.collectedAt)
		var ae *core.APIError
		switch {
		case err == nil:
			a.mu.Lock()
			if len(a.buf) > 0 && a.buf[0].collectedAt == p.collectedAt {
				a.buf = a.buf[1:]
			}
			a.lastPushOK = time.Now()
			a.mu.Unlock()
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
}

func (a *Agent) heartbeatLoop(ctx context.Context) {
	bo := &core.Backoff{Base: 5 * time.Second, Max: 5 * time.Minute}
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
	}
	if !a.lastPushOK.IsZero() {
		body["lastUploadAgoSeconds"] = int(time.Since(a.lastPushOK).Seconds())
	}
	a.mu.Unlock()
	if up, bt, k := hostTimes(a.env); up > 0 {
		body["uptimeSeconds"], body["bootTime"], body["kernel"] = up, bt, k
	}
	var ans hbAnswer
	err := cl.PostJSON(ctx, "/api/agent/v1/heartbeat", cred, body, &ans)
	if err != nil {
		var ae *core.APIError
		if errors.As(err, &ae) && ae.Status == 401 {
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
	if ans.Config != nil && !sameMap(ans.Config, a.remoteCopy()) {
		if err := saveRemote(a.ConfigPath, ans.Config); err != nil {
			a.Log.Error("cannot save settings from the server", "error", err.Error())
		} else {
			a.Log.Info("new settings from the server, reloading")
			a.Reload()
		}
	}
	a.writeStatus()
	// ±10% jitter so a fleet restarted together does not heartbeat in lockstep
	return interval + time.Duration((time.Now().UnixNano()%21-10)*int64(interval)/100)
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
	return Status{Version: a.Version, AgentID: a.id.AgentID, Host: a.id.Host, Server: a.cfg.Server, ServerStatus: a.serverState,
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
		Env: cfg.Env, Role: cfg.Role, Labels: cfg.Labels, MachineHash: machineHash(cfg.RootPath)}
	var ans enrollAnswer
	if err := cl.PostJSON(ctx, "/api/agent/v1/enroll", token, req, &ans); err != nil {
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
