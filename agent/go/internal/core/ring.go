package core

import (
	"bytes"
	"sync"
)

// LogRing keeps the last N log lines in memory, for the diagnostics bundle the UI can request.
// It is an io.Writer: the agent's JSON log handler writes to stderr (journald) and to the ring.
// The agent never logs tokens, credentials or keys, so the ring holds none either.
type LogRing struct {
	mu    sync.Mutex
	lines []string
	max   int
	part  []byte
}

func NewLogRing(max int) *LogRing { return &LogRing{max: max} }

func (r *LogRing) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.part = append(r.part, p...)
	for {
		i := bytes.IndexByte(r.part, '\n')
		if i < 0 {
			break
		}
		line := string(r.part[:i])
		r.part = r.part[i+1:]
		if len(line) > 2000 {
			line = line[:2000]
		}
		r.lines = append(r.lines, line)
		if len(r.lines) > r.max {
			r.lines = r.lines[len(r.lines)-r.max:]
		}
	}
	if len(r.part) > 8192 { // a line without newline that keeps growing: drop it
		r.part = nil
	}
	return len(p), nil
}

// Lines returns a copy, oldest first.
func (r *LogRing) Lines() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.lines...)
}
