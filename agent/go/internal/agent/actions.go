package agent

// Actions requested on the Agents page. The list is fixed (diagnostics, restart, upgrade): the server can never
// send a command to run. Each action arrives in a heartbeat answer, is carried out once (ids are remembered on
// disk, so a restart does not repeat a restart), and its result is posted back.
//
//   diagnostics  build a bundle (status, settings in effect, collectors, system facts, recent log lines,
//                connectivity checks) and upload it; no secrets are read or sent
//   restart      report, then exit with code 75: systemd (Restart=on-failure) starts the agent again
//   upgrade      write upgrade-request.json; the root-owned observaone-agent-updater (a systemd path unit)
//                downloads, verifies and installs the new binary and rolls back if it does not come up.
//                The agent itself never replaces its binary and never runs as root.

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"observaone/agent/internal/core"
)

// ErrRestartRequested is returned by Run when the Agents page asked for a restart.
var ErrRestartRequested = errors.New("restart requested from ObservaOne")

// RestartExitCode: non-zero so systemd's Restart=on-failure starts the agent again.
const RestartExitCode = 75

type Action struct {
	ID     int64          `json:"id"`
	Action string         `json:"action"`
	Args   map[string]any `json:"args"`
}

const maxBundle = 900 << 10 // the server accepts 1 MB

func (a *Agent) donePath() string { return filepath.Join(a.Config().StateDir, "actions-done.json") }

func (a *Agent) loadDone() map[int64]bool {
	m := map[int64]bool{}
	b, err := os.ReadFile(a.donePath())
	if err != nil {
		return m
	}
	var ids []int64
	if json.Unmarshal(b, &ids) == nil {
		for _, id := range ids {
			m[id] = true
		}
	}
	return m
}

func (a *Agent) markDone(id int64) {
	a.mu.Lock()
	if a.done == nil {
		a.done = map[int64]bool{}
	}
	a.done[id] = true
	ids := make([]int64, 0, len(a.done))
	for k := range a.done {
		ids = append(ids, k)
	}
	a.mu.Unlock()
	// keep the newest 200 ids (they only grow)
	for len(ids) > 200 {
		mi := 0
		for i := range ids {
			if ids[i] < ids[mi] {
				mi = i
			}
		}
		ids = append(ids[:mi], ids[mi+1:]...)
	}
	b, _ := json.Marshal(ids)
	_ = core.WriteFileAtomic(a.donePath(), b, 0o640)
}

func (a *Agent) isDone(id int64) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.done[id]
}

func (a *Agent) postResult(ctx context.Context, id int64, ok bool, msg string, extra map[string]any) error {
	a.mu.Lock()
	cl, cred, aid := a.client, a.cred, a.id.AgentID
	a.mu.Unlock()
	body := map[string]any{"ok": ok, "message": msg}
	for k, v := range extra {
		body[k] = v
	}
	return cl.PostJSON(ctx, core.AgentPath(aid, "actions/"+strconv.FormatInt(id, 10)+"/result"), cred, body, nil)
}

// handleActions runs in the heartbeat goroutine; each action is quick (the bundle is built from memory and
// small files, with short timeouts).
func (a *Agent) handleActions(ctx context.Context, list []Action) {
	for _, act := range list {
		if act.ID <= 0 || a.isDone(act.ID) {
			continue
		}
		a.Log.Info("action requested from ObservaOne", "action", act.Action, "id", act.ID)
		switch act.Action {
		case "diagnostics":
			err := a.uploadDiagnostics(ctx, act.ID)
			if err != nil {
				a.Log.Warn("diagnostics upload failed", "error", err.Error())
				_ = a.postResult(ctx, act.ID, false, "upload failed: "+err.Error(), nil)
			}
			a.markDone(act.ID)
		case "restart":
			a.markDone(act.ID) // before exiting: the restarted agent must not restart again
			_ = a.postResult(ctx, act.ID, true, "restarting", nil)
			a.Log.Info("restarting as requested (systemd starts the agent again)")
			select {
			case a.restart <- struct{}{}:
			default:
			}
		case "upgrade":
			msg, err := a.requestUpgrade(act)
			a.markDone(act.ID)
			if err != nil {
				_ = a.postResult(ctx, act.ID, false, err.Error(), nil)
			} else {
				a.Log.Info(msg)
			}
		default:
			a.markDone(act.ID)
			_ = a.postResult(ctx, act.ID, false, "this agent does not know the action "+strconv.Quote(act.Action), nil)
		}
	}
}

