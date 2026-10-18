package linux

import (
	"fmt"
	"strings"

	"observaone/agent/internal/collector"
	"observaone/agent/internal/core"
)

// Fields of /proc/meminfo that are exported (as node_memory_<Field>_bytes). A field the kernel does not
// have (MemAvailable before Linux 3.14, for example) is left out, never sent as 0.
var memFields = []string{"MemTotal", "MemFree", "MemAvailable", "Buffers", "Cached", "SwapTotal", "SwapFree",
	"Shmem", "SReclaimable", "Dirty", "Active", "Inactive"}

type Memory struct{}

func (Memory) Name() string { return "memory" }

func (Memory) Collect(env *collector.Env, b *core.Batch) error {
	data, err := readFile(env, env.Proc, "meminfo")
	if err != nil {
		return err
	}
	vals := map[string]float64{}
	for _, ln := range lines(data) {
		k, rest, ok := strings.Cut(ln, ":")
		if !ok {
			continue
		}
		f := strings.Fields(rest)
		if len(f) == 0 {
			continue
		}
		v, err := parseUint(f[0])
		if err != nil {
			continue // one odd line does not invalidate the rest
		}
		if len(f) > 1 && f[1] == "kB" {
			v *= 1024
		}
		vals[k] = v
	}
	total, ok := vals["MemTotal"]
	if !ok || total <= 0 {
		return fmt.Errorf("/proc/meminfo has no MemTotal")
	}
	for _, k := range memFields {
		if v, ok := vals[k]; ok {
			b.Add("node_memory_"+k+"_bytes", core.Gauge, "Memory information field "+k+"_bytes.", v)
		}
	}
	if avail, ok := vals["MemAvailable"]; ok && avail <= total {
		used := total - avail
		b.Add("observaone_memory_used_bytes", core.Gauge, "Memory in use (MemTotal - MemAvailable).", used)
		b.Add("observaone_memory_utilization_ratio", core.Gauge, "Share of memory in use (0-1).", used/total)
	} else {
		env.Note("memory: MemAvailable not reported by this kernel; used/utilisation not computed")
	}
	return nil
}
