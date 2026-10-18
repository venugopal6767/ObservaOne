package linux

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"observaone/agent/internal/collector"
	"observaone/agent/internal/core"
)

func fakeEnv(t *testing.T, files map[string]string) *collector.Env {
	t.Helper()
	root := t.TempDir()
	for p, c := range files {
		full := filepath.Join(root, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return &collector.Env{Proc: filepath.Join(root, "proc"), Sys: filepath.Join(root, "sys"), Root: root, Rates: core.NewRates(), Now: time.Unix(1_800_000_000, 0), Version: "test"}
}

func run(t *testing.T, c collector.Collector, env *collector.Env) (string, error) {
	b := core.NewBatch()
	err := c.Collect(env, b)
	if b.Dropped != 0 {
		t.Fatalf("%s produced %d invalid samples", c.Name(), b.Dropped)
	}
	return b.Text(0), err
}

const stat1 = "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 100 0 100 800 0 0 0 0 0 0\nbtime 1700000000\nctxt 5\nprocs_running 1\n"
const stat2 = "cpu  150 0 150 900 0 0 0 0 0 0\ncpu0 150 0 150 900 0 0 0 0 0 0\nbtime 1700000000\nctxt 9\nprocs_running 1\n"

func TestCPUUtilisationFromDeltas(t *testing.T) {
	env := fakeEnv(t, map[string]string{"proc/stat": stat1})
	c := &CPU{}
	out, err := run(t, c, env)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "observaone_cpu_utilization_ratio") {
		t.Fatal("first round must not invent a utilisation (no previous sample)")
	}
	if !strings.Contains(out, `node_cpu_seconds_total{cpu="0",mode="idle"} 8`) {
		t.Fatalf("idle counter missing:\n%s", out)
	}
	os.WriteFile(filepath.Join(env.Proc, "stat"), []byte(stat2), 0o644)
	env.Now = env.Now.Add(15 * time.Second)
	out, _ = run(t, c, env)
	// delta: total 200, idle 100 -> 50% busy
	if !strings.Contains(out, "observaone_cpu_utilization_ratio 0.5\n") {
		t.Fatalf("want 0.5 utilisation:\n%s", out)
	}
}

func TestCPUCounterResetAndRebootGiveNoSpike(t *testing.T) {
	env := fakeEnv(t, map[string]string{"proc/stat": stat2})
	c := &CPU{}
	run(t, c, env)
	// reboot: counters back near zero and a new boot time
	os.WriteFile(filepath.Join(env.Proc, "stat"), []byte(strings.ReplaceAll(strings.ReplaceAll(stat1, "1700000000", "1700009999"), "800", "10")), 0o644)
	env.Now = env.Now.Add(15 * time.Second)
	out, err := run(t, c, env)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "observaone_cpu_utilization_ratio") {
		t.Fatalf("no utilisation may be computed across a reboot:\n%s", out)
	}
	if !strings.Contains(strings.Join(env.TakeNotes(), " "), "reboot detected") {
		t.Fatal("reboot should be noted")
	}
	if !strings.Contains(out, "node_boot_time_seconds 1.700009999e+09") {
		t.Fatalf("new boot time missing:\n%s", out)
	}
}

func TestMissingFilesAreErrorsNotZeros(t *testing.T) {
	env := fakeEnv(t, map[string]string{})
	for _, c := range []collector.Collector{&CPU{}, Memory{}, Load{}, Uptime{}, Filesystem{}, Disk{}, Network{}} {
		out, err := run(t, c, env)
		if err == nil {
			t.Fatalf("%s: missing file must be an error", c.Name())
		}
		if out != "" {
			t.Fatalf("%s: no samples may be produced on error, got:\n%s", c.Name(), out)
		}
		if st := collector.Classify(err); st.Status != "unavailable" {
			t.Fatalf("%s: missing file should classify as unavailable, got %s", c.Name(), st.Status)
		}
	}
}

func TestPermissionDeniedIsUnavailable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can read anything; permission test needs a normal user")
	}
	env := fakeEnv(t, map[string]string{"proc/meminfo": "MemTotal: 1 kB\n"})
	os.Chmod(filepath.Join(env.Proc, "meminfo"), 0)
	_, err := run(t, Memory{}, env)
	if st := collector.Classify(err); st.Status != "unavailable" {
		t.Fatalf("want unavailable, got %+v", st)
	}
}

func TestMemoryOmitsFieldsTheKernelLacks(t *testing.T) {
	env := fakeEnv(t, map[string]string{"proc/meminfo": "MemTotal:  1000 kB\nMemFree:  400 kB\n"})
	out, err := run(t, Memory{}, env)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "MemAvailable") || strings.Contains(out, "utilization") {
		t.Fatalf("MemAvailable is missing on this kernel: it must be left out, not 0:\n%s", out)
	}
	if !strings.Contains(out, "node_memory_MemTotal_bytes 1.024e+06") {
		t.Fatalf("kB must be converted to bytes:\n%s", out)
	}
}

func TestMemoryUtilisation(t *testing.T) {
	env := fakeEnv(t, map[string]string{"proc/meminfo": "MemTotal: 1000 kB\nMemAvailable: 250 kB\n"})
	out, _ := run(t, Memory{}, env)
	if !strings.Contains(out, "observaone_memory_utilization_ratio 0.75") {
		t.Fatalf("want 0.75:\n%s", out)
	}
}

