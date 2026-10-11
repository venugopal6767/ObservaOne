package linux

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"observaone/agent/internal/collector"
	"observaone/agent/internal/core"
)

const sector = 512.0 // /proc/diskstats always counts 512-byte sectors

var skipDisks = regexp.MustCompile(`^(ram|loop|fd|sr|zram)\d*$`)

const maxDisks, maxIfaces = 64, 32

// Disk: I/O counters per whole disk (partitions are left out to avoid double counting) and per-second
// rates computed by the agent from counter deltas.
type Disk struct{}

func (Disk) Name() string { return "disk" }

func (Disk) Collect(env *collector.Env, b *core.Batch) error {
	data, err := readFile(env, env.Proc, "diskstats")
	if err != nil {
		return err
	}
	n := 0
	for _, ln := range lines(data) {
		f := strings.Fields(ln)
		if len(f) < 14 {
			continue
		}
		dev := f[2]
		if skipDisks.MatchString(dev) {
			continue
		}
		// whole disks have /sys/block/<dev>; partitions do not
		if _, err := os.Stat(filepath.Join(env.Sys, "block", strings.ReplaceAll(dev, "/", "!"))); err != nil {
			continue
		}
		if n++; n > maxDisks {
			env.Note(fmt.Sprintf("disk: more than %d devices, the rest are skipped", maxDisks))
			break
		}
		v := make([]float64, 11)
		bad := false
		for i := 0; i < 11; i++ {
			x, err := parseUint(f[3+i])
			if err != nil {
				bad = true
				break
			}
			v[i] = x
		}
		if bad {
			env.Note("disk " + dev + ": unreadable counters")
			continue
		}
		l := []string{"device", dev}
		b.Add("node_disk_reads_completed_total", core.Counter, "The total number of reads completed successfully.", v[0], l...)
		b.Add("node_disk_read_bytes_total", core.Counter, "The total number of bytes read successfully.", v[2]*sector, l...)
		b.Add("node_disk_read_time_seconds_total", core.Counter, "The total number of seconds spent by all reads.", v[3]/1000, l...)
		b.Add("node_disk_writes_completed_total", core.Counter, "The total number of writes completed successfully.", v[4], l...)
		b.Add("node_disk_written_bytes_total", core.Counter, "The total number of bytes written successfully.", v[6]*sector, l...)
		b.Add("node_disk_write_time_seconds_total", core.Counter, "This is the total number of seconds spent by all writes.", v[7]/1000, l...)
		b.Add("node_disk_io_now", core.Gauge, "The number of I/Os currently in progress.", v[8], l...)
		b.Add("node_disk_io_time_seconds_total", core.Counter, "Total seconds spent doing I/Os.", v[9]/1000, l...)
		rate(env, b, "disk.r."+dev, v[2]*sector, "observaone_disk_read_bytes_per_second", "Bytes read per second since the previous collection.", l)
		rate(env, b, "disk.w."+dev, v[6]*sector, "observaone_disk_write_bytes_per_second", "Bytes written per second since the previous collection.", l)
		rate(env, b, "disk.rio."+dev, v[0], "observaone_disk_reads_per_second", "Reads completed per second.", l)
		rate(env, b, "disk.wio."+dev, v[4], "observaone_disk_writes_per_second", "Writes completed per second.", l)
		if r, ok := env.Rates.Rate("disk.busy."+dev, v[9]/1000, env.Now); ok && r <= 1.05 {
			b.Add("observaone_disk_busy_ratio", core.Gauge, "Share of time the disk was busy (0-1).", min(r, 1), l...)
		}
	}
	return nil
}

// Virtual interfaces of containers and bridges would add one series per container: left out.
var skipIfaces = regexp.MustCompile(`^(lo|veth.*|docker.*|br-.*|virbr.*|cni.*|flannel.*|cali.*|vxlan.*|kube-.*|lxc.*|tunl.*|genev.*)$`)

// Network: byte, packet, error and drop counters per physical/real interface, plus rates.
type Network struct{}

func (Network) Name() string { return "network" }

func (Network) Collect(env *collector.Env, b *core.Batch) error {
	data, err := readFile(env, env.Proc, "net/dev")
	if err != nil {
		return err
	}
	n := 0
	for _, ln := range lines(data) {
		name, rest, ok := strings.Cut(ln, ":")
		if !ok {
			continue
		}
		dev := strings.TrimSpace(name)
		if skipIfaces.MatchString(dev) {
			continue
		}
		f := strings.Fields(rest)
		if len(f) < 16 {
			continue
		}
		if n++; n > maxIfaces {
			env.Note(fmt.Sprintf("network: more than %d interfaces, the rest are skipped", maxIfaces))
			break
		}
		v := make([]float64, 16)
		bad := false
		for i := range v {
			x, err := parseUint(f[i])
			if err != nil {
				bad = true
				break
			}
			v[i] = x
		}
		if bad {
			continue
		}
		l := []string{"device", dev}
		b.Add("node_network_receive_bytes_total", core.Counter, "Network device statistic receive_bytes.", v[0], l...)
		b.Add("node_network_receive_packets_total", core.Counter, "Network device statistic receive_packets.", v[1], l...)
		b.Add("node_network_receive_errs_total", core.Counter, "Network device statistic receive_errs.", v[2], l...)
		b.Add("node_network_receive_drop_total", core.Counter, "Network device statistic receive_drop.", v[3], l...)
		b.Add("node_network_transmit_bytes_total", core.Counter, "Network device statistic transmit_bytes.", v[8], l...)
		b.Add("node_network_transmit_packets_total", core.Counter, "Network device statistic transmit_packets.", v[9], l...)
		b.Add("node_network_transmit_errs_total", core.Counter, "Network device statistic transmit_errs.", v[10], l...)
		b.Add("node_network_transmit_drop_total", core.Counter, "Network device statistic transmit_drop.", v[11], l...)
		rate(env, b, "net.rx."+dev, v[0], "observaone_network_receive_bytes_per_second", "Bytes received per second since the previous collection.", l)
		rate(env, b, "net.tx."+dev, v[8], "observaone_network_transmit_bytes_per_second", "Bytes sent per second since the previous collection.", l)
		if st, err := os.ReadFile(filepath.Join(env.Sys, "class/net", dev, "operstate")); err == nil {
			up := 0.0
			if strings.TrimSpace(string(st)) == "up" {
				up = 1
			}
			b.Add("node_network_up", core.Gauge, "Value is 1 if operstate is 'up', 0 otherwise.", up, l...)
		}
	}
	return nil
}

// rate adds a per-second gauge when a valid rate exists (not on the first round, not after a reset).
func rate(env *collector.Env, b *core.Batch, key string, v float64, name, help string, labels []string) {
	if r, ok := env.Rates.Rate(key, v, env.Now); ok {
		b.Add(name, core.Gauge, help, r, labels...)
	}
}
