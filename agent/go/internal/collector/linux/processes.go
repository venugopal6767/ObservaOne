package linux

// Processes: the top N process groups (same command name) by CPU and by memory, in process-exporter's metric
// names, so the host view's Processes tab and existing PromQL work unchanged:
//
//	namedprocess_namegroup_cpu_seconds_total{groupname, mode="user|system"}   counter
//	namedprocess_namegroup_memory_bytes{groupname, memtype="resident|virtual"}
//	namedprocess_namegroup_num_procs{groupname}
//
// Bounded: at most 2N groups per round (top N by CPU + top N by memory), command names only (never command lines,
// environment or arguments). The CPU counter of a group only grows: a process that exits takes nothing away,
// a new process counts from when it is first seen, so rate() never sees a fake reset when processes come and go.

import (
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"

	"observaone/agent/internal/collector"
	"observaone/agent/internal/core"
)

type procSample struct{ user, system float64 }

type Processes struct {
	mu      sync.Mutex
	lastPid map[int]procSample // per pid: cpu seconds at the previous round
	lastBy  map[int]string     // pid -> group (a pid reused by another command starts again)
	total   map[string]*procSample
}

func (*Processes) Name() string { return "processes" }

const clkTck = 100 // USER_HZ on every Linux the agent supports

func (p *Processes) Collect(env *collector.Env, b *core.Batch) error {
	top := 10
	if env.Cfg != nil {
		top = env.Cfg.ProcessesTop
	}
	if top <= 0 {
		return collector.ErrNotConfigured
	}
	ents, err := os.ReadDir(env.Proc)
	if err != nil {
		return err
	}
	type group struct {
		name           string
		rss, vsz       float64
		procs          int
		dUser, dSystem float64
	}
	groups := map[string]*group{}
	nowPid := map[int]procSample{}
	nowBy := map[int]string{}
	pageSize := float64(os.Getpagesize())
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		stat, err := os.ReadFile(filepath.Join(env.Proc, e.Name(), "stat"))
		if err != nil {
			continue // exited, or not ours to read
		}
		s := string(stat)
		l, r := strings.IndexByte(s, '('), strings.LastIndexByte(s, ')')
		if l < 0 || r < l {
			continue
		}
		name := sanitizeComm(s[l+1 : r])
		f := strings.Fields(s[r+1:])
		if len(f) < 22 || f[0] == "Z" {
			continue
		}
		ut, _ := strconv.ParseFloat(f[11], 64)
		st, _ := strconv.ParseFloat(f[12], 64)
		vsz, _ := strconv.ParseFloat(f[20], 64)
		rssPages, _ := strconv.ParseFloat(f[21], 64)
		cur := procSample{user: ut / clkTck, system: st / clkTck}
		nowPid[pid], nowBy[pid] = cur, name
		g := groups[name]
		if g == nil {
			g = &group{name: name}
			groups[name] = g
		}
		g.procs++
		g.rss += rssPages * pageSize
		g.vsz += vsz
		p.mu.Lock()
		if prev, ok := p.lastPid[pid]; ok && p.lastBy[pid] == name && cur.user >= prev.user && cur.system >= prev.system {
			g.dUser += cur.user - prev.user
			g.dSystem += cur.system - prev.system
		}
		p.mu.Unlock()
	}
	if len(groups) == 0 {
		return os.ErrPermission
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.total == nil {
		p.total = map[string]*procSample{}
	}
	for name, g := range groups {
		t := p.total[name]
		if t == nil {
			t = &procSample{}
			p.total[name] = t
		}
		t.user += g.dUser
		t.system += g.dSystem
	}
	p.lastPid, p.lastBy = nowPid, nowBy
	// forget groups that are gone, so memory stays bounded on hosts that start many short-lived commands
	for name := range p.total {
		if groups[name] == nil {
			delete(p.total, name)
		}
	}
	list := make([]*group, 0, len(groups))
	for _, g := range groups {
		list = append(list, g)
	}
	pick := map[string]bool{}
	sort.Slice(list, func(i, j int) bool {
		ci, cj := list[i].dUser+list[i].dSystem, list[j].dUser+list[j].dSystem
		if ci != cj {
			return ci > cj
		}
		return list[i].name < list[j].name
	})
	for i := 0; i < len(list) && i < top; i++ {
		pick[list[i].name] = true
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].rss != list[j].rss {
			return list[i].rss > list[j].rss
		}
		return list[i].name < list[j].name
	})
	for i := 0; i < len(list) && i < top; i++ {
		pick[list[i].name] = true
	}
	for name := range pick {
		g, t := groups[name], p.total[name]
		b.Add("namedprocess_namegroup_cpu_seconds_total", core.Counter, "CPU seconds used by processes with this command name (counted from when the agent first saw them).", t.user, "groupname", name, "mode", "user")
		b.Add("namedprocess_namegroup_cpu_seconds_total", core.Counter, "CPU seconds used by processes with this command name (counted from when the agent first saw them).", t.system, "groupname", name, "mode", "system")
		b.Add("namedprocess_namegroup_memory_bytes", core.Gauge, "Memory of the processes with this command name.", g.rss, "groupname", name, "memtype", "resident")
		b.Add("namedprocess_namegroup_memory_bytes", core.Gauge, "Memory of the processes with this command name.", g.vsz, "groupname", name, "memtype", "virtual")
		b.Add("namedprocess_namegroup_num_procs", core.Gauge, "Processes with this command name.", float64(g.procs), "groupname", name)
	}
	b.Add("observaone_processes_total", core.Gauge, "Processes on the host (zombies excluded).", float64(len(nowPid)))
	return nil
}

// sanitizeComm keeps the kernel's command name readable and bounded (it is a label value).
func sanitizeComm(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return '_'
		}
		return r
	}, s)
	if len(s) > 32 {
		s = s[:32]
	}
	if s == "" {
		return "unknown"
	}
	return s
}
