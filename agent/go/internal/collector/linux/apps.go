package linux

// Application collectors (1.3): Nginx (stub_status), JVM (Jolokia) and local Prometheus exporters.
// Their addresses are host-only settings (nginx.status_url, jolokia.<service>, exporters.<name>): the
// ObservaOne server can switch them off, never point them somewhere else. Each read has a short timeout and a
// size limit, follows no redirects, and a slow or broken endpoint never holds up the other collectors.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"observaone/agent/internal/collector"
	"observaone/agent/internal/core"
)

var appHTTP = &http.Client{
	Timeout:       4 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	Transport:     &http.Transport{Proxy: nil, MaxIdleConns: 4, IdleConnTimeout: 60 * time.Second},
}

func appGet(raw string, max int64, accept string) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, raw, nil)
	if err != nil {
		return nil, err
	}
	if u, _ := url.Parse(raw); u != nil && u.User != nil {
		p, _ := u.User.Password()
		req.SetBasicAuth(u.User.Username(), p)
	}
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	req.Header.Set("User-Agent", "ObservaOne-Agent")
	resp, err := appHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, max+1))
	if int64(len(b)) > max {
		return nil, fmt.Errorf("answer larger than %d bytes", max)
	}
	return b, err
}

// redacted for error messages (a URL may carry user:password)
func showURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "(invalid URL)"
	}
	u.User = nil
	return u.String()
}

// ---------------- Nginx ----------------

type Nginx struct{}

func (Nginx) Name() string { return "nginx" }

// Collect reads stub_status (nginx-prometheus-exporter metric names):
//
//	Active connections: 2
//	server accepts handled requests
//	 16630948 16630948 31070465
//	Reading: 0 Writing: 1 Waiting: 1
func (Nginx) Collect(env *collector.Env, b *core.Batch) error {
	if env.Cfg == nil || env.Cfg.NginxURL == "" {
		return collector.ErrNotConfigured
	}
	body, err := appGet(env.Cfg.NginxURL, 64<<10, "text/plain")
	if err != nil {
		b.Add("nginx_up", core.Gauge, "1 if stub_status could be read.", 0)
		return fmt.Errorf("nginx %s: %w", showURL(env.Cfg.NginxURL), err)
	}
	v, err := parseStubStatus(string(body))
	if err != nil {
		b.Add("nginx_up", core.Gauge, "1 if stub_status could be read.", 0)
		return err
	}
	b.Add("nginx_up", core.Gauge, "1 if stub_status could be read.", 1)
	b.Add("nginx_connections_active", core.Gauge, "Active client connections.", v["active"])
	b.Add("nginx_connections_reading", core.Gauge, "Connections reading the request header.", v["reading"])
	b.Add("nginx_connections_writing", core.Gauge, "Connections writing the response.", v["writing"])
	b.Add("nginx_connections_waiting", core.Gauge, "Idle keep-alive connections.", v["waiting"])
	b.Add("nginx_connections_accepted", core.Counter, "Accepted client connections.", v["accepts"])
	b.Add("nginx_connections_handled", core.Counter, "Handled client connections.", v["handled"])
	b.Add("nginx_http_requests_total", core.Counter, "Client requests.", v["requests"])
	return nil
}

func parseStubStatus(s string) (map[string]float64, error) {
	v := map[string]float64{}
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) < 4 || !strings.HasPrefix(lines[0], "Active connections:") {
		return nil, fmt.Errorf("nginx: not a stub_status page (check nginx.status_url and that stub_status is on)")
	}
	n, err := strconv.ParseFloat(strings.TrimSpace(strings.TrimPrefix(lines[0], "Active connections:")), 64)
	if err != nil {
		return nil, fmt.Errorf("nginx stub_status: %v", err)
	}
	v["active"] = n
	f := strings.Fields(lines[2])
	if len(f) != 3 {
		return nil, fmt.Errorf("nginx stub_status: unexpected counters line %q", lines[2])
	}
	for i, k := range []string{"accepts", "handled", "requests"} {
		if v[k], err = strconv.ParseFloat(f[i], 64); err != nil {
			return nil, fmt.Errorf("nginx stub_status: %v", err)
		}
	}
	f = strings.Fields(lines[3])
	for i := 0; i+1 < len(f); i += 2 {
		x, err := strconv.ParseFloat(f[i+1], 64)
		if err != nil {
			return nil, fmt.Errorf("nginx stub_status: %v", err)
		}
		v[strings.ToLower(strings.TrimSuffix(f[i], ":"))] = x
	}
	return v, nil
}

