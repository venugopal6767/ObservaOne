# ObservaOne Metrics: definitions, audit and validation

Status as of 2026-10-19 (branch `react`). Scope: the Metrics product only (Prometheus backend, ObservaOne UI and API,
ObservaOne Agent). Logs and traces are out of scope.

## 1. Metric definitions (one definition, every screen)

Every screen that shows a server metric (Metrics Overview, Infrastructure, host view, Metrics Explorer and Ask,
Investigation, Agents list, alert wizard) uses the definitions below. Server side: `observa-ui/src/queries.js`. UI
side: `observa-ui/web/src/lib/catalog.ts` (`cpuPerHost`, `memPerHost`, `diskPerHost`, `netPerHost`). Tests keep the
two equal (`tests/metrics-consistency.test.js`).

| Metric | Definition | Unit | Source series |
|---|---|---|---|
| CPU usage | `1 - idle time / total time` over 5 min, per server; the ObservaOne Go agent's own value (`observaone_cpu_utilization_ratio`, its last collection) when present | % of all cores (0-100) | `observaone_cpu_utilization_ratio`, `node_cpu_seconds_total`, `windows_cpu_time_total{core!=""}` |
| Memory usage | `1 - available / total` | % of physical memory | `node_memory_MemAvailable_bytes / MemTotal`, `windows_memory_available_bytes / physical_total` |
| Disk usage | space used on the **fullest** filesystem of the server (pseudo filesystems excluded) | % | `node_filesystem_avail/size_bytes`, `windows_logical_disk_free/size_bytes` |
| Lowest disk free (Infrastructure) | `100 - Disk usage` | % | same |
| Network traffic | bytes received + sent per second, physical interfaces only | bytes/s | `node_network_{receive,transmit}_bytes_total`, `windows_net_bytes_total` |
| Process CPU | CPU used by the process **as a share of the whole server**, like host CPU (100% = every core busy); the table also shows **cores used** (1.0 = one core fully busy) | % of server, cores | `namedprocess_namegroup_cpu_seconds_total`, `windows_process_cpu_time_total` / number of cores |
| CPU by core | `1 - idle / total` per core | % of that core | as CPU |

Rules applied to all of them:

1. **Ratio, not `100 - rate(idle)`.** `100 - rate(idle[5m])` assumes the counter covers the whole 5-minute window. For
   5 minutes after any gap (new host, agent restart, network outage, Prometheus restart) it reads far too high (seen:
   +20 to +83 points). Idle divided by total cancels that out and is right from the second sample.
2. **Freshness.** Pushed series get no stale marker when an agent stops. A value needs a sample from the last 120 s,
   otherwise the server has no value: charts show a gap and tiles show "-", never the last value repeated.
3. **One value per server first, then combined.** Each server is reduced to one value (labels `host`, `env`, `role`),
   then combined (average, max, ...) across servers, Linux and Windows together.
4. **Errors are errors.** A failed query shows an error, never "no data", "0" or "healthy".

## 2. Audit (2026-10-19)

Method: code inspection of every metrics path (agent -> intake -> Prometheus -> API -> UI), the PromQL behind each
screen evaluated side by side against the lab Prometheus, access checks with two tenants, existing test suites run.

