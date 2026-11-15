package agent

// Disk buffer (disk_buffer.enabled, push mode). For sites with WAN outages longer than the 10-minute memory
// buffer: a collection that would be dropped from memory, and whatever is still waiting when the agent stops, is
// written to <state_dir>/buffer as a gzip file. Uploads send these first, oldest first. Bounded by size
// (disk_buffer.max_mb, oldest deleted first) and age (disk_buffer.max_age, at most 2 h: Prometheus accepts samples
// up to 2 h late), so it can never fill the disk.

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"observaone/agent/internal/core"
)

type diskEntry struct {
	path        string
	collectedAt int64
	size        int64
}

func (a *Agent) diskDir() string { return filepath.Join(a.Config().StateDir, "buffer") }

func (a *Agent) diskEnabled() bool {
	c := a.Config()
	return c.DiskBuffer && c.Mode == "push"
}

func (a *Agent) diskList() []diskEntry {
	ents, err := os.ReadDir(a.diskDir())
	if err != nil {
		return nil
	}
	var out []diskEntry
	for _, e := range ents {
		n := e.Name()
		if !strings.HasSuffix(n, ".prom.gz") {
			continue
		}
		ts, err := strconv.ParseInt(strings.SplitN(n, "-", 2)[0], 10, 64)
		if err != nil {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, diskEntry{path: filepath.Join(a.diskDir(), n), collectedAt: ts, size: info.Size()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].path < out[j].path })
	return out
}

// diskPrune removes entries older than max_age, then the oldest until the total fits max_mb (minus room for one more).
func (a *Agent) diskPrune(room int64) (dropped int) {
	c := a.Config()
	limit := int64(c.DiskBufferMB) << 20
	cutoff := time.Now().Add(-c.DiskBufferTTL).UnixMilli()
	list := a.diskList()
	var total int64
	keep := list[:0]
	for _, e := range list {
		if e.collectedAt < cutoff {
			_ = os.Remove(e.path)
			dropped++
			continue
		}
		total += e.size
		keep = append(keep, e)
	}
	for len(keep) > 0 && total+room > limit {
		_ = os.Remove(keep[0].path)
		total -= keep[0].size
		keep = keep[1:]
		dropped++
	}
	return dropped
}

func (a *Agent) spill(p payload) error {
	if err := os.MkdirAll(a.diskDir(), 0o700); err != nil {
		return err
	}
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	_, _ = zw.Write([]byte(p.text))
	_ = zw.Close()
	if d := a.diskPrune(int64(buf.Len())); d > 0 {
		a.mu.Lock()
		a.dropped += uint64(d)
		a.mu.Unlock()
	}
	name := fmt.Sprintf("%013d-%s.prom.gz", p.collectedAt, randomHex(4))
	return core.WriteFileAtomic(filepath.Join(a.diskDir(), name), buf.Bytes(), 0o600)
}

// spillAll writes what is waiting in memory to disk (agent stopping, server unreachable).
func (a *Agent) spillAll() int {
	a.mu.Lock()
	rest := a.buf
	a.buf = nil
	a.mu.Unlock()
	n := 0
	for _, p := range rest {
		if a.spill(p) == nil {
			n++
		}
	}
	return n
}

func (a *Agent) diskStats() (files int, bytes int64) {
	for _, e := range a.diskList() {
		files++
		bytes += e.size
	}
	return
}

// flushDisk sends the disk buffer oldest first. Returns the first retryable error (the rest waits).
func (a *Agent) flushDisk(ctx context.Context) error {
	if a.diskPrune(0); !a.diskEnabled() && len(a.diskList()) == 0 {
		return nil
	}
	for _, e := range a.diskList() {
		f, err := os.Open(e.path)
		if err != nil {
			continue
		}
		zr, err := gzip.NewReader(io.LimitReader(f, 64<<20))
		var text []byte
		if err == nil {
			text, err = io.ReadAll(io.LimitReader(zr, 256<<20))
		}
		f.Close()
		if err != nil {
			_ = os.Remove(e.path) // damaged file: never block the queue on it
			continue
		}
		a.mu.Lock()
		cl, cred := a.client, a.cred
		a.mu.Unlock()
		err = cl.PostMetrics(ctx, a.id.AgentID, cred, string(text), e.collectedAt)
		var ae *core.APIError
		switch {
		case err == nil:
			_ = os.Remove(e.path)
			a.mu.Lock()
			a.lastPushOK = time.Now()
			a.mu.Unlock()
		case errors.As(err, &ae) && !ae.Retryable() && ae.Status != 401 && ae.Status != 403:
			_ = os.Remove(e.path) // refused for its content (too old, invalid): drop it and go on
			a.mu.Lock()
			a.pushFailed++
			a.mu.Unlock()
		default:
			return err
		}
	}
	return nil
}
