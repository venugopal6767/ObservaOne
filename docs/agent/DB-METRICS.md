# Database metrics agent (Go + exporters)

A DB-monitoring path built the **same way as the Linux agent**: a Go collector
(`internal/collector/database`) that plugs into the agent core (enrol/heartbeat/config/
upload) and, **based on the selected engine**, scrapes the matching Prometheus **exporter**
and forwards its metrics labelled `db_engine` + `db_instance`. Metrics-only, agentless/
multi-target (the exporter connects to the DBs; the agent just scrapes + forwards).

> ⚠️ The Go code is written to match the existing agent patterns but was **NOT compiled or
> tested in this environment** (no Go toolchain here). Run `go build ./... && go test ./...`
> in WSL. Added: `internal/collector/database/{database.go,database_test.go}`, a `Databases`
> config field, and wiring in `cmd/observaone-agent/main.go`.

## Exporter per engine (run these agentless, multi-target)
| Engine  | Exporter |
|---------|----------|
| postgres | `prometheuscommunity/postgres_exporter` |
| mysql    | `prometheus/mysqld_exporter` |
| mssql    | `burningalchemist/sql_exporter` (MSSQL config) |
| oracle   | `oracle/oracle-db-exporter` (oracledb_exporter) |

Give each exporter a **read-only** DB user. In multi-target mode one exporter can scrape
many instances (your team's preference over sidecars).

## Configure DB targets (agent settings)
Each target is `databases.<instance> = <engine>|<exporter-/metrics-URL>`:
```
databases.prod-core   = postgres|http://127.0.0.1:9187/metrics
databases.billing-my  = mysql|http://127.0.0.1:9104/metrics
databases.dwh-ora      = oracle|http://127.0.0.1:9161/metrics
```
The agent scrapes each, stamps `db_engine`/`db_instance`, and adds `observaone_db_up` per
target. The engine label is what drives per-engine dashboards in the UI.

## Run it as a "separate" DB agent
Install the agent on a collector host and configure only `databases.*` (optionally
`disable=cpu,memory,filesystem,...` to skip host metrics). It enrols, heartbeats and
uploads like any agent, but only reports DB metrics.

## Windows (next, same approach)
Assumption (you didn't specify): build Windows the **same way** — a native Go collector
`internal/collector/windows` mirroring `internal/collector/linux` (perf counters via
golang.org/x/sys/windows or gopsutil). Not started yet; say the word (or if you'd rather
use `windows_exporter`, I'll wire that instead).
