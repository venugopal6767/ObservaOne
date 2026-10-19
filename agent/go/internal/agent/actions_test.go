package agent

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"observaone/agent/internal/core"
)

func testAgent(t *testing.T, yaml string) *Agent {
	t.Helper()
	dir := t.TempDir()
	state := filepath.Join(dir, "state")
	os.MkdirAll(state, 0o700)
	cfg := filepath.Join(dir, "agent.yaml")
	os.WriteFile(cfg, []byte("server: https://obs.example.com\nstate_dir: "+state+"\n"+yaml), 0o644)
	if err := core.SaveIdentity(state, &core.Identity{AgentID: "agt_00000000000000000001", Host: "h", Server: "https://obs.example.com"}, "oac_00000000000000000001_"+strings.Repeat("A", 43)); err != nil {
		t.Fatal(err)
	}
	a := &Agent{Version: "1.3.0", ConfigPath: cfg, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if err := a.Load(); err != nil {
		t.Fatal(err)
	}
	return a
}

func TestServerSettingsVersions(t *testing.T) {
	a := testAgent(t, "")
	a.applyServerSettings(hbAnswer{Config: map[string]string{"collect_interval": "30s", "disable": "network"}, ConfigVersion: 4})
	if c := a.Config(); c.CollectInterval != 30*time.Second || !c.Disabled["network"] || a.appliedVersion() != 4 {
		t.Fatalf("v4 not applied: %v %v %d", c.CollectInterval, c.Disabled, a.appliedVersion())
	}
	// a lower or equal version is ignored
	a.applyServerSettings(hbAnswer{Config: map[string]string{"collect_interval": "60s"}, ConfigVersion: 4})
	if a.Config().CollectInterval != 30*time.Second {
		t.Fatal("same version re-applied")
	}
	// an invalid value is refused, reported, the old settings stay, and it is not retried
	a.applyServerSettings(hbAnswer{Config: map[string]string{"collect_interval": "1s"}, ConfigVersion: 7})
	if a.Config().CollectInterval != 30*time.Second || a.appliedVersion() != 4 || !strings.Contains(a.configErr(), "collect_interval") {
		t.Fatalf("invalid settings: %v %d %q", a.Config().CollectInterval, a.appliedVersion(), a.configErr())
	}
	// keys the server may not set are ignored, whatever it sends
	a.applyServerSettings(hbAnswer{Config: map[string]string{"server": "https://evil.example.com", "listen": "0.0.0.0:1", "collect_interval": "20s"}, ConfigVersion: 9})
	if c := a.Config(); c.Server != "https://obs.example.com" || c.Listen != "" || c.CollectInterval != 20*time.Second || a.configErr() != "" {
		t.Fatalf("server-only keys leaked: %+v err=%q", c, a.configErr())
	}
	// survives a restart: a new agent process loads version 9
	b := &Agent{Version: "1.3.0", ConfigPath: a.ConfigPath, Log: a.Log}
	if err := b.Load(); err != nil || b.appliedVersion() != 9 || b.Config().CollectInterval != 20*time.Second {
		t.Fatalf("after restart: %v %d", err, b.appliedVersion())
	}
}

func TestHostFileWinsOverServer(t *testing.T) {
	a := testAgent(t, "collect_interval: 45s\n")
	a.applyServerSettings(hbAnswer{Config: map[string]string{"collect_interval": "10s"}, ConfigVersion: 2})
	if a.Config().CollectInterval != 45*time.Second || a.appliedVersion() != 2 {
		t.Fatalf("host file must win: %v", a.Config().CollectInterval)
	}
}

func TestActionsOnceAndUnknown(t *testing.T) {
	a := testAgent(t, "")
	a.restart = make(chan struct{}, 1)
	a.markDone(5)
	b := &Agent{Version: "1.3.0", ConfigPath: a.ConfigPath, Log: a.Log}
	_ = b.Load()
	b.done = b.loadDone()
	if !b.isDone(5) || b.isDone(6) {
		t.Fatal("done ids must survive a restart")
	}
	// a done restart is not carried out again (no client call needed: it is skipped)
	b.restart = make(chan struct{}, 1)
	b.handleActions(context.Background(), []Action{{ID: 5, Action: "restart"}})
	select {
	case <-b.restart:
		t.Fatal("restart repeated after a restart")
	default:
	}
}

func TestDiagnosticsHasNoSecrets(t *testing.T) {
	a := testAgent(t, "")
	a.LogRing = core.NewLogRing(5)
	for i := 0; i < 8; i++ {
		a.LogRing.Write([]byte("line " + string(rune('a'+i)) + "\n"))
	}
	if l := a.LogRing.Lines(); len(l) != 5 || l[0] != "line d" {
		t.Fatalf("ring: %v", l)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	d := a.Diagnostics(ctx)
	for _, k := range []string{"agent", "status", "settings", "system", "stateDir", "checks", "logs"} {
		if _, ok := d[k]; !ok {
			t.Errorf("bundle misses %s", k)
		}
	}
	s := strings.ToLower(strings.Join(func() []string {
		var out []string
		for _, v := range d["stateDir"].([]string) {
			out = append(out, v)
		}
		return out
	}(), " "))
	if !strings.Contains(s, "credential") || strings.Contains(s, "oac_00000000000000000001_"+strings.Repeat("A", 43)) {
		t.Fatalf("state dir listing must name files, never show their content: %s", s)
	}
}

func TestDiskBufferSpillPruneOrder(t *testing.T) {
	a := testAgent(t, "disk_buffer:\n  enabled: true\n  max_mb: 1\n  max_age: 10m\nbuffer_payloads: 1\n")
	now := time.Now().UnixMilli()
	for i, at := range []int64{now - 20*60_000, now - 3000, now - 2000, now - 1000} { // the first is older than max_age
		if err := a.spill(payload{text: strings.Repeat("x 1\n", 10+i), collectedAt: at}); err != nil {
			t.Fatal(err)
		}
	}
	a.diskPrune(0)
	l := a.diskList()
	if len(l) != 3 || l[0].collectedAt != now-3000 || l[2].collectedAt != now-1000 {
		t.Fatalf("expected the 3 recent entries, oldest first: %+v", l)
	}
	// size cap: 300 kB of noise each, 1 MB limit -> the oldest go first
	noise := make([]byte, 300<<10)
	for i := range noise {
		noise[i] = byte('a' + (i*7919)%26)
	}
	for i := 0; i < 5; i++ {
		_ = a.spill(payload{text: string(noise) + strconv.Itoa(i), collectedAt: now + int64(i)})
	}
	_, sz := a.diskStats()
	if sz > 1<<20 {
		t.Fatalf("disk buffer over its cap: %d bytes", sz)
	}
	// memory overflow goes to disk instead of being dropped
	b := testAgent(t, "disk_buffer:\n  enabled: true\nbuffer_payloads: 1\n")
	b.wake = make(chan struct{}, 1)
	b.collectOnce()
	b.collectOnce()
	b.collectOnce()
	if n, _ := b.diskStats(); n != 2 || len(b.buf) != 1 || b.dropped != 0 {
		t.Fatalf("overflow: disk=%d mem=%d dropped=%d", n, len(b.buf), b.dropped)
	}
	// stopping keeps the rest
	b.spillAll()
	if n, _ := b.diskStats(); n != 3 || len(b.buf) != 0 {
		t.Fatalf("spillAll: disk=%d mem=%d", n, len(b.buf))
	}
}
