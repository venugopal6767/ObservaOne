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

// ConfigVersion is the agent.conf format this agent understands. A file with a newer version is refused
// (an old agent must not half-understand a new configuration).
const ConfigVersion = 1

// Config comes from /etc/observaone-agent/agent.conf: "key = value" lines, "#" comments.
// Secrets are never in this file: the enrollment token and the agent credential are separate files
// readable only by the agent's own user.
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
}

var labelValRE = regexp.MustCompile(`^[A-Za-z0-9._-]{0,64}$`)
var labelKeyRE = regexp.MustCompile(`^[a-z][a-z0-9_]{0,30}$`)
var reserved = map[string]bool{"host": true, "job": true, "instance": true, "agent": true, "agent_id": true, "os": true, "platform": true, "env": true, "role": true, "cluster": true}

// Defaults: what the agent uses when nothing else says otherwise.
func Defaults() *Config {
	return &Config{Labels: map[string]string{}, Disabled: map[string]bool{}, StateDir: "/var/lib/observaone-agent",
		CollectInterval: 15 * time.Second, HeartbeatInterval: 30 * time.Second, BufferPayloads: 40, Version: 1,
		ProcPath: "/proc", SysPath: "/sys", RootPath: "/", Sources: map[string]string{}}
}

// RemoteKeys are the ONLY settings the ObservaOne server may change (from the UI). Everything that decides
// where data goes or what is trusted (server, ca_file, state_dir, paths, listen) can only be set on the host.
var RemoteKeys = map[string]bool{"collect_interval": true, "heartbeat_interval": true, "disable": true, "buffer_payloads": true, "env": true, "role": true}

// LoadConfig reads the main file and then every conf.d/*.conf next to it, in name order (later files win).
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
	extra, _ := filepath.Glob(filepath.Join(filepath.Dir(path), "conf.d", "*.conf"))
	sort.Strings(extra)
	files = append(files, extra...)
	for i, f := range files {
		if err := c.readFile(f, i == 0); err != nil {
			return nil, err
		}
	}
	return c, c.Validate()
}

func (c *Config) readFile(path string, required bool) error {
	f, err := os.Open(path)
	if err != nil {
		if !required && os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("cannot read config %s: %w", path, err)
	}
	defer f.Close()
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
		return fmt.Errorf("server is required, e.g. server = https://observaone.example.com")
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
			return fmt.Errorf("listen must be a loopback address (e.g. 127.0.0.1:9109); host metrics are not exposed to the network")
		}
	}
	return nil
}
