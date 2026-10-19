package core

import (
	"fmt"
	"strconv"
	"strings"
)

// ParseExposition reads the Prometheus text format (what exporters answer on /metrics) and calls add for every
// sample, at most max samples. Timestamps are ignored (the agent stamps the batch). Histograms and summaries come
// through as their _bucket / _sum / _count series (typed counter / gauge as Prometheus itself stores them).
// A malformed line is an error: forwarding half of a broken answer would look like data loss downstream.
func ParseExposition(text string, max int, add func(name, typ, help string, value float64, labels []string)) (int, error) {
	types, helps := map[string]string{}, map[string]string{}
	n := 0
	for ln, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#") {
			f := strings.SplitN(line, " ", 4)
			if len(f) >= 4 && f[1] == "TYPE" {
				types[f[2]] = f[3]
			} else if len(f) >= 4 && f[1] == "HELP" {
				helps[f[2]] = f[3]
			}
			continue
		}
		name, labels, rest, err := splitSample(line)
		if err != nil {
			return n, fmt.Errorf("line %d: %v", ln+1, err)
		}
		vf := strings.Fields(rest)
		if len(vf) < 1 {
			return n, fmt.Errorf("line %d: no value", ln+1)
		}
		v, err := strconv.ParseFloat(vf[0], 64)
		if err != nil {
			return n, fmt.Errorf("line %d: value %q", ln+1, vf[0])
		}
		if n >= max {
			return n, fmt.Errorf("more than %d samples (limit)", max)
		}
		base := name
		for _, suf := range []string{"_bucket", "_sum", "_count", "_total", "_created"} {
			if strings.HasSuffix(name, suf) {
				if _, ok := types[strings.TrimSuffix(name, suf)]; ok {
					base = strings.TrimSuffix(name, suf)
				}
			}
		}
		typ := Gauge
		switch types[base] {
		case "counter":
			typ = Counter
		case "histogram", "summary":
			if strings.HasSuffix(name, "_bucket") || strings.HasSuffix(name, "_count") || strings.HasSuffix(name, "_sum") {
				typ = Counter
			}
		}
		if strings.HasSuffix(name, "_created") {
			continue
		}
		add(name, typ, helps[base], v, labels)
		n++
	}
	return n, nil
}

func splitSample(line string) (name string, labels []string, rest string, err error) {
	i := strings.IndexAny(line, "{ \t")
	if i < 0 {
		return "", nil, "", fmt.Errorf("no value")
	}
	name = line[:i]
	if !nameRE.MatchString(name) {
		return "", nil, "", fmt.Errorf("metric name %q", name)
	}
	if line[i] != '{' {
		return name, nil, line[i:], nil
	}
	p := i + 1
	for {
		for p < len(line) && (line[p] == ' ' || line[p] == ',') {
			p++
		}
		if p >= len(line) {
			return "", nil, "", fmt.Errorf("unterminated labels")
		}
		if line[p] == '}' {
			return name, labels, line[p+1:], nil
		}
		eq := strings.IndexByte(line[p:], '=')
		if eq < 0 {
			return "", nil, "", fmt.Errorf("label without value")
		}
		key := strings.TrimSpace(line[p : p+eq])
		p += eq + 1
		if p >= len(line) || line[p] != '"' {
			return "", nil, "", fmt.Errorf("label %s: value not quoted", key)
		}
		p++
		var sb strings.Builder
		for {
			if p >= len(line) {
				return "", nil, "", fmt.Errorf("label %s: unterminated value", key)
			}
			c := line[p]
			if c == '\\' && p+1 < len(line) {
				switch line[p+1] {
				case 'n':
					sb.WriteByte('\n')
				default:
					sb.WriteByte(line[p+1])
				}
				p += 2
				continue
			}
			if c == '"' {
				p++
				break
			}
			sb.WriteByte(c)
			p++
		}
		labels = append(labels, key, sb.String())
	}
}
