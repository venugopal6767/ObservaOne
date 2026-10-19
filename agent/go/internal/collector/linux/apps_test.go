package linux

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"observaone/agent/internal/collector"
	"observaone/agent/internal/core"
)

func envWith(t *testing.T, mut func(c *core.Config)) *collector.Env {
	c := core.Defaults()
	if mut != nil {
		mut(c)
	}
	return &collector.Env{Proc: t.TempDir(), Sys: t.TempDir(), Root: "/", Now: time.Now(), Rates: core.NewRates(), Cfg: c}
}

func text(b *core.Batch) string { return b.Text(0) }

func writeStat(t *testing.T, proc string, pid int, comm string, utime, stime, rssPages int) {
	dir := filepath.Join(proc, fmt.Sprint(pid))
	os.MkdirAll(dir, 0o755)
	// pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime prio nice threads itreal start vsize rss
	line := fmt.Sprintf("%d (%s) S 1 1 1 0 -1 0 0 0 0 0 %d %d 0 0 20 0 1 0 100 1000000 %d 0 0", pid, comm, utime, stime, rssPages)
	os.WriteFile(filepath.Join(dir, "stat"), []byte(line), 0o644)
}

func TestProcessesTopNAndMonotonic(t *testing.T) {
	env := envWith(t, func(c *core.Config) { c.ProcessesTop = 2 })
	p := &Processes{}
	writeStat(t, env.Proc, 10, "nginx", 100, 50, 1000)
	writeStat(t, env.Proc, 11, "nginx", 100, 50, 1000)
	writeStat(t, env.Proc, 20, "java", 10, 0, 90000)
	writeStat(t, env.Proc, 30, "sleepy", 1, 0, 1)
	writeStat(t, env.Proc, 40, "my (weird) app", 1, 0, 2)
	b := core.NewBatch()
	if err := p.Collect(env, b); err != nil {
		t.Fatal(err)
	}
	// round 2: nginx uses 2 s of CPU, java 0.5 s; pid 11 exits (its CPU must not be taken away)
	os.RemoveAll(filepath.Join(env.Proc, "11"))
	writeStat(t, env.Proc, 10, "nginx", 300, 50, 1000)
	writeStat(t, env.Proc, 20, "java", 60, 0, 90000)
	b = core.NewBatch()
	if err := p.Collect(env, b); err != nil {
		t.Fatal(err)
	}
	out := text(b)
	for _, want := range []string{
		`namedprocess_namegroup_cpu_seconds_total{groupname="nginx",mode="user"} 2`,
		`namedprocess_namegroup_cpu_seconds_total{groupname="java",mode="user"} 0.5`,
		`namedprocess_namegroup_num_procs{groupname="nginx"} 1`,
		`observaone_processes_total 4`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in\n%s", want, out)
		}
	}
	if strings.Contains(out, `groupname="sleepy"`) {
		t.Error("top N not applied: sleepy is neither top CPU nor top memory")
	}
	// off
	env.Cfg.ProcessesTop = 0
	if err := p.Collect(env, core.NewBatch()); err != collector.ErrNotConfigured {
		t.Fatalf("top 0 must switch the collector off, got %v", err)
	}
}

func TestStubStatus(t *testing.T) {
	v, err := parseStubStatus("Active connections: 2 \nserver accepts handled requests\n 16630948 16630948 31070465 \nReading: 0 Writing: 1 Waiting: 1 \n")
	if err != nil || v["active"] != 2 || v["requests"] != 31070465 || v["writing"] != 1 || v["waiting"] != 1 {
		t.Fatalf("%v %v", v, err)
	}
	if _, err := parseStubStatus("<html>404</html>"); err == nil {
		t.Fatal("an HTML page must be refused")
	}
}