// ---------------- upgrade (carried out by the root-owned updater) ----------------

type upgradeRequest struct {
	ActionID    int64  `json:"actionId"`
	Version     string `json:"version"`
	FromVersion string `json:"fromVersion"`
	RequestedAt string `json:"requestedAt"`
}

type upgradeResult struct {
	ActionID   int64  `json:"actionId"`
	OK         bool   `json:"ok"`
	Message    string `json:"message"`
	Version    string `json:"version"`
	FinishedAt string `json:"finishedAt"`
}

func (a *Agent) requestUpgrade(act Action) (string, error) {
	dir := a.Config().StateDir
	if _, err := os.Stat("/etc/systemd/system/observaone-agent-updater.path"); err != nil && a.Config().RootPath == "/" {
		return "", fmt.Errorf("the updater is not installed on this host (agent installed before 1.3): run the installer once, then upgrades work from the UI")
	}
	v, _ := act.Args["version"].(string)
	req := upgradeRequest{ActionID: act.ID, Version: v, FromVersion: a.Version, RequestedAt: time.Now().UTC().Format(time.RFC3339)}
	b, _ := json.Marshal(req)
	if err := core.WriteFileAtomic(filepath.Join(dir, "upgrade-request.json"), b, 0o640); err != nil {
		return "", err
	}
	return "upgrade requested: the updater installs the new version and restarts the agent", nil
}

// checkUpgradeResult reports what the updater did (once), then renames the file.
func (a *Agent) checkUpgradeResult(ctx context.Context) {
	p := filepath.Join(a.Config().StateDir, "upgrade-result.json")
	b, err := os.ReadFile(p)
	if err != nil {
		return
	}
	var r upgradeResult
	if json.Unmarshal(b, &r) != nil || r.ActionID <= 0 {
		_ = os.Rename(p, p+".bad")
		return
	}
	if err := a.postResult(ctx, r.ActionID, r.OK, r.Message, map[string]any{"version": r.Version}); err != nil {
		return // try again next heartbeat
	}
	_ = os.Rename(p, filepath.Join(a.Config().StateDir, "upgrade-result.reported.json"))
}

// ---------------- diagnostics bundle ----------------

func (a *Agent) uploadDiagnostics(ctx context.Context, actionID int64) error {
	bundle := a.Diagnostics(ctx)
	b, _ := json.Marshal(bundle)
	for len(b) > maxBundle { // drop the oldest log lines until it fits
		logs, _ := bundle["logs"].([]string)
		if len(logs) < 10 {
			break
		}
		bundle["logs"] = logs[len(logs)/2:]
		bundle["logsTruncated"] = true
		b, _ = json.Marshal(bundle)
	}
	a.mu.Lock()
	cl, cred, aid := a.client, a.cred, a.id.AgentID
	a.mu.Unlock()
	return cl.PostJSON(ctx, core.AgentPath(aid, "diagnostics"), cred, map[string]any{"actionId": actionID, "bundle": bundle}, nil)
}

// Diagnostics collects what support needs. Never: credential, token, private keys, environment variables,
// command lines, file contents outside /proc and /etc/os-release.
func (a *Agent) Diagnostics(ctx context.Context) map[string]any {
	cfg := a.Config()
	st := a.snapshot()
	out := map[string]any{
		"generatedAt": time.Now().UTC().Format(time.RFC3339),
		"agent": map[string]any{"version": a.Version, "agentId": st.AgentID, "host": st.Host, "pid": os.Getpid(),
			"go": runtime.Version(), "arch": runtime.GOARCH, "startedAt": a.started.UTC().Format(time.RFC3339),
			"configVersionApplied": a.appliedVersion(), "configError": a.configErr()},
		"status": st,
	}
	var settings []map[string]string
	for _, r := range cfg.Effective() {
		settings = append(settings, map[string]string{"setting": r[0], "value": r[1], "source": r[2]})
	}
	out["settings"] = settings
	if cfg.Mode == "pull" {
		out["pull"] = a.pullReport()
	}
	out["system"] = systemFacts(cfg)
	out["stateDir"] = stateDirListing(cfg.StateDir)
	out["checks"] = connectivity(ctx, cfg)
	if a.LogRing != nil {
		out["logs"] = a.LogRing.Lines()
	}
	return out
}

