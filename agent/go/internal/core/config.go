package core

import (
	"bufio"
	"fmt"
	"net"
	"net/url"
	"os"
	"regexp"
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
}

var labelValRE = regexp.MustCompile(`^[A-Za-z0-9._-]{0,64}$`)
var labelKeyRE = regexp.MustCompile(`^[a-z][a-z0-9_]{0,30}$`)
var reserved = map[string]bool{"host": true, "job": true, "instance": true, "agent": true, "agent_id": true, "os": true, "platform": true, "env": true, "role": true, "cluster": true}

func LoadConfig(path string) (*Config, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("cannot read config %s: %w", path, err)
	}
	defer f.Close()
	c := &Config{Labels: map[string]string{}, Disabled: map[string]bool{}, StateDir: "/var/lib/observaone-agent",
		CollectInterval: 15 * time.Second, HeartbeatInterval: 30 * time.Second, BufferPayloads: 40, Version: 1}
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
			return nil, fmt.Errorf("%s line %d: expected key = value", path, n)
		}
		k, v = strings.TrimSpace(k), strings.Trim(strings.TrimSpace(v), `"'`)
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
			for _, d := range strings.Split(v, ",") {
				if d = strings.TrimSpace(d); d != "" {
					c.Disabled[d] = true
				}
			}
		case strings.HasPrefix(k, "label."):
			c.Labels[strings.TrimPrefix(k, "label.")] = v
		default:
			return nil, fmt.Errorf("%s line %d: unknown setting %q", path, n, k)
		}
		if err != nil {
			return nil, fmt.Errorf("%s line %d: %s: %w", path, n, k, err)
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return c, c.Validate()
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
