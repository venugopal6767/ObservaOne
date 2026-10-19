// Package linux collects host metrics from /proc and /sys. Metric names follow node_exporter, so the
// existing ObservaOne dashboards, Overview and Infrastructure work unchanged. Extra series computed by
// the agent itself (rates, ratios) are prefixed observaone_.
package linux

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"observaone/agent/internal/collector"
)

// All returns the Linux collectors in a stable order.
func All() []collector.Collector {
	return []collector.Collector{
		&CPU{}, &Memory{}, &Load{}, &Uptime{}, &Filesystem{}, &Disk{}, &Network{}, &System{}, &Self{},
		&Processes{}, Docker{}, Nginx{}, JVM{}, Exporters{},
	}
}

func readFile(env *collector.Env, base, rel string) ([]byte, error) {
	b, err := os.ReadFile(filepath.Join(base, rel))
	if err != nil {
		return nil, err
	}
	return b, nil
}

func lines(b []byte) []string {
	var out []string
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		out = append(out, sc.Text())
	}
	return out
}

// parseUint reads a non-negative counter; bad input is an error, never 0.
func parseUint(s string) (float64, error) {
	v, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("bad number %q", s)
	}
	return float64(v), nil
}

func parseFloat(s string) (float64, error) {
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, fmt.Errorf("bad number %q", s)
	}
	return v, nil
}

func trimQuotes(s string) string { return strings.Trim(strings.TrimSpace(s), `"'`) }
