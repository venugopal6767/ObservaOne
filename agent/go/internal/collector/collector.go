// Package collector defines what every platform's collectors look like. Platform code lives in
// subpackages (linux today; windows, docker, kubernetes later) and plugs in through the same interface,
// so the core agent (enrollment, heartbeat, buffering, upload) never changes when a platform is added.
package collector

import (
	"errors"
	"io/fs"
	"strings"
	"sync"
	"time"

	"observaone/agent/internal/core"
)

// Env is what a collector may read. Paths are configurable so a containerised agent can read the
// host's /proc and /sys, and so tests can use fake files.
type Env struct {
	Proc, Sys, Root string
	Now             time.Time
	Rates           *core.Rates
	Version         string

	mu    sync.Mutex
	notes []string
}

// Note records a partial problem (one mount unreadable, one file missing) without failing the collector.
func (e *Env) Note(msg string) {
	e.mu.Lock()
	if len(e.notes) < 20 {
		e.notes = append(e.notes, msg)
	}
	e.mu.Unlock()
}

func (e *Env) TakeNotes() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	n := e.notes
	e.notes = nil
	return n
}

// Collector reads one area (cpu, memory, ...) and adds samples to the batch.
// Returning an error means NOTHING from this collector is trusted for this round: its samples are
// dropped by the runner, and the area shows as unavailable - never as 0.
type Collector interface {
	Name() string
	Collect(env *Env, b *core.Batch) error
}

// State of one collector after a round, reported in heartbeats.
type State struct {
	Status   string // ok | error | unavailable | disabled
	Error    string
	Duration time.Duration
}

// Classify turns an error into a state: permission and missing-file problems are "unavailable"
// (the host does not let us read it), anything else is "error".
func Classify(err error) State {
	if err == nil {
		return State{Status: "ok"}
	}
	msg := err.Error()
	if len(msg) > 200 {
		msg = msg[:200]
	}
	if errors.Is(err, fs.ErrPermission) || errors.Is(err, fs.ErrNotExist) || strings.Contains(msg, "unsupported") {
		return State{Status: "unavailable", Error: msg}
	}
	return State{Status: "error", Error: msg}
}
