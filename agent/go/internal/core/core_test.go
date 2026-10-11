package core

import (
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBatchRefusesInvalidValues(t *testing.T) {
	b := NewBatch()
	b.Add("x", Gauge, "h", math.NaN())
	b.Add("x", Gauge, "h", math.Inf(1))
	b.Add("c_total", Counter, "h", -1)
	b.Add("bad name", Gauge, "h", 1)
	b.Add("ok", Gauge, "h", 1, "bad-label", "v")
	if b.Len() != 0 || b.Dropped != 5 {
		t.Fatalf("len %d dropped %d", b.Len(), b.Dropped)
	}
}

func TestBatchTextFormat(t *testing.T) {
	b := NewBatch()
	b.Add("m", Gauge, "help", 1.5, "z", "1", "a", `q"\`)
	got := b.Text(1700000000000)
	want := "# HELP m help\n# TYPE m gauge\nm{a=\"q\\\"\\\\\",z=\"1\"} 1.5 1700000000000\n"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestRates(t *testing.T) {
	r := NewRates()
	t0 := time.Unix(100, 0)
	if _, ok := r.Rate("k", 10, t0); ok {
		t.Fatal("first sample has no rate")
	}
	if v, ok := r.Rate("k", 30, t0.Add(10*time.Second)); !ok || v != 2 {
		t.Fatalf("want 2/s got %v %v", v, ok)
	}
	if _, ok := r.Rate("k", 5, t0.Add(20*time.Second)); ok {
		t.Fatal("reset must give no rate")
	}
	if _, ok := r.Rate("k", 6, t0.Add(20*time.Second)); ok {
		t.Fatal("zero elapsed time must give no rate")
	}
}

func writeConf(t *testing.T, main string, extra map[string]string) string {
	dir := t.TempDir()
	p := filepath.Join(dir, "agent.conf")
	os.WriteFile(p, []byte(main), 0o644)
	if len(extra) > 0 {
		os.MkdirAll(filepath.Join(dir, "conf.d"), 0o755)
		for n, c := range extra {
			os.WriteFile(filepath.Join(dir, "conf.d", n), []byte(c), 0o644)
		}
	}
	return p
}

func TestConfigValidation(t *testing.T) {
	cases := map[string]string{
		"server = http://obs.example.com\n":                         "https",
		"server = https://localhost\n":                              "this machine",
		"server = https://obs.example.com\nlisten = 0.0.0.0:9109\n": "loopback",
		"server = https://obs.example.com\ncollect_interval = 1s\n": "between",
		"server = https://obs.example.com\nconfig_version = 99\n":   "newer",
		"server = https://obs.example.com\nlabel.host = x\n":        "not allowed",
		"server = https://obs.example.com\nwhat = 1\n":              "unknown setting",
		"": "server is required",
		"server = https://obs.example.com\nca_file = /nope/ca.crt\n": "ca_file",
	}
	for conf, want := range cases {
		_, err := LoadConfig(writeConf(t, conf, nil))
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("config %q: want error containing %q, got %v", conf, want, err)
		}
	}
}

func TestConfigPrecedenceDefaultsServerHost(t *testing.T) {
	p := writeConf(t, "server = https://obs.example.com\nenv = prod\n", map[string]string{"20-x.conf": "collect_interval = 20s\n", "10-y.conf": "collect_interval = 10s\nlabel.team = core\n"})
	remote := map[string]string{"collect_interval": "60s", "heartbeat_interval": "45s", "server": "https://evil.example.com", "env": "dev"}
	c, err := LoadConfigWithRemote(p, remote)
	if err != nil {
		t.Fatal(err)
	}
	if c.Server != "https://obs.example.com" {
		t.Fatal("the server may never change where the agent sends data")
	}
	if c.CollectInterval != 20*time.Second {
		t.Fatalf("host file (conf.d, later name wins) must override the server: %v", c.CollectInterval)
	}
	if c.HeartbeatInterval != 45*time.Second || c.Sources["heartbeat_interval"] != "server" {
		t.Fatal("a setting not set on the host comes from the server")
	}
	if c.Env != "prod" {
		t.Fatal("host env must win over server env")
	}
	if c.Labels["team"] != "core" {
		t.Fatal("labels from conf.d")
	}
	locked := strings.Join(c.HostLocked(), ",")
	if !strings.Contains(locked, "collect_interval") || !strings.Contains(locked, "env") || strings.Contains(locked, "heartbeat_interval") {
		t.Fatalf("locked: %s", locked)
	}
}

func TestIdentityRoundTripAndDamage(t *testing.T) {
	dir := t.TempDir()
	if id, _, err := LoadIdentity(dir); id != nil || err != nil {
		t.Fatal("never enrolled = nil, nil")
	}
	cred := "oac_0123456789abcdef0123_" + strings.Repeat("A", 43)
	if err := SaveIdentity(dir, &Identity{AgentID: "agt_0123456789abcdef0123", Host: "h"}, cred); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(filepath.Join(dir, "credential"))
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("credential must be 0600, is %v", st.Mode().Perm())
	}
	id, c, err := LoadIdentity(dir)
	if err != nil || id.AgentID != "agt_0123456789abcdef0123" || c != cred {
		t.Fatalf("round trip: %v %v", id, err)
	}
	os.WriteFile(filepath.Join(dir, "credential"), []byte("garbage"), 0o600)
	if _, _, err := LoadIdentity(dir); err == nil || !strings.Contains(err.Error(), "re-enroll") {
		t.Fatalf("damaged credential must be reported: %v", err)
	}
}

func TestBackoffIsBoundedAndJittered(t *testing.T) {
	b := &Backoff{Base: time.Second, Max: time.Minute}
	for i := 0; i < 50; i++ {
		d := b.Next()
		if d <= 0 || d > time.Minute+time.Second {
			t.Fatalf("backoff out of range: %v", d)
		}
	}
}
