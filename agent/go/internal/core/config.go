package core

import (
	"bufio"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ConfigVersion is the newest configuration format this agent understands. A file with a newer version is
// refused (an old agent must not half-understand a new configuration).
//
//	1  agent.conf, "key = value" lines (agent 1.1). Still read, with a warning, for one release.
//	2  agent.yaml (agent 1.2+).
const ConfigVersion = 2

const (
	DefaultYAMLPath   = "/etc/observaone-agent/agent.yaml"
	DefaultLegacyPath = "/etc/observaone-agent/agent.conf"
	DefaultPullListen = ":9110"
)

// DefaultConfigPath is agent.yaml, or the old agent.conf when only that one exists (an agent upgraded
// without running the installer again).
func DefaultConfigPath() string {
	if _, err := os.Stat(DefaultYAMLPath); err == nil {
		return DefaultYAMLPath
	}
	if _, err := os.Stat(DefaultLegacyPath); err == nil {
		return DefaultLegacyPath
	}
	return DefaultYAMLPath
}

// IsLegacyPath: the old key = value format (anything that is not .yaml / .yml).
func IsLegacyPath(p string) bool {
	return !(strings.HasSuffix(p, ".yaml") || strings.HasSuffix(p, ".yml"))
}

// Config comes from /etc/observaone-agent/agent.yaml (+ conf.d/*.yaml). Secrets are never in this file:
// the enrollment token and the agent credential are separate files readable only by the agent's own user.
type Config struct {
	Server            string            // https://observaone.example.com (never localhost of the monitored host)
	CAFile            string            // trust this CA / self-signed certificate (empty = system trust store)
	Env, Role         string            // labels on every metric
	Labels            map[string]string // label.<name> = value
	Hostname          string            // override the host name sent at enrollment
	StateDir          string            // identity + credential (default /var/lib/observaone-agent)
	CollectInterval   time.Duration     // default 15s
	HeartbeatInterval time.Duration     // default 30s (the server may ask for another value)
	Listen            string            // local diagnostics endpoint (/metrics, /healthz); empty = off
	Disabled          map[string]bool   // collectors turned off: disable = network, disk
	BufferPayloads    int               // metric payloads kept while the server is unreachable (default 40)
	Version           int
	ProcPath          string            // default /proc  (a container that monitors its host mounts the host's /proc elsewhere)
	SysPath           string            // default /sys
	RootPath          string            // default /     (host root, for /etc/os-release and filesystem paths)
	Sources           map[string]string // setting -> where its value came from

	// Transport. push (default): the agent sends metrics to the server. pull: Prometheus scrapes the agent
	// over HTTPS with a client certificate; the agent only sends heartbeats.
	Mode          string
	PullListen    string       // address the pull endpoint listens on (default :9110)
	PullAdvertise string       // address Prometheus should scrape (default: what the server sees + local IPs)
	PullAllow     []*net.IPNet // only these source addresses may connect (empty = any; the client certificate is always required)

	LegacyFiles []string // key = value files that were read (shown as a warning)
}

var labelValRE = regexp.MustCompile(`^[A-Za-z0-9._-]{0,64}$`)
var labelKeyRE = regexp.MustCompile(`^[a-z][a-z0-9_]{0,30}$`)
var reserved = map[string]bool{"host": true, "job": true, "instance": true, "agent": true, "agent_id": true, "os": true, "platform": true, "env": true, "role": true, "cluster": true}

// Defaults: what the agent uses when nothing else says otherwise.
func Defaults() *Config {
	return &Config{Labels: map[string]string{}, Disabled: map[string]bool{}, StateDir: "/var/lib/observaone-agent",
		CollectInterval: 15 * time.Second, HeartbeatInterval: 30 * time.Second, BufferPayloads: 40, Version: 1,
		ProcPath: "/proc", SysPath: "/sys", RootPath: "/", Sources: map[string]string{},
		Mode: "push", PullListen: DefaultPullListen}
}

// RemoteKeys are the ONLY settings the ObservaOne server may change (from the UI). Everything that decides
// where data goes or what is trusted (server, ca_file, state_dir, paths, listen) can only be set on the host.
var RemoteKeys = map[string]bool{"collect_interval": true, "heartbeat_interval": true, "disable": true, "buffer_payloads": true, "env": true, "role": true}

// LoadConfig reads the main file and then every conf.d/*.yaml (and old *.conf) next to it, in name order
// (later files win).
// Precedence: defaults < server (UI) settings < host files. The host admin always has the final say.
func LoadConfig(path string) (*Config, error) {
	return LoadConfigWithRemote(path, nil)
}

func LoadConfigWithRemote(path string, remote map[string]string) (*Config, error) {
	c := Defaults()
	// server settings first: host files applied after them override them
	keys := make([]string, 0, len(remote))
	for k := range remote {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if !RemoteKeys[k] && !strings.HasPrefix(k, "label.") {
			continue // never accepted from the server, whatever it sends
		}
		if err := c.set(k, remote[k], "server"); err != nil {
			return nil, fmt.Errorf("setting %s from the server: %w", k, err)
		}
	}
	files := []string{path}
	var extra []string
	for _, pat := range []string{"*.yaml", "*.yml", "*.conf"} {
		m, _ := filepath.Glob(filepath.Join(filepath.Dir(path), "conf.d", pat))
		extra = append(extra, m...)
	}
	sort.Slice(extra, func(i, j int) bool { return filepath.Base(extra[i]) < filepath.Base(extra[j]) })
	files = append(files, extra...)
	for i, f := range files {
		if err := c.readFile(f, i == 0); err != nil {
			return nil, err
		}
	}
	return c, c.Validate()
}

func (c *Config) readFile(path string, required bool) error {
	if !IsLegacyPath(path) {
		return c.readYAML(path, required)
	}
	f, err := os.Open(path)
	if err != nil {
		if !required && os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("cannot read config %s: %w", path, err)
	}
	defer f.Close()
	c.LegacyFiles = append(c.LegacyFiles, path)
	sc := bufio.NewScanner(f)
	n := 0
	for sc.Scan() {
		n++
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			return fmt.Errorf("%s line %d: expected key = value", path, n)
		}
		k, v = strings.TrimSpace(k), strings.Trim(strings.TrimSpace(v), `"'`)
		if err := c.set(k, v, path); err != nil {
			return fmt.Errorf("%s line %d: %w", path, n, err)
		}
	}
	return sc.Err()
}