func TestDiskRatesAndPartitionsAndResets(t *testing.T) {
	line := func(rs, ws string) string {
		return "   8       0 sda 10 0 " + rs + " 5 20 0 " + ws + " 7 0 100 0 0 0 0 0\n   8       1 sda1 1 0 8 1 1 0 8 1 0 1 0\n   7       0 loop0 1 0 8 1 1 0 8 1 0 1 0\n"
	}
	env := fakeEnv(t, map[string]string{"proc/diskstats": line("100", "200"), "sys/block/sda/stat": "", "sys/block/loop0/stat": ""})
	out, err := run(t, Disk{}, env)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "sda1") || strings.Contains(out, "loop0") {
		t.Fatalf("partitions and loop devices must be skipped:\n%s", out)
	}
	if !strings.Contains(out, `node_disk_read_bytes_total{device="sda"} 51200`) {
		t.Fatalf("sectors must be converted to bytes:\n%s", out)
	}
	env.Now = env.Now.Add(10 * time.Second)
	os.WriteFile(filepath.Join(env.Proc, "diskstats"), []byte(line("300", "200")), 0o644)
	out, _ = run(t, Disk{}, env)
	// (300-100) sectors * 512 / 10 s = 10240 B/s
	if !strings.Contains(out, `observaone_disk_read_bytes_per_second{device="sda"} 10240`) {
		t.Fatalf("want 10240 B/s:\n%s", out)
	}
	env.Now = env.Now.Add(10 * time.Second)
	os.WriteFile(filepath.Join(env.Proc, "diskstats"), []byte(line("4", "200")), 0o644) // counter went down
	out, _ = run(t, Disk{}, env)
	if strings.Contains(out, `observaone_disk_read_bytes_per_second{device="sda"}`) {
		t.Fatalf("a counter reset must give no rate (no spike, no negative):\n%s", out)
	}
}

func TestNetworkSkipsVirtualInterfaces(t *testing.T) {
	nd := "Inter-|   Receive  |  Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n" +
		"    lo: 9 1 0 0 0 0 0 0 9 1 0 0 0 0 0 0\n  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\nveth12ab: 5 1 0 0 0 0 0 0 5 1 0 0 0 0 0 0\n"
	env := fakeEnv(t, map[string]string{"proc/net/dev": nd, "sys/class/net/eth0/operstate": "up\n"})
	out, err := run(t, Network{}, env)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, `"lo"`) || strings.Contains(out, "veth") {
		t.Fatalf("lo and container interfaces must be skipped:\n%s", out)
	}
	if !strings.Contains(out, `node_network_transmit_bytes_total{device="eth0"} 2000`) || !strings.Contains(out, `node_network_up{device="eth0"} 1`) {
		t.Fatalf("eth0 counters missing:\n%s", out)
	}
}

func TestFilesystemSkipsPseudoAndHandlesBadMount(t *testing.T) {
	root := t.TempDir()
	mounts := "proc /proc proc rw 0 0\ntmpfs /run tmpfs rw 0 0\n/dev/sda1 / ext4 rw 0 0\n/dev/sdz /does-not-exist ext4 ro 0 0\nfoo /mnt/x fuse.sshfs rw 0 0\n"
	env := fakeEnv(t, map[string]string{"proc/self/mounts": mounts})
	env.Root = root // "/" -> the temp dir (exists), /does-not-exist does not
	out, err := run(t, Filesystem{}, env)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "tmpfs") || strings.Contains(out, `fstype="proc"`) || strings.Contains(out, "fuse") {
		t.Fatalf("pseudo/fuse filesystems must be skipped:\n%s", out)
	}
	if !strings.Contains(out, `node_filesystem_size_bytes{device="/dev/sda1",fstype="ext4",mountpoint="/"}`) {
		t.Fatalf("root filesystem missing:\n%s", out)
	}
	if !strings.Contains(out, `node_filesystem_device_error{device="/dev/sdz",fstype="ext4",mountpoint="/does-not-exist"} 1`) ||
		strings.Contains(out, `node_filesystem_size_bytes{device="/dev/sdz"`) {
		t.Fatalf("unreadable mount must have device_error=1 and no size:\n%s", out)
	}
}

func TestLoadAndUptime(t *testing.T) {
	env := fakeEnv(t, map[string]string{"proc/loadavg": "0.50 0.25 0.10 1/100 123\n", "proc/uptime": "3600.5 100.0\n"})
	out, _ := run(t, Load{}, env)
	if !strings.Contains(out, "node_load5 0.25") {
		t.Fatal(out)
	}
	out, _ = run(t, Uptime{}, env)
	if !strings.Contains(out, "observaone_uptime_seconds 3600.5") {
		t.Fatal(out)
	}
	os.WriteFile(filepath.Join(env.Proc, "loadavg"), []byte("garbage\n"), 0o644)
	if out, err := run(t, Load{}, env); err == nil || out != "" {
		t.Fatal("garbage must be an error with no samples")
	}
}

func TestNoInvalidNumbersOnThisHost(t *testing.T) {
	if _, err := os.Stat("/proc/stat"); err != nil {
		t.Skip("not Linux")
	}
	env := &collector.Env{Proc: "/proc", Sys: "/sys", Root: "/", Rates: core.NewRates(), Now: time.Now(), Version: "test"}
	for round := 0; round < 2; round++ {
		for _, c := range All() {
			b := core.NewBatch()
			_ = c.Collect(env, b)
			if b.Dropped != 0 {
				t.Fatalf("%s produced %d NaN/Inf/negative samples", c.Name(), b.Dropped)
			}
			for _, ln := range strings.Split(b.Text(0), "\n") {
				if strings.Contains(ln, "NaN") || strings.Contains(ln, "Inf") {
					t.Fatalf("invalid value: %s", ln)
				}
			}
		}
		env.Now = env.Now.Add(time.Second)
		time.Sleep(time.Second)
	}
}
