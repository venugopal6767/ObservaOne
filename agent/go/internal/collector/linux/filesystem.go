package linux

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"observaone/agent/internal/collector"
	"observaone/agent/internal/core"
)

// Pseudo and in-memory filesystems are not disks: left out (same choice as node_exporter's defaults).
var skipFsTypes = map[string]bool{
	"autofs": true, "binfmt_misc": true, "bpf": true, "cgroup": true, "cgroup2": true, "configfs": true, "debugfs": true,
	"devpts": true, "devtmpfs": true, "fusectl": true, "hugetlbfs": true, "iso9660": true, "mqueue": true, "nsfs": true,
	"overlay": true, "proc": true, "procfs": true, "pstore": true, "rpc_pipefs": true, "securityfs": true, "selinuxfs": true,
	"squashfs": true, "sysfs": true, "tracefs": true, "tmpfs": true, "ramfs": true, "efivarfs": true, "fuse.lxcfs": true,
	"fuse.gvfsd-fuse": true, "nfsd": true,
}
var skipMounts = regexp.MustCompile(`^/(dev|proc|sys|run/credentials/.+|var/lib/docker/.+|var/lib/containers/storage/.+|var/lib/kubelet/.+|snap/.+)($|/)`)

const maxMounts = 100

// Filesystem: size, free and available bytes per mounted disk filesystem. A mount that cannot be read
// (permission, hung network share) gets node_filesystem_device_error=1 and NO size values.
type Filesystem struct{}

func (Filesystem) Name() string { return "filesystem" }

func (Filesystem) Collect(env *collector.Env, b *core.Batch) error {
	data, err := readFile(env, env.Proc, "self/mounts")
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	n := 0
	for _, ln := range lines(data) {
		f := strings.Fields(ln)
		if len(f) < 4 {
			continue
		}
		dev, mnt, fstype, opts := f[0], unescapeMount(f[1]), f[2], f[3]
		if skipFsTypes[fstype] || strings.HasPrefix(fstype, "fuse.") || skipMounts.MatchString(mnt) || seen[mnt] {
			continue
		}
		seen[mnt] = true
		if n++; n > maxMounts {
			env.Note(fmt.Sprintf("filesystem: more than %d mounts, the rest are skipped", maxMounts))
			break
		}
		labels := []string{"device", dev, "fstype", fstype, "mountpoint", mnt}
		ro := 0.0
		for _, o := range strings.Split(opts, ",") {
			if o == "ro" {
				ro = 1
			}
		}
		st, err := statfsTimeout(filepath.Join(env.Root, mnt), 2*time.Second)
		if err != nil {
			b.Add("node_filesystem_device_error", core.Gauge, "Whether an error occurred while getting statistics for the given device.", 1, labels...)
			env.Note(fmt.Sprintf("filesystem %s: %v", mnt, err))
			continue
		}
		bs := float64(st.Bsize)
		size := float64(st.Blocks) * bs
		if size <= 0 {
			continue // zero-size mounts carry no capacity information
		}
		b.Add("node_filesystem_device_error", core.Gauge, "Whether an error occurred while getting statistics for the given device.", 0, labels...)
		b.Add("node_filesystem_size_bytes", core.Gauge, "Filesystem size in bytes.", size, labels...)
		b.Add("node_filesystem_free_bytes", core.Gauge, "Filesystem free space in bytes.", float64(st.Bfree)*bs, labels...)
		b.Add("node_filesystem_avail_bytes", core.Gauge, "Filesystem space available to non-root users in bytes.", float64(st.Bavail)*bs, labels...)
		b.Add("node_filesystem_files", core.Gauge, "Filesystem total file nodes.", float64(st.Files), labels...)
		b.Add("node_filesystem_files_free", core.Gauge, "Filesystem total free file nodes.", float64(st.Ffree), labels...)
		b.Add("node_filesystem_readonly", core.Gauge, "Filesystem read-only status.", ro, labels...)
		used := size - float64(st.Bfree)*bs
		if used >= 0 && used+float64(st.Bavail)*bs > 0 {
			// df's "Use%": used / (used + available to users)
			b.Add("observaone_filesystem_utilization_ratio", core.Gauge, "Share of the filesystem in use, as df reports it (0-1).", used/(used+float64(st.Bavail)*bs), labels...)
		}
	}
	return nil
}

// statfs with a timeout: a dead NFS server must not freeze the whole agent.
func statfsTimeout(path string, d time.Duration) (*syscall.Statfs_t, error) {
	type res struct {
		st  syscall.Statfs_t
		err error
	}
	ch := make(chan res, 1)
	go func() {
		var r res
		r.err = syscall.Statfs(path, &r.st)
		ch <- r
	}()
	select {
	case r := <-ch:
		if r.err != nil {
			return nil, r.err
		}
		return &r.st, nil
	case <-time.After(d):
		return nil, fmt.Errorf("statfs timed out after %s", d)
	}
}

// /proc/self/mounts escapes spaces etc. as octal (\040).
func unescapeMount(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var sb strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			var v int
			if _, err := fmt.Sscanf(s[i+1:i+4], "%o", &v); err == nil {
				sb.WriteByte(byte(v))
				i += 3
				continue
			}
		}
		sb.WriteByte(s[i])
	}
	return sb.String()
}