// ReadOne applies a single file on top of c (no conf.d, no validation). Used by config migrate.
func (c *Config) ReadOne(path string) error { return c.readFile(path, true) }

func (c *Config) readYAML(path string, required bool) error {
	b, err := os.ReadFile(path)
	if err != nil {
		if !required && os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("cannot read config %s: %w", path, err)
	}
	kvs, err := parseYAMLFlat(string(b))
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	for _, kv := range kvs {
		k := kv.Key
		switch {
		case strings.HasPrefix(k, "labels."):
			k = "label." + strings.TrimPrefix(k, "labels.")
		case k == "labels" && kv.Value == "":
			continue // "labels:" with nothing under it
		case k == "label" || strings.HasPrefix(k, "label."):
			return fmt.Errorf("%s line %d: use a labels: section in agent.yaml", path, kv.Line)
		}
		if err := c.set(k, kv.Value, path); err != nil {
			return fmt.Errorf("%s line %d: %w", path, kv.Line, err)
		}
	}
	return nil
}

func (c *Config) set(k, v, src string) error {
	var err error
	switch {
	case k == "server":
		c.Server = strings.TrimRight(v, "/")
	case k == "ca_file":
		c.CAFile = v
	case k == "env":
		c.Env = v
	case k == "role":
		c.Role = v
	case k == "hostname":
		c.Hostname = v
	case k == "state_dir":
		c.StateDir = v
	case k == "proc_path":
		c.ProcPath = v
	case k == "sys_path":
		c.SysPath = v
	case k == "root_path":
		c.RootPath = v
	case k == "listen":
		c.Listen = v
	case k == "collect_interval":
		c.CollectInterval, err = time.ParseDuration(v)
	case k == "heartbeat_interval":
		c.HeartbeatInterval, err = time.ParseDuration(v)
	case k == "buffer_payloads":
		c.BufferPayloads, err = strconv.Atoi(v)
	case k == "config_version":
		c.Version, err = strconv.Atoi(v)
	case k == "disable":
		c.Disabled = map[string]bool{}
		for _, d := range strings.Split(v, ",") {
			if d = strings.TrimSpace(d); d != "" {
				c.Disabled[d] = true
			}
		}
	case k == "mode":
		c.Mode = v
	case k == "pull" && v == "":
		return nil // "pull:" with nothing under it
	case k == "pull.listen":
		c.PullListen = v
	case k == "pull.advertise":
		c.PullAdvertise = v
	case k == "pull.allow":
		c.PullAllow = nil
		for _, a := range strings.Split(v, ",") {
			if a = strings.TrimSpace(a); a == "" {
				continue
			}
			if !strings.Contains(a, "/") {
				if ip := net.ParseIP(a); ip != nil && ip.To4() != nil {
					a += "/32"
				} else {
					a += "/128"
				}
			}
			_, n, perr := net.ParseCIDR(a)
			if perr != nil {
				return fmt.Errorf("pull.allow: %q is not an address or CIDR", a)
			}
			c.PullAllow = append(c.PullAllow, n)
		}
	case strings.HasPrefix(k, "label."):
		c.Labels[strings.TrimPrefix(k, "label.")] = v
	default:
		return fmt.Errorf("unknown setting %q", k)
	}
	if err != nil {
		return fmt.Errorf("%s: %w", k, err)
	}
	c.Sources[k] = src
	return nil
}

