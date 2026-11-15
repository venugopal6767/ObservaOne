package database

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"observaone/agent/internal/collector"
	"observaone/agent/internal/core"
)

func TestCollectForwardsWithEngineLabels(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("# TYPE pg_up gauge\npg_up 1\n# TYPE pg_stat_database_blks_hit counter\npg_stat_database_blks_hit{datname=\"app\"} 42\n"))
	}))
	defer srv.Close()

	cfg := core.Defaults()
	cfg.Databases["prod-pg"] = "postgres|" + srv.URL
	b := core.NewBatch()
	if err := (Database{}).Collect(&collector.Env{Cfg: cfg}, b); err != nil {
		t.Fatalf("collect: %v", err)
	}
	out := b.Text(0)
	for _, want := range []string{`db_engine="postgres"`, `db_instance="prod-pg"`, "observaone_db_up", "pg_stat_database_blks_hit", `datname="app"`} {
		if !strings.Contains(out, want) {
			t.Errorf("want %q in output:\n%s", want, out)
		}
	}
}

func TestNoTargetsIsNotConfigured(t *testing.T) {
	if err := (Database{}).Collect(&collector.Env{Cfg: core.Defaults()}, core.NewBatch()); err != collector.ErrNotConfigured {
		t.Fatalf("want ErrNotConfigured, got %v", err)
	}
}

func TestBadTargetReportsDownButDoesNotFail(t *testing.T) {
	cfg := core.Defaults()
	cfg.Databases["dead"] = "mysql|http://127.0.0.1:1/metrics"
	b := core.NewBatch()
	if err := (Database{}).Collect(&collector.Env{Cfg: cfg}, b); err != nil {
		t.Fatalf("a dead target must not fail the round: %v", err)
	}
	if !strings.Contains(b.Text(0), "observaone_db_up") {
		t.Error("expected observaone_db_up for the dead target")
	}
}
