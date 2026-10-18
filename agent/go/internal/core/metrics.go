package core

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Metric types in the Prometheus text format.
const (
	Gauge   = "gauge"
	Counter = "counter"
)

var nameRE = regexp.MustCompile(`^[a-zA-Z_:][a-zA-Z0-9_:]*$`)
var labelRE = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

type sample struct {
	labels string
	value  float64
}

type family struct {
	typ, help string
	samples   []sample
}

// Batch collects the samples of one collection round. Invalid values (NaN, ±Inf, negative counters)
// are refused here, so they can never be sent: a missing value stays missing, it never becomes 0.
type Batch struct {
	mu       sync.Mutex
	families map[string]*family
	order    []string
	Dropped  int // samples refused because their value was not valid
}

func NewBatch() *Batch { return &Batch{families: map[string]*family{}} }

// Add one sample. labels are name/value pairs: Add("node_load1", Gauge, "...", v) or
// Add("node_cpu_seconds_total", Counter, "...", v, "cpu", "0", "mode", "idle").
func (b *Batch) Add(name, typ, help string, value float64, labels ...string) {
	if !nameRE.MatchString(name) || len(labels)%2 != 0 {
		b.mu.Lock()
		b.Dropped++
		b.mu.Unlock()
		return
	}
	if math.IsNaN(value) || math.IsInf(value, 0) || (typ == Counter && value < 0) {
		b.mu.Lock()
		b.Dropped++
		b.mu.Unlock()
		return
	}
	var sb strings.Builder
	if len(labels) > 0 {
		pairs := make([][2]string, 0, len(labels)/2)
		for i := 0; i < len(labels); i += 2 {
			if !labelRE.MatchString(labels[i]) {
				b.mu.Lock()
				b.Dropped++
				b.mu.Unlock()
				return
			}
			pairs = append(pairs, [2]string{labels[i], labels[i+1]})
		}
		sort.Slice(pairs, func(i, j int) bool { return pairs[i][0] < pairs[j][0] })
		sb.WriteByte('{')
		for i, p := range pairs {
			if i > 0 {
				sb.WriteByte(',')
			}
			sb.WriteString(p[0])
			sb.WriteString(`="`)
			sb.WriteString(escapeLabel(p[1]))
			sb.WriteByte('"')
		}
		sb.WriteByte('}')
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	f := b.families[name]
	if f == nil {
		f = &family{typ: typ, help: help}
		b.families[name] = f
		b.order = append(b.order, name)
	}
	f.samples = append(f.samples, sample{labels: sb.String(), value: value})
}

// Merge copies every sample of o into b (used to keep a collector's samples only when it succeeded).
func (b *Batch) Merge(o *Batch) {
	o.mu.Lock()
	defer o.mu.Unlock()
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, name := range o.order {
		f := o.families[name]
		t := b.families[name]
		if t == nil {
			t = &family{typ: f.typ, help: f.help}
			b.families[name] = t
			b.order = append(b.order, name)
		}
		t.samples = append(t.samples, f.samples...)
	}
	b.Dropped += o.Dropped
}

// Len is the number of samples in the batch.
func (b *Batch) Len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := 0
	for _, f := range b.families {
		n += len(f.samples)
	}
	return n
}

// Text renders the batch in the Prometheus text exposition format. tsMs > 0 adds a timestamp to every sample.
func (b *Batch) Text(tsMs int64) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	var sb strings.Builder
	ts := ""
	if tsMs > 0 {
		ts = " " + strconv.FormatInt(tsMs, 10)
	}
	for _, name := range b.order {
		f := b.families[name]
		fmt.Fprintf(&sb, "# HELP %s %s\n# TYPE %s %s\n", name, strings.ReplaceAll(f.help, "\n", " "), name, f.typ)
		for _, s := range f.samples {
			sb.WriteString(name)
			sb.WriteString(s.labels)
			sb.WriteByte(' ')
			sb.WriteString(strconv.FormatFloat(s.value, 'g', -1, 64))
			sb.WriteString(ts)
			sb.WriteByte('\n')
		}
	}
	return sb.String()
}

func escapeLabel(v string) string {
	if len(v) > 128 {
		v = v[:128]
	}
	v = strings.ReplaceAll(v, `\`, `\\`)
	v = strings.ReplaceAll(v, `"`, `\"`)
	return strings.ReplaceAll(v, "\n", `\n`)
}

// Rates turns counters into per-second rates from deltas over elapsed time.
// A counter that goes down (reset, reboot, device re-attached) gives NO rate for that round
// instead of a huge or negative spike. The first sample of a series also gives no rate.
type Rates struct {
	mu   sync.Mutex
	prev map[string]point
}

type point struct {
	v float64
	t time.Time
}

func NewRates() *Rates { return &Rates{prev: map[string]point{}} }

// Rate returns (rate, true) when a valid rate exists for key.
func (r *Rates) Rate(key string, v float64, now time.Time) (float64, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.prev[key]
	r.prev[key] = point{v, now}
	if !ok || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, false
	}
	dt := now.Sub(p.t).Seconds()
	if dt <= 0 || v < p.v {
		return 0, false
	}
	return (v - p.v) / dt, true
}

// Reset forgets every previous value (used after a reboot is detected).
func (r *Rates) Reset() {
	r.mu.Lock()
	r.prev = map[string]point{}
	r.mu.Unlock()
}

// Prune drops series not updated since before cutoff (devices that disappeared), bounding memory.
func (r *Rates) Prune(cutoff time.Time) {
	r.mu.Lock()
	for k, p := range r.prev {
		if p.t.Before(cutoff) {
			delete(r.prev, k)
		}
	}
	r.mu.Unlock()
}
