package linux

import (
	"fmt"
	"math"
	"strings"
	"sync"

	"observaone/agent/internal/collector"
	"observaone/agent/internal/core"
)

// USER_HZ: /proc/stat counts in 1/100 s on every Linux architecture the agent supports.
const userHZ = 100.0

var cpuModes = []string{"user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal"}

// CPU: per-core time counters (node_cpu_seconds_total), boot time, and the agent's own
// utilisation ratio computed from deltas (observaone_cpu_utilization_ratio).
type CPU struct {
	mu       sync.Mutex
	lastBoot float64
}

func (c *CPU) Name() string { return "cpu" }

func (c *CPU) Collect(env *collector.Env, b *core.Batch) error {
	data, err := readFile(env, env.Proc, "stat")
	if err != nil {
		return err
	}
	cores := 0
	var total, idle float64
	haveTotal := false
	for _, ln := range lines(data) {
		f := strings.Fields(ln)
		if len(f) == 0 {
			continue
		}
		switch {
		case f[0] == "cpu" && len(f) >= 5:
			total, idle, haveTotal = 0, 0, true
			for i := 1; i < len(f) && i <= 8; i++ {
				v, err := parseUint(f[i])
				if err != nil {
					return fmt.Errorf("/proc/stat cpu: %w", err)
				}
				total += v
				if i == 4 || i == 5 { // idle + iowait
					idle += v
				}
			}
		case strings.HasPrefix(f[0], "cpu") && len(f) >= 5:
			cpu := strings.TrimPrefix(f[0], "cpu")
			cores++
			for i, mode := range cpuModes {
				if i+1 >= len(f) {
					break // older kernels have fewer columns: those modes are simply not reported
				}
				v, err := parseUint(f[i+1])
				if err != nil {
					return fmt.Errorf("/proc/stat %s: %w", f[0], err)
				}
				b.Add("node_cpu_seconds_total", core.Counter, "Seconds the CPUs spent in each mode.", v/userHZ, "cpu", cpu, "mode", mode)
			}
		case f[0] == "btime" && len(f) == 2:
			bt, err := parseUint(f[1])
			if err != nil {
				return err
			}
			c.mu.Lock()
			// Reboot: every counter starts again from 0. Forget old values so no false rate is computed.
			if c.lastBoot != 0 && math.Abs(bt-c.lastBoot) > 5 {
				env.Rates.Reset()
				env.Note("reboot detected: rates restarted")
			}
			c.lastBoot = bt
			c.mu.Unlock()
			b.Add("node_boot_time_seconds", core.Gauge, "Node boot time, in unixtime.", bt)
		case f[0] == "ctxt" && len(f) == 2:
			if v, err := parseUint(f[1]); err == nil {
				b.Add("node_context_switches_total", core.Counter, "Total number of context switches.", v)
			}
		case f[0] == "procs_running" && len(f) == 2:
			if v, err := parseUint(f[1]); err == nil {
				b.Add("node_procs_running", core.Gauge, "Number of processes in runnable state.", v)
			}
		}
	}
	if cores == 0 || !haveTotal {
		return fmt.Errorf("/proc/stat has no cpu lines")
	}
	b.Add("observaone_cpu_count", core.Gauge, "Number of logical CPUs.", float64(cores))
	// utilisation from deltas: busy share of all CPU time since the last round
	if t, ok := env.Rates.Rate("cpu.total", total, env.Now); ok && t > 0 {
		if i, ok2 := env.Rates.Rate("cpu.idle", idle, env.Now); ok2 {
			r := 1 - i/t
			if r >= 0 && r <= 1 {
				b.Add("observaone_cpu_utilization_ratio", core.Gauge, "Share of CPU time not idle since the previous collection (0-1).", r)
			}
		}
	} else {
		env.Rates.Rate("cpu.idle", idle, env.Now) // keep both series aligned
	}
	return nil
}
