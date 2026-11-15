package linux

import (
	"fmt"
	"os"
	"runtime"
	"strings"

	"observaone/agent/internal/collector"
	"observaone/agent/internal/core"
)

// Load: 1, 5 and 15 minute load averages.
type Load struct{}

func (Load) Name() string { return "load" }

func (Load) Collect(env *collector.Env, b *core.Batch) error {
	data, err := readFile(env, env.Proc, "loadavg")
	if err != nil {
		return err
	}
	f := strings.Fields(string(data))
	if len(f) < 3 {
		return fmt.Errorf("/proc/loadavg: unexpected format")
	}
	for i, n := range []string{"node_load1", "node_load5", "node_load15"} {
		v, err := parseFloat(f[i])
		if err != nil || v < 0 {
			return fmt.Errorf("/proc/loadavg: %v", err)
		}
		b.Add(n, core.Gauge, strings.TrimPrefix(n, "node_")+" load average.", v)
	}
	return nil
}

// Uptime: seconds since boot (resets on reboot) and the current time.
type Uptime struct{}

func (Uptime) Name() string { return "uptime" }

func (Uptime) Collect(env *collector.Env, b *core.Batch) error {
	data, err := readFile(env, env.Proc, "uptime")
	if err != nil {
		return err
	}
	f := strings.Fields(string(data))
	if len(f) < 1 {
		return fmt.Errorf("/proc/uptime: unexpected format")
	}
	up, err := parseFloat(f[0])
	if err != nil || up < 0 {
		return fmt.Errorf("/proc/uptime: %v", err)
	}
	b.Add("observaone_uptime_seconds", core.Gauge, "Seconds since the host booted.", up)
	b.Add("node_time_seconds", core.Gauge, "System time in seconds since epoch (1970).", float64(env.Now.UnixMilli())/1000)
	return nil
}

// System: OS, kernel and architecture as info series (value 1, one series per host).
type System struct{}

func (System) Name() string { return "system" }

func (System) Collect(env *collector.Env, b *core.Batch) error {
	rel, _ := readFile(env, env.Proc, "sys/kernel/osrelease")
	host, _ := readFile(env, env.Proc, "sys/kernel/hostname")
	b.Add("node_uname_info", core.Gauge, "Labeled system information as provided by the uname system call.", 1,
		"sysname", "Linux", "release", strings.TrimSpace(string(rel)), "machine", archName(), "nodename", strings.TrimSpace(string(host)))
	osr, err := readFile(env, env.Root, "etc/os-release")
	if err != nil {
		osr, err = readFile(env, env.Root, "usr/lib/os-release")
	}
	if err != nil {
		env.Note("system: os-release not readable; OS name unknown")
		return nil
	}
	kv := map[string]string{}
	for _, ln := range lines(osr) {
		if k, v, ok := strings.Cut(ln, "="); ok {
			kv[k] = trimQuotes(v)
		}
	}
	b.Add("node_os_info", core.Gauge, "A metric with a constant '1' value labeled by build_id, id, name, pretty_name, version, version_codename, version_id.", 1,
		"id", kv["ID"], "name", kv["NAME"], "pretty_name", kv["PRETTY_NAME"], "version_id", kv["VERSION_ID"], "version_codename", kv["VERSION_CODENAME"])
	return nil
}

func archName() string {
	switch runtime.GOARCH {
	case "amd64":
		return "x86_64"
	case "arm64":
		return "aarch64"
	}
	return runtime.GOARCH
}

// OSInfo is used at enrollment: pretty OS name and kernel release.
func OSInfo(proc, root string) (pretty, kernel string) {
	if b, err := os.ReadFile(root + "/etc/os-release"); err == nil {
		for _, ln := range lines(b) {
			if k, v, ok := strings.Cut(ln, "="); ok && k == "PRETTY_NAME" {
				pretty = trimQuotes(v)
			}
		}
	}
	if b, err := os.ReadFile(proc + "/sys/kernel/osrelease"); err == nil {
		kernel = strings.TrimSpace(string(b))
	}
	if pretty == "" {
		pretty = "Linux"
	}
	return
}

// Self: the agent's own health, so you can see it stays light.
type Self struct{}

func (Self) Name() string { return "agent" }

func (Self) Collect(env *collector.Env, b *core.Batch) error {
	b.Add("observaone_agent_info", core.Gauge, "ObservaOne agent build information.", 1, "version", env.Version, "goversion", runtime.Version())
	if st, err := readFile(env, "/proc", "self/statm"); err == nil {
		f := strings.Fields(string(st))
		if len(f) >= 2 {
			if pages, err := parseUint(f[1]); err == nil {
				b.Add("process_resident_memory_bytes", core.Gauge, "Resident memory size in bytes.", pages*float64(os.Getpagesize()))
			}
		}
	}
	if st, err := readFile(env, "/proc", "self/stat"); err == nil {
		// fields after the ")" of the command name; utime and stime are fields 14 and 15
		s := string(st)
		if i := strings.LastIndexByte(s, ')'); i > 0 {
			f := strings.Fields(s[i+1:])
			if len(f) > 13 {
				u, e1 := parseUint(f[11])
				k, e2 := parseUint(f[12])
				if e1 == nil && e2 == nil {
					b.Add("process_cpu_seconds_total", core.Counter, "Total user and system CPU time spent in seconds.", (u+k)/userHZ)
				}
			}
		}
	}
	b.Add("go_goroutines", core.Gauge, "Number of goroutines that currently exist.", float64(runtime.NumGoroutine()))
	return nil
}
