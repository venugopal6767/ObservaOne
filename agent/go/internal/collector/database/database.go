// Package database collects DB metrics by scraping a Prometheus exporter per target and
// forwarding the result, labelled with db_engine and db_instance. It plugs into the agent
// core through the same collector.Collector interface as the Linux collectors, so enrolment,
// heartbeat, buffering and upload are unchanged.
//
// "Based on the DB selection" = each target names an engine (postgres|mysql|mssql|oracle);
// the engine chooses which exporter the agent scrapes and the db_engine label it stamps, so
// the UI can show the right metrics per engine. Exporters (postgres_exporter, mysqld_exporter,
// sql_exporter for MSSQL, oracledb_exporter) run agentless/multi-target and connect to the DBs.
package database

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"observaone/agent/internal/collector"
	"observaone/agent/internal/core"
)

var engines = map[string]bool{"postgres": true, "mysql": true, "mssql": true, "oracle": true, "redis": true, "kafka": true, "mongodb": true, "memcached": true}

var httpClient = &http.Client{
	Timeout:       6 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	Transport:     &http.Transport{Proxy: nil, MaxIdleConns: 4, IdleConnTimeout: 60 * time.Second},
}

// Database is the collector. One instance handles every configured DB target.
type Database struct{}

// New returns the collector.
func New() *Database { return &Database{} }

// Name implements collector.Collector.
func (Database) Name() string { return "database" }

type target struct{ name, engine, url string }

// targets reads Cfg.Databases (name -> "engine|exporterURL").
func targets(env *collector.Env) []target {
	if env.Cfg == nil {
		return nil
	}
	var out []target
	for name, spec := range env.Cfg.Databases {
		engine, u := spec, ""
		if i := strings.Index(spec, "|"); i >= 0 {
			engine, u = strings.TrimSpace(spec[:i]), strings.TrimSpace(spec[i+1:])
		}
		out = append(out, target{name: name, engine: strings.ToLower(strings.TrimSpace(engine)), url: u})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out
}

// Collect scrapes each target's exporter and forwards its metrics. A bad target is noted and
// reported as observaone_db_up=0, but never fails the whole round (one DB must not hide the rest).
func (d Database) Collect(env *collector.Env, b *core.Batch) error {
	ts := targets(env)
	if len(ts) == 0 {
		return collector.ErrNotConfigured
	}
	for _, t := range ts {
		up := 0.0
		switch {
		case !engines[t.engine]:
			env.Note(fmt.Sprintf("database %q: unknown engine %q", t.name, t.engine))
		case t.url == "":
			env.Note(fmt.Sprintf("database %q: no exporter URL", t.name))
		default:
			if err := scrape(t, b); err != nil {
				env.Note(fmt.Sprintf("database %q (%s): %v", t.name, t.engine, err))
			} else {
				up = 1
			}
		}
		b.Add("observaone_db_up", core.Gauge, "1 if the database exporter was scraped successfully.", up,
			"db_engine", t.engine, "db_instance", t.name)
	}
	return nil
}

func scrape(t target, b *core.Batch) error {
	req, err := http.NewRequest(http.MethodGet, t.url, nil)
	if err != nil {
		return err
	}
	if u, _ := url.Parse(t.url); u != nil && u.User != nil {
		p, _ := u.User.Password()
		req.SetBasicAuth(u.User.Username(), p)
	}
	req.Header.Set("User-Agent", "ObservaOne-Agent")
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20)) // 4 MiB cap
	if err != nil {
		return err
	}
	_, err = core.ParseExposition(string(body), 20000, func(name, typ, help string, value float64, labels []string) {
		ext := append(append([]string{}, labels...), "db_engine", t.engine, "db_instance", t.name)
		b.Add(name, typ, help, value, ext...)
	})
	return err
}