func systemFacts(cfg *core.Config) map[string]any {
	m := map[string]any{"cpus": runtime.NumCPU()}
	if b, err := os.ReadFile(filepath.Join(cfg.RootPath, "etc/os-release")); err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(l, "PRETTY_NAME=") {
				m["os"] = strings.Trim(strings.TrimPrefix(l, "PRETTY_NAME="), `"`)
			}
		}
	}
	if b, err := os.ReadFile(filepath.Join(cfg.ProcPath, "sys/kernel/osrelease")); err == nil {
		m["kernel"] = strings.TrimSpace(string(b))
	}
	if b, err := os.ReadFile(filepath.Join(cfg.ProcPath, "uptime")); err == nil {
		var up float64
		fmt.Sscanf(string(b), "%f", &up)
		m["uptimeSeconds"] = int64(up)
	}
	if b, err := os.ReadFile(filepath.Join(cfg.ProcPath, "meminfo")); err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(l, "MemTotal:") || strings.HasPrefix(l, "MemAvailable:") {
				f := strings.Fields(l)
				if len(f) >= 2 {
					m[strings.TrimSuffix(f[0], ":")+"KB"] = f[1]
				}
			}
		}
	}
	if b, err := os.ReadFile(filepath.Join(cfg.ProcPath, "loadavg")); err == nil {
		m["loadavg"] = strings.Join(strings.Fields(string(b))[:3], " ")
	}
	var mounts []string
	if f, err := os.Open(filepath.Join(cfg.ProcPath, "mounts")); err == nil {
		sc := bufio.NewScanner(f)
		for sc.Scan() && len(mounts) < 60 {
			x := strings.Fields(sc.Text())
			if len(x) >= 3 && (strings.HasPrefix(x[0], "/dev/") || x[2] == "nfs" || x[2] == "nfs4" || x[2] == "xfs" || x[2] == "ext4") {
				mounts = append(mounts, x[1]+" "+x[2])
			}
		}
		f.Close()
	}
	m["mounts"] = mounts
	var ifs []string
	if list, err := net.Interfaces(); err == nil {
		for _, in := range list {
			addrs, _ := in.Addrs()
			var as []string
			for _, ad := range addrs {
				as = append(as, ad.String())
			}
			ifs = append(ifs, fmt.Sprintf("%s %s [%s]", in.Name, in.Flags.String(), strings.Join(as, ", ")))
		}
	}
	m["interfaces"] = ifs
	return m
}

// stateDirListing: names, sizes and modes only (the credential's CONTENT is never read here).
func stateDirListing(dir string) []string {
	var out []string
	ents, err := os.ReadDir(dir)
	if err != nil {
		return []string{"cannot list: " + err.Error()}
	}
	for _, e := range ents {
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, fmt.Sprintf("%s %s %d", info.Mode().String(), e.Name(), info.Size()))
	}
	return out
}

// connectivity: DNS and TLS to the server (with the same trust settings the agent uses).
func connectivity(ctx context.Context, cfg *core.Config) map[string]any {
	m := map[string]any{"server": cfg.Server}
	u, err := url.Parse(cfg.Server)
	if err != nil {
		m["error"] = err.Error()
		return m
	}
	host, port := u.Hostname(), u.Port()
	if port == "" {
		port = "443"
	}
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	t0 := time.Now()
	ips, err := net.DefaultResolver.LookupHost(cctx, host)
	if err != nil {
		m["dns"] = "failed: " + err.Error()
		return m
	}
	m["dns"] = fmt.Sprintf("%s (%d ms)", strings.Join(ips, ", "), time.Since(t0).Milliseconds())
	tc, err := core.TLSConfig(cfg)
	if err != nil {
		m["tls"] = "config: " + err.Error()
		return m
	}
	t0 = time.Now()
	d := &tls.Dialer{NetDialer: &net.Dialer{Timeout: 5 * time.Second}, Config: tc}
	conn, err := d.DialContext(cctx, "tcp", net.JoinHostPort(host, port))
	if err != nil {
		m["tls"] = "failed: " + err.Error()
		return m
	}
	cs := conn.(*tls.Conn).ConnectionState()
	conn.Close()
	m["tls"] = fmt.Sprintf("ok (%s, %d ms)", tls.VersionName(cs.Version), time.Since(t0).Milliseconds())
	if len(cs.PeerCertificates) > 0 {
		m["serverCertificate"] = map[string]any{"subject": cs.PeerCertificates[0].Subject.String(), "notAfter": cs.PeerCertificates[0].NotAfter.UTC().Format(time.RFC3339)}
	}
	return m
}