// ---------------- JVM via Jolokia ----------------

type JVM struct{}

func (JVM) Name() string { return "jvm" }

// Collect asks each Jolokia agent for heap / non-heap memory, threads, GC and uptime in ONE bulk request, and
// writes them with the OpenTelemetry JVM names the Metrics pages already use (jvm_memory_used_bytes{
// jvm_memory_type="heap"}, ...), labelled service_name=<the name in jolokia.<name>>.
func (JVM) Collect(env *collector.Env, b *core.Batch) error {
	if env.Cfg == nil || len(env.Cfg.Jolokia) == 0 {
		return collector.ErrNotConfigured
	}
	names := make([]string, 0, len(env.Cfg.Jolokia))
	for n := range env.Cfg.Jolokia {
		names = append(names, n)
	}
	sort.Strings(names)
	failed := 0
	var lastErr error
	for _, svc := range names {
		err := jolokiaOne(env.Cfg.Jolokia[svc], svc, b)
		b.Add("observaone_jvm_up", core.Gauge, "1 if the JVM's Jolokia endpoint answered.", boolf(err == nil), "service_name", svc)
		if err != nil {
			failed++
			lastErr = fmt.Errorf("jolokia %s (%s): %w", svc, showURL(env.Cfg.Jolokia[svc]), err)
			env.Note(lastErr.Error())
		}
	}
	if failed == len(names) {
		return lastErr
	}
	return nil
}

type jolokiaReply struct {
	Status int             `json:"status"`
	Value  json.RawMessage `json:"value"`
	Error  string          `json:"error"`
}