func TestNginxJolokiaExporters(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/nginx_status", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "Active connections: 5\nserver accepts handled requests\n 10 10 42\nReading: 0 Writing: 2 Waiting: 3\n")
	})
	mux.HandleFunc("/jolokia", func(w http.ResponseWriter, r *http.Request) {
		if u, p, ok := r.BasicAuth(); !ok || u != "mon" || p != "s3cret" {
			w.WriteHeader(401)
			return
		}
		io.WriteString(w, `[{"status":200,"value":{"HeapMemoryUsage":{"used":100,"committed":200,"max":400},"NonHeapMemoryUsage":{"used":10,"committed":20,"max":-1}}},
			{"status":200,"value":{"ThreadCount":33,"DaemonThreadCount":30}},
			{"status":200,"value":{"java.lang:name=G1 Young Generation,type=GarbageCollector":{"CollectionCount":7,"CollectionTime":1500}}},
			{"status":200,"value":123000}]`)
	})
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "# HELP x_requests_total Requests.\n# TYPE x_requests_total counter\nx_requests_total{path=\"/a\",host=\"evil\"} 12\n# TYPE x_lat histogram\nx_lat_bucket{le=\"0.1\"} 3\nx_lat_bucket{le=\"+Inf\"} 4\nx_lat_sum 0.7\nx_lat_count 4\nx_temp{room=\"a \\\"b\\\"\"} 21.5 1700000000000\n")
	})
	mux.HandleFunc("/redirect", func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "http://169.254.169.254/", http.StatusFound) })
	srv := httptest.NewServer(mux)
	defer srv.Close()
	u := strings.Replace(srv.URL, "http://", "http://mon:s3cret@", 1)
	env := envWith(t, func(c *core.Config) {
		c.NginxURL = srv.URL + "/nginx_status"
		c.Jolokia = map[string]string{"payments": u + "/jolokia"}
		c.Exporters = map[string]string{"app": srv.URL + "/metrics", "bad": srv.URL + "/redirect"}
	})
	b := core.NewBatch()
	for _, c := range []collector.Collector{Nginx{}, JVM{}, Exporters{}} {
		if err := c.Collect(env, b); err != nil {
			t.Fatalf("%s: %v", c.Name(), err)
		}
	}
	out := text(b)
	for _, want := range []string{
		"nginx_up 1", "nginx_http_requests_total 42", "nginx_connections_active 5",
		`jvm_memory_used_bytes{jvm_memory_type="heap",service_name="payments"} 100`,
		`jvm_memory_limit_bytes{jvm_memory_type="heap",service_name="payments"} 400`,
		`jvm_gc_collection_seconds_total{jvm_gc_name="G1 Young Generation",service_name="payments"} 1.5`,
		`jvm_thread_count{service_name="payments"} 33`,
		`observaone_jvm_up{service_name="payments"} 1`,
		`x_requests_total{exporter="app",path="/a"} 12`,
		`x_lat_bucket{exporter="app",le="+Inf"} 4`,
		`x_temp{exporter="app",room="a \"b\""} 21.5`,
		`observaone_exporter_up{exporter="app"} 1`, `observaone_exporter_up{exporter="bad"} 0`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q", want)
		}
	}
	if strings.Contains(out, `host="evil"`) || strings.Contains(out, `jvm_memory_limit_bytes{jvm_memory_type="non_heap"`) {
		t.Error("exporter labels must not override identity labels; a -1 max is not a limit")
	}
	if notes := strings.Join(env.TakeNotes(), " "); !strings.Contains(notes, "HTTP 302") || strings.Contains(notes, "s3cret") {
		t.Errorf("redirects are not followed, and no password in notes: %s", notes)
	}
	// none configured = disabled, not an error
	env2 := envWith(t, nil)
	for _, c := range []collector.Collector{Nginx{}, JVM{}, Exporters{}, Docker{}} {
		if err := c.Collect(env2, core.NewBatch()); err != collector.ErrNotConfigured {
			t.Errorf("%s without settings: %v", c.Name(), err)
		}
	}
}

func TestDockerCgroupV2(t *testing.T) {
	env := envWith(t, nil)
	dir := filepath.Join(env.Sys, "fs/cgroup/system.slice/docker-abc.scope")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "cpu.stat"), []byte("usage_usec 2500000\nuser_usec 2000000\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "memory.current"), []byte("1000\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "memory.stat"), []byte("anon 600\ninactive_file 300\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "memory.max"), []byte("max\n"), 0o644)
	cpu, mem, ws, limit, err := cgroupStats(env, "abc")
	if err != nil || cpu != 2.5 || mem != 1000 || ws != 700 || limit != 0 {
		t.Fatalf("%v %v %v %v %v", cpu, mem, ws, limit, err)
	}
}

func TestExpositionErrors(t *testing.T) {
	add := func(string, string, string, float64, []string) {}
	for _, bad := range []string{"x{a=b} 1", "x{a=\"b} 1", "1bad 2", "x NaNx"} {
		if _, err := core.ParseExposition(bad, 10, add); err == nil {
			t.Errorf("%q must be refused", bad)
		}
	}
	if _, err := core.ParseExposition(strings.Repeat("x 1\n", 11), 10, add); err == nil {
		t.Error("over the limit must be refused")
	}
}
