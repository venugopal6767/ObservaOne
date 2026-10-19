package core

import (
	"math"
	"net"
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

func writeYAML(t *testing.T, main string, extra map[string]string) string {
	dir := t.TempDir()
	p := filepath.Join(dir, "agent.yaml")
	os.WriteFile(p, []byte(main), 0o644)
	if len(extra) > 0 {
		os.MkdirAll(filepath.Join(dir, "conf.d"), 0o755)
		for n, c := range extra {
			os.WriteFile(filepath.Join(dir, "conf.d", n), []byte(c), 0o644)
		}
	}
	return p
}

func TestYAMLConfig(t *testing.T) {
	p := writeYAML(t, `# comment
config_version: 2
server: https://obs.example.com   # trailing comment
env: "prod"
role: 'web'
collect_interval: 20s
disable: [network, disk]
labels:
  team: payments
  tier: "gold"
mode: pull
pull:
  listen: ":9110"
  allow:
    - 10.0.0.0/8
    - 192.168.1.7
`, map[string]string{"50-extra.yaml": "labels:\n  zone: a\n", "40-old.conf": "role = db\n"})
	c, err := LoadConfig(p)
	if err != nil {
		t.Fatal(err)
	}
	if c.Server != "https://obs.example.com" || c.Env != "prod" || c.Role != "db" || c.CollectInterval != 20*time.Second {
		t.Fatalf("scalars: %+v", c)
	}
	if !c.Disabled["network"] || !c.Disabled["disk"] || len(c.Disabled) != 2 {
		t.Fatalf("disable: %v", c.Disabled)
	}
	if c.Labels["team"] != "payments" || c.Labels["tier"] != "gold" || c.Labels["zone"] != "a" {
		t.Fatalf("labels: %v", c.Labels)
	}
	if c.Mode != "pull" || c.PullListen != ":9110" || len(c.PullAllow) != 2 {
		t.Fatalf("pull: %v %v %v", c.Mode, c.PullListen, c.PullAllow)
	}
	if !c.PullAllowed(net.ParseIP("10.1.2.3")) || !c.PullAllowed(net.ParseIP("192.168.1.7")) || c.PullAllowed(net.ParseIP("192.168.1.8")) {
		t.Fatal("pull.allow")
	}
	if len(c.LegacyFiles) != 1 {
		t.Fatalf("the conf.d/*.conf file must be reported as legacy: %v", c.LegacyFiles)
	}
}

func TestYAMLErrors(t *testing.T) {
	cases := map[string]string{
		"server: https://obs.example.com\n\tenv: x\n":                          "tabs",
		"server: https://obs.example.com\nenv: &a x\n":                         "not supported",
		"server: https://obs.example.com\nlabels: {a: b}\n":                    "flow maps",
		"server: https://obs.example.com\nenv: x\nenv: y\n":                    "twice",
		"server: https://obs.example.com\nmode: both\n":                        "mode must be",
		"server: https://obs.example.com\nmode: pull\npull:\n  listen: nope\n": "pull.listen",
		"server: https://obs.example.com\npull:\n  allow: [10.0.0.0/33]\n":     "pull.allow",
		"server: https://obs.example.com\nwhat: 1\n":                           "unknown setting",
		"server: https://obs.example.com\nlabel.team: x\n":                     "labels: section",
		"server: https://obs.example.com\nconfig_version: 3\n":                 "newer",
		"server: https://obs.example.com\n---\nenv: x\n":                       "one YAML document",
		"server: https://obs.example.com\nenv: \"x\n":                          "unterminated",
		"server: https://obs.example.com\n  env: x\n":                          "indentation",
	}
	for conf, want := range cases {
		_, err := LoadConfig(writeYAML(t, conf, nil))
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("config %q: want error containing %q, got %v", conf, want, err)
		}
	}
}

func TestHostYAMLRoundTrip(t *testing.T) {
	legacy := writeConf(t, "config_version = 1\nserver = https://obs.example.com\nenv = prod\nlabel.team = core\ndisable = network, disk\ncollect_interval = 30s\n", nil)
	c, err := LoadConfig(legacy)
	if err != nil {
		t.Fatal(err)
	}
	y := filepath.Join(filepath.Dir(legacy), "agent.yaml")
	os.WriteFile(y, []byte(c.HostYAML()), 0o644)
	c2, err := LoadConfig(y)
	if err != nil {
		t.Fatalf("%v\n%s", err, c.HostYAML())
	}
	if c2.Env != "prod" || c2.Labels["team"] != "core" || !c2.Disabled["disk"] || c2.CollectInterval != 30*time.Second || c2.Version != 2 {
		t.Fatalf("round trip lost settings:\n%s", c.HostYAML())
	}
	if _, ok := c2.Sources["heartbeat_interval"]; ok {
		t.Fatal("defaults must not be written into the migrated file")
	}
}