func jolokiaOne(base, svc string, b *core.Batch) error {
	reqs := `[{"type":"read","mbean":"java.lang:type=Memory"},{"type":"read","mbean":"java.lang:type=Threading","attribute":["ThreadCount","DaemonThreadCount"]},` +
		`{"type":"read","mbean":"java.lang:type=GarbageCollector,name=*","attribute":["CollectionCount","CollectionTime"]},{"type":"read","mbean":"java.lang:type=Runtime","attribute":"Uptime"}]`
	req, err := http.NewRequest(http.MethodPost, strings.TrimRight(base, "/"), strings.NewReader(reqs))
	if err != nil {
		return err
	}
	if u, _ := url.Parse(base); u != nil && u.User != nil {
		p, _ := u.User.Password()
		req.SetBasicAuth(u.User.Username(), p)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := appHTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var out []jolokiaReply
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil {
		return fmt.Errorf("not a Jolokia answer: %v", err)
	}
	if len(out) != 4 {
		return fmt.Errorf("unexpected Jolokia answer (%d parts)", len(out))
	}
	if out[0].Status == 200 {
		var mem struct {
			Heap    map[string]float64 `json:"HeapMemoryUsage"`
			NonHeap map[string]float64 `json:"NonHeapMemoryUsage"`
		}
		if json.Unmarshal(out[0].Value, &mem) == nil {
			for typ, m := range map[string]map[string]float64{"heap": mem.Heap, "non_heap": mem.NonHeap} {
				b.Add("jvm_memory_used_bytes", core.Gauge, "JVM memory used.", m["used"], "service_name", svc, "jvm_memory_type", typ)
				b.Add("jvm_memory_committed_bytes", core.Gauge, "JVM memory committed.", m["committed"], "service_name", svc, "jvm_memory_type", typ)
				if m["max"] > 0 {
					b.Add("jvm_memory_limit_bytes", core.Gauge, "JVM memory limit (-Xmx for the heap).", m["max"], "service_name", svc, "jvm_memory_type", typ)
				}
			}
		}
	} else {
		return fmt.Errorf("Memory MBean: %s", out[0].Error)
	}
	if out[1].Status == 200 {
		var th map[string]float64
		if json.Unmarshal(out[1].Value, &th) == nil {
			b.Add("jvm_thread_count", core.Gauge, "Live threads.", th["ThreadCount"], "service_name", svc)
			b.Add("jvm_thread_daemon_count", core.Gauge, "Live daemon threads.", th["DaemonThreadCount"], "service_name", svc)
		}
	}
	if out[2].Status == 200 {
		var gcs map[string]map[string]float64
		if json.Unmarshal(out[2].Value, &gcs) == nil {
			for mbean, v := range gcs {
				name := mbean
				if i := strings.Index(mbean, "name="); i >= 0 {
					name = strings.SplitN(mbean[i+5:], ",", 2)[0]
				}
				b.Add("jvm_gc_collections_total", core.Counter, "Garbage collections.", v["CollectionCount"], "service_name", svc, "jvm_gc_name", name)
				b.Add("jvm_gc_collection_seconds_total", core.Counter, "Time spent in garbage collection.", v["CollectionTime"]/1000, "service_name", svc, "jvm_gc_name", name)
			}
		}
	}
	if out[3].Status == 200 {
		var up float64
		if json.Unmarshal(out[3].Value, &up) == nil {
			b.Add("jvm_uptime_seconds", core.Gauge, "JVM uptime.", up/1000, "service_name", svc)
		}
	}
	return nil
}

func boolf(v bool) float64 {
	if v {
		return 1
	}
	return 0
}

// ---------------- local Prometheus exporters ----------------

type Exporters struct{}

func (Exporters) Name() string { return "exporters" }

// Collect reads each local exporter (exporters.<name>: URL) and forwards its samples with exporter="<name>".
// Bounded: 5,000 series and 4 MB per exporter. Labels the server sets (host, job, agent_id...) are dropped
// from what the exporter sends, so an exporter cannot pretend to be another host.
func (Exporters) Collect(env *collector.Env, b *core.Batch) error {
	if env.Cfg == nil || len(env.Cfg.Exporters) == 0 {
		return collector.ErrNotConfigured
	}
	names := make([]string, 0, len(env.Cfg.Exporters))
	for n := range env.Cfg.Exporters {
		names = append(names, n)
	}
	sort.Strings(names)
	failed := 0
	var lastErr error
	for _, n := range names {
		raw := env.Cfg.Exporters[n]
		body, err := appGet(raw, 4<<20, "text/plain;version=0.0.4")
		if err == nil {
			var count int
			count, err = core.ParseExposition(string(body), 5000, func(name, typ, help string, value float64, labels []string) {
				out := make([]string, 0, len(labels)+2)
				for i := 0; i+1 < len(labels); i += 2 {
					if reservedForward[labels[i]] {
						continue
					}
					out = append(out, labels[i], labels[i+1])
				}
				b.Add(name, typ, help, value, append(out, "exporter", n)...)
			})
			if err == nil && count == 0 {
				err = fmt.Errorf("no samples")
			}
		}
		b.Add("observaone_exporter_up", core.Gauge, "1 if the local exporter answered with samples.", boolf(err == nil), "exporter", n)
		if err != nil {
			failed++
			lastErr = fmt.Errorf("exporter %s (%s): %w", n, showURL(raw), err)
			env.Note(lastErr.Error())
		}
	}
	if failed == len(names) {
		return lastErr
	}
	return nil
}

var reservedForward = map[string]bool{"host": true, "job": true, "instance": true, "agent": true, "agent_id": true, "platform": true, "env": true, "role": true, "tenant": true, "exporter": true}

