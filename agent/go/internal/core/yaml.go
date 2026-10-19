package core

import (
	"fmt"
	"strings"
)

// A small YAML reader for agent.yaml: block maps, scalars, block lists ("- x") and flow lists ("[a, b]").
// Anchors, tags, multi-line scalars and multiple documents are refused with a clear error rather than
// half-understood. The agent stays standard-library only, so it does not pull in a full YAML library.
//
// The result is flat: nested keys are joined with "." ("pull.listen"), lists become comma-separated
// values, so YAML and the old key = value files go through the same validation.

type yamlKV struct {
	Key, Value string
	Line       int
}

type yline struct {
	n      int
	indent int
	text   string // without indentation and comment
}

func parseYAMLFlat(src string) ([]yamlKV, error) {
	var lines []yline
	for i, raw := range strings.Split(strings.ReplaceAll(src, "\r\n", "\n"), "\n") {
		n := i + 1
		body := strings.TrimRight(stripComment(raw), " \t")
		if strings.TrimSpace(body) == "" {
			continue
		}
		ind := 0
		for ind < len(body) && body[ind] == ' ' {
			ind++
		}
		if ind < len(body) && body[ind] == '\t' {
			return nil, fmt.Errorf("line %d: tabs are not allowed for indentation, use spaces", n)
		}
		t := body[ind:]
		if t == "---" && len(lines) == 0 {
			continue
		}
		if t == "---" || t == "..." {
			return nil, fmt.Errorf("line %d: only one YAML document is allowed", n)
		}
		lines = append(lines, yline{n, ind, t})
	}
	var out []yamlKV
	p := &yparser{lines: lines}
	if err := p.block(0, "", &out); err != nil {
		return nil, err
	}
	if p.i < len(p.lines) {
		return nil, fmt.Errorf("line %d: unexpected indentation", p.lines[p.i].n)
	}
	return out, nil
}

type yparser struct {
	lines []yline
	i     int
}

// block reads a map whose keys are at exactly `indent`.
func (p *yparser) block(indent int, prefix string, out *[]yamlKV) error {
	seen := map[string]bool{}
	for p.i < len(p.lines) {
		l := p.lines[p.i]
		if l.indent < indent {
			return nil
		}
		if l.indent > indent {
			return fmt.Errorf("line %d: unexpected indentation", l.n)
		}
		if strings.HasPrefix(l.text, "- ") || l.text == "-" {
			return fmt.Errorf("line %d: a list item here needs a key above it (key:)", l.n)
		}
		k, rest, ok := splitKey(l.text)
		if !ok {
			return fmt.Errorf("line %d: expected \"key: value\"", l.n)
		}
		if seen[k] {
			return fmt.Errorf("line %d: %s appears twice", l.n, prefix+k)
		}
		seen[k] = true
		full := prefix + k
		p.i++
		if rest != "" {
			v, err := scalarOrFlow(rest, l.n)
			if err != nil {
				return err
			}
			*out = append(*out, yamlKV{full, v, l.n})
			continue
		}
		// "key:" followed by a nested map, a list, or nothing (empty value)
		if p.i >= len(p.lines) || p.lines[p.i].indent <= indent {
			if p.i < len(p.lines) && p.lines[p.i].indent == indent && strings.HasPrefix(p.lines[p.i].text, "- ") {
				if err := p.list(indent, full, l.n, out); err != nil { // "key:\n- a" (list at the same indent)
					return err
				}
				continue
			}
			*out = append(*out, yamlKV{full, "", l.n})
			continue
		}
		child := p.lines[p.i]
		if strings.HasPrefix(child.text, "- ") || child.text == "-" {
			if err := p.list(child.indent, full, l.n, out); err != nil {
				return err
			}
			continue
		}
		if err := p.block(child.indent, full+".", out); err != nil {
			return err
		}
	}
	return nil
}

func (p *yparser) list(indent int, key string, keyLine int, out *[]yamlKV) error {
	var items []string
	for p.i < len(p.lines) {
		l := p.lines[p.i]
		if l.indent != indent || !(strings.HasPrefix(l.text, "- ") || l.text == "-") {
			break
		}
		item := strings.TrimSpace(strings.TrimPrefix(l.text, "-"))
		if _, _, isMap := splitKey(item); isMap && !strings.HasPrefix(item, `"`) && !strings.HasPrefix(item, `'`) {
			return fmt.Errorf("line %d: lists of maps are not supported in agent.yaml", l.n)
		}
		v, err := scalar(item, l.n)
		if err != nil {
			return err
		}
		if strings.Contains(v, ",") {
			return fmt.Errorf("line %d: list items cannot contain a comma", l.n)
		}
		items = append(items, v)
		p.i++
	}
	if p.i < len(p.lines) && p.lines[p.i].indent > indent {
		return fmt.Errorf("line %d: unexpected indentation", p.lines[p.i].n)
	}
	*out = append(*out, yamlKV{key, strings.Join(items, ","), keyLine})
	return nil
}