| # | Severity | Finding | Evidence | Status |
|---|---|---|---|---|
| 1 | P0 | Two CPU formulas: Infrastructure / Agents used the ratio; Metrics Overview, Explorer, host view, Investigation, Ask used `100 - rate(idle)` | Same instant: +20 to +83 points on every Linux host after a Prometheus restart; real VM: `top` 2%, Infrastructure 4.9%, Explorer 88%. Old formula still +4 to +9 points 150 s after a series starts | Fixed |
| 2 | P0 | "Disk usage" averaged all filesystems of a server, while the definition says the fullest | Real VM 150 s after stop: old 82.5% (average), fullest 91.9% | Fixed |
| 3 | P0 | Process CPU was % of one core, shown as "CPU %" next to host CPU and coloured with host thresholds | `java 277.7%` (red) on a server at 91% | Fixed: % of server + cores |
| 4 | P0 | Custom dashboards had no tenant: any tenant could list, read, change and delete another tenant's dashboards | `tests/metrics-access.test.js` fails 2 checks on the old code | Fixed (migration 11) |
| 5 | P1 | Metric-name caches shared by all tenants, bypassing query scoping | Same test fails on the old code | Fixed |
| 6 | P1 | Memory / disk / CPU kept the last value up to 5 min after a pushed agent stopped | Real VM 150 s after stop: old CPU 64.9%, memory 15.2%; new: no value | Fixed |
| 7 | P1 | Query errors shown as "no data" or "healthy" (Investigation processes, Overview host health) | `.catch(() => [])` | Fixed |
| 8 | P1 | `LinuxHighCPU` / `WindowsHighCPU` alert rules used `100 - rate(idle)` (`for: 10m` limited the damage) | rule files | Fixed |
| 9 | P2 | Uptime under an hour printed as `772.09s` | host view | Fixed (`12m 52s`) |
| - | - | Investigation "No process data" for a host with processes | Not a defect: the data started after the investigated moment | Message clarified |

Not defects / known gaps (recorded, not changed):

* `/prom/query` is open to every signed-in user of the default tenant (read-only proxy, by design); users of other
  tenants are scoped (every selector gets `tenant="..."`; unreadable queries are refused).
* Dashboards have `visibility` and `team_id` columns that nothing uses yet.
* Logs, traces and Alertmanager alerts are not tenant-scoped; Prometheus queried directly is not scoped.
* The Go agent's CPU value covers its last collection (30 s) while the counter formula covers 5 min: both are shown
  as the same metric; short spikes are therefore visible for Go-agent hosts.

## 3. Tests

| Suite | What | Result (lab, 2026-10-19) |
|---|---|---|
| `tests/catalog.test.js` (unit) | CPU ratio, freshness, fullest disk, Linux + Windows combined, filters, process share | 7 / 7 |
| `tests/metrics-consistency.test.js` (needs `OBSERVA_TEST_PROM`) | UI definition = server value for every host (CPU, memory, disk); CPU right 150 s after a series starts; process shares never above 100% | 5 / 5 |
| `tests/metrics-access.test.js` (needs `OBSERVA_TEST_URL`, admin password) | dashboards per tenant (list, read, change, delete), per-tenant metric names, scoped PromQL / label values / targets, signed-out refused | 6 / 6 (old code: 3 fail) |
| whole server suite `npm test` with the lab | all of the above + existing tests | 80 pass, 0 fail, 1 skipped (needs a viewer password) |

Run: `cd observa-ui && OBSERVA_TEST_URL=http://127.0.0.1:8083 OBSERVA_TEST_ADMIN_PASSWORD=... OBSERVA_TEST_PROM=http://127.0.0.1:9090/prometheus npm test`
(Node 22.6+; the UI definitions are TypeScript and run with `--experimental-strip-types`).

Environment: the results above come from the lab (Prometheus 3.5, the demo generator for 18 simulated servers, and
one real Linux VM running ObservaOne Agent 1.3.1). The simulated servers' counters are synthetic; the real-VM rows
are the real-environment evidence.

## 4. Compatibility

* Migration 11 adds `dashboards.tenant_id` (default `t_default`): existing dashboards stay with the platform and keep
  working; rolling back leaves an unused column.
* Process CPU in the host view, Investigation and Explorer changes unit from "% of one core" to "% of server"
  (cores shown next to it). Saved Explorer views using "Top processes by CPU" show the new unit.
* Alert rules: same thresholds, steadier values; a CPU alert no longer fires early after a gap.

## 5. Next (P2 / P3, not started)

* Load test: ingestion throughput (agents x series) and query latency of the Overview / Infrastructure pages with
  hundreds of hosts; no scalability claim is made until measured.
* Network: the Go agent's own computed rates could replace counter rates for Go-agent hosts (same idea as CPU).
* Use or remove the unused dashboard `visibility` / `team_id` columns.