// Effective lists every setting with its value and where it came from ("default", "server" or a file).
func (c *Config) Effective() [][3]string {
	src := func(k string) string {
		if s, ok := c.Sources[k]; ok {
			return s
		}
		return "default"
	}
	dis := make([]string, 0, len(c.Disabled))
	for k := range c.Disabled {
		dis = append(dis, k)
	}
	sort.Strings(dis)
	out := [][3]string{
		{"server", c.Server, src("server")}, {"ca_file", c.CAFile, src("ca_file")},
		{"env", c.Env, src("env")}, {"role", c.Role, src("role")}, {"hostname", c.Hostname, src("hostname")},
		{"collect_interval", c.CollectInterval.String(), src("collect_interval")},
		{"heartbeat_interval", c.HeartbeatInterval.String(), src("heartbeat_interval")},
		{"buffer_payloads", strconv.Itoa(c.BufferPayloads), src("buffer_payloads")},
		{"disable", strings.Join(dis, ","), src("disable")}, {"listen", c.Listen, src("listen")},
		{"state_dir", c.StateDir, src("state_dir")}, {"proc_path", c.ProcPath, src("proc_path")},
		{"sys_path", c.SysPath, src("sys_path")}, {"root_path", c.RootPath, src("root_path")},
		{"mode", c.Mode, src("mode")}, {"pull.listen", c.PullListen, src("pull.listen")},
		{"pull.advertise", c.PullAdvertise, src("pull.advertise")}, {"pull.allow", c.pullAllowString(), src("pull.allow")},
	}
	lk := make([]string, 0, len(c.Labels))
	for k := range c.Labels {
		lk = append(lk, k)
	}
	sort.Strings(lk)
	for _, k := range lk {
		out = append(out, [3]string{"label." + k, c.Labels[k], src("label." + k)})
	}
	return out
}