// splitKey: "name: value" -> ("name", "value"). Keys are plain words (letters, digits, _ . -).
func splitKey(t string) (string, string, bool) {
	i := strings.Index(t, ":")
	if i <= 0 {
		return "", "", false
	}
	if i+1 < len(t) && t[i+1] != ' ' {
		return "", "", false // "https://x" is not a key
	}
	k := strings.TrimSpace(t[:i])
	for _, r := range k {
		if !(r == '_' || r == '-' || r == '.' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			return "", "", false
		}
	}
	return k, strings.TrimSpace(t[i+1:]), true
}

func scalarOrFlow(s string, n int) (string, error) {
	if strings.HasPrefix(s, "[") {
		if !strings.HasSuffix(s, "]") {
			return "", fmt.Errorf("line %d: a [list] must end on the same line", n)
		}
		inner := strings.TrimSpace(s[1 : len(s)-1])
		if inner == "" {
			return "", nil
		}
		var items []string
		for _, part := range splitFlow(inner) {
			v, err := scalar(strings.TrimSpace(part), n)
			if err != nil {
				return "", err
			}
			items = append(items, v)
		}
		return strings.Join(items, ","), nil
	}
	if s == "{}" {
		return "", nil
	}
	if strings.HasPrefix(s, "{") {
		return "", fmt.Errorf("line %d: {flow maps} are not supported; put each key on its own line", n)
	}
	return scalar(s, n)
}

func splitFlow(s string) []string {
	var parts []string
	var cur strings.Builder
	var q byte
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case q != 0:
			if c == q {
				q = 0
			}
			cur.WriteByte(c)
		case c == '"' || c == '\'':
			q = c
			cur.WriteByte(c)
		case c == ',':
			parts = append(parts, cur.String())
			cur.Reset()
		default:
			cur.WriteByte(c)
		}
	}
	return append(parts, cur.String())
}

func scalar(s string, n int) (string, error) {
	if s == "" {
		return "", nil
	}
	switch s[0] {
	case '&', '*', '!', '|', '>', '@', '`':
		return "", fmt.Errorf("line %d: YAML %q values are not supported in agent.yaml", n, s[:1])
	case '"':
		if len(s) < 2 || s[len(s)-1] != '"' {
			return "", fmt.Errorf("line %d: unterminated \"string\"", n)
		}
		var b strings.Builder
		in := s[1 : len(s)-1]
		for i := 0; i < len(in); i++ {
			if in[i] == '\\' && i+1 < len(in) {
				i++
				switch in[i] {
				case 'n':
					b.WriteByte('\n')
				case 't':
					b.WriteByte('\t')
				default:
					b.WriteByte(in[i])
				}
				continue
			}
			b.WriteByte(in[i])
		}
		return b.String(), nil
	case '\'':
		if len(s) < 2 || s[len(s)-1] != '\'' {
			return "", fmt.Errorf("line %d: unterminated 'string'", n)
		}
		return strings.ReplaceAll(s[1:len(s)-1], "''", "'"), nil
	}
	if s == "~" || s == "null" {
		return "", nil
	}
	return s, nil
}

// stripComment removes "# ..." that is not inside quotes (YAML: a comment starts at "#" after a space).
func stripComment(s string) string {
	var q byte
	for i := 0; i < len(s); i++ {
		c := s[i]
		if q != 0 {
			if c == q {
				q = 0
			}
			continue
		}
		if c == '"' || c == '\'' {
			q = c
			continue
		}
		if c == '#' && (i == 0 || s[i-1] == ' ' || s[i-1] == '\t') {
			return s[:i]
		}
	}
	return s
}

// yamlQuote returns v as a YAML scalar, quoted when needed.
func yamlQuote(v string) string {
	if v == "" {
		return `""`
	}
	plain := true
	for _, r := range v {
		if !(r == '_' || r == '-' || r == '.' || r == '/' || r == ':' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			plain = false
		}
	}
	switch v {
	case "true", "false", "yes", "no", "null", "~", "on", "off":
		plain = false
	}
	if plain && !strings.Contains(v, ": ") && !strings.HasSuffix(v, ":") {
		return v
	}
	return `"` + strings.ReplaceAll(strings.ReplaceAll(v, `\`, `\\`), `"`, `\"`) + `"`
}