// HostLocked reports which remote-changeable settings the host files pin (the UI shows them as "set on host").
func (c *Config) HostLocked() []string {
	var out []string
	for k, s := range c.Sources {
		if (RemoteKeys[k] || strings.HasPrefix(k, "label.")) && s != "server" {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

// Validate refuses settings that would make the agent unsafe or useless, with a clear message.
func (c *Config) Validate() error {
	if c.Version > ConfigVersion {
		return fmt.Errorf("config_version %d is newer than this agent understands (%d): upgrade the agent", c.Version, ConfigVersion)
	}
	if c.Server == "" {
		return fmt.Errorf("server is required, e.g. server: https://observaone.example.com")
	}
	u, err := url.Parse(c.Server)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return fmt.Errorf("server must be an https:// address (got %q); plain http is not allowed", c.Server)
	}
	if h := u.Hostname(); h == "localhost" || strings.HasPrefix(h, "127.") || h == "::1" {
		return fmt.Errorf("server %q points at this machine itself; use the address of the ObservaOne server", c.Server)
	}
	if c.CAFile != "" {
		if _, err := os.Stat(c.CAFile); err != nil {
			return fmt.Errorf("ca_file %s: %w", c.CAFile, err)
		}
	}
	for _, v := range []string{c.Env, c.Role} {
		if !labelValRE.MatchString(v) {
			return fmt.Errorf("env/role %q: only letters, digits, . _ - (max 64)", v)
		}
	}
	if len(c.Labels) > 10 {
		return fmt.Errorf("at most 10 label.* settings")
	}
	for k, v := range c.Labels {
		if !labelKeyRE.MatchString(k) || reserved[k] {
			return fmt.Errorf("label.%s: name not allowed", k)
		}
		if !labelValRE.MatchString(v) {
			return fmt.Errorf("label.%s: value %q not allowed (letters, digits, . _ -, max 64)", k, v)
		}
	}
	if c.CollectInterval < 5*time.Second || c.CollectInterval > 5*time.Minute {
		return fmt.Errorf("collect_interval must be between 5s and 5m")
	}
	if c.HeartbeatInterval < 5*time.Second || c.HeartbeatInterval > 5*time.Minute {
		return fmt.Errorf("heartbeat_interval must be between 5s and 5m")
	}
	if c.BufferPayloads < 1 || c.BufferPayloads > 1000 {
		return fmt.Errorf("buffer_payloads must be 1..1000")
	}
	if c.Listen != "" {
		host, _, err := net.SplitHostPort(c.Listen)
		if err != nil {
			return fmt.Errorf("listen %q: %w", c.Listen, err)
		}
		if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
			return fmt.Errorf("listen must be a loopback address (e.g. 127.0.0.1:9109); host metrics are not exposed to the network (use mode: pull for Prometheus scrapes)")
		}
	}
	switch c.Mode {
	case "push":
	case "pull":
		if _, port, err := net.SplitHostPort(c.PullListen); err != nil || port == "" || port == "0" {
			return fmt.Errorf("pull.listen %q: expected host:port, e.g. \":9110\" or \"10.0.0.5:9110\"", c.PullListen)
		}
		if c.Listen != "" && c.Listen == c.PullListen {
			return fmt.Errorf("pull.listen and listen cannot be the same address")
		}
		if a := c.PullAdvertise; a != "" {
			h := a
			if hh, _, err := net.SplitHostPort(a); err == nil {
				h = hh
			}
			if h == "" || strings.ContainsAny(h, "/ ") {
				return fmt.Errorf("pull.advertise %q: expected a host name or IP, optionally with :port", a)
			}
		}
	default:
		return fmt.Errorf("mode must be push or pull (got %q)", c.Mode)
	}
	return nil
}

func (c *Config) pullAllowString() string {
	var s []string
	for _, n := range c.PullAllow {
		s = append(s, n.String())
	}
	return strings.Join(s, ",")
}

// PullAllowed reports whether a pull connection from ip is allowed.
func (c *Config) PullAllowed(ip net.IP) bool {
	if len(c.PullAllow) == 0 {
		return true
	}
	for _, n := range c.PullAllow {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// HostYAML renders the settings made in host files (not defaults, not server settings) as agent.yaml.
// Used by "observaone-agent config migrate" to turn an old agent.conf into agent.yaml.
func (c *Config) HostYAML() string {
	var b strings.Builder
	b.WriteString("# ObservaOne Agent configuration (migrated from agent.conf). Edit freely; the installer keeps your changes.\n")
	b.WriteString("# After a change:  sudo observaone-agent check-config && sudo systemctl reload observaone-agent\n")
	b.WriteString("config_version: 2\n")
	host := func(k string) bool { s, ok := c.Sources[k]; return ok && s != "server" }
	order := []string{"server", "ca_file", "hostname", "env", "role", "mode", "collect_interval", "heartbeat_interval",
		"buffer_payloads", "listen", "state_dir", "proc_path", "sys_path", "root_path"}
	vals := map[string]string{}
	for _, r := range c.Effective() {
		vals[r[0]] = r[1]
	}
	for _, k := range order {
		if host(k) {
			fmt.Fprintf(&b, "%s: %s\n", k, yamlQuote(vals[k]))
		}
	}
	if host("disable") {
		fmt.Fprintf(&b, "disable: [%s]\n", strings.Join(strings.Split(vals["disable"], ","), ", "))
	}
	var lk []string
	for k := range c.Labels {
		if host("label." + k) {
			lk = append(lk, k)
		}
	}
	sort.Strings(lk)
	if len(lk) > 0 {
		b.WriteString("labels:\n")
		for _, k := range lk {
			fmt.Fprintf(&b, "  %s: %s\n", k, yamlQuote(c.Labels[k]))
		}
	}
	if host("pull.listen") || host("pull.advertise") || host("pull.allow") {
		b.WriteString("pull:\n")
		for _, k := range []string{"listen", "advertise"} {
			if host("pull." + k) {
				fmt.Fprintf(&b, "  %s: %s\n", k, yamlQuote(vals["pull."+k]))
			}
		}
		if host("pull.allow") {
			fmt.Fprintf(&b, "  allow: [%s]\n", strings.Join(strings.Split(vals["pull.allow"], ","), ", "))
		}
	}
	return b.String()
}
