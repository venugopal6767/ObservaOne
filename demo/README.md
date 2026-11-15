# ObservaOne demo data (test data only)

A made-up company so every ObservaOne screen can be checked before real servers are connected.
**Remove it before real use.** While it is on, the UI shows a purple **Demo data** chip in the top bar.

## What you get

| Area | Made-up data |
|---|---|
| Servers | 16 Linux (node_exporter + process-exporter + systemd) and 3 Windows (windows_exporter); `dev-app-02` is down |
| Kubernetes | `prod-cluster` (4 nodes), `uat-cluster` (2), `dev-cluster` (2, one node NotReady, a Pending and a Failed pod); kube-state-metrics + cAdvisor; one crash-looping pod |
| Applications | 9 services with OpenTelemetry HTTP metrics (requests, errors, latency) and JVM heap; `inventory` has error/latency spikes every 2 h, `payments-api` ~2.5% errors |
| Databases | PostgreSQL on `prod-db-01`, MySQL on `uat-app-01` |
| VMware | 3 ESXi hosts, 12 VMs, 3 datastores (`ds-dev-hdd-01` almost full) |
| Network devices | `core-sw-01` (one port down), `edge-rtr-01`, `fw-01` over SNMP |
| History | 8 days of metrics, so "compare with yesterday / last week" works at once |
| Logs and traces | 6 hours of past logs and traces, then live: request traces through several services with matching logs (`trace_id=`), server syslogs, Windows events, Kubernetes events |
| Alerts | Rules in `demo/prometheus/rules.yml` (host down, high CPU, disk low, error rate, crash loops, ...) fire into your Alertmanager |

The metric names are the real exporter names, so every ObservaOne page and every PromQL query behaves
exactly as it will with real data.

## Turn it on

Add this line to `.env` (next to `docker-compose.yml`):

```
COMPOSE_FILE=docker-compose.yml:demo/docker-compose.demo.yml
```

then

```bash
docker compose up -d --build
docker compose logs -f demo-seed      # writes 8 days of history (about 3-5 minutes, first time only)
```

Open ObservaOne as usual. The first 5 minutes after start the newest CPU values can look a little high
while live data replaces the written history; that settles by itself.

How it works: a separate `prometheus-demo` container holds the made-up metrics, and the UI is pointed at
it (`PROMETHEUS_URL`). **Your real Prometheus is not touched.** The made-up logs and traces go into your
Loki and Tempo (labelled `job="k8s-pods"`, `"syslog"`, `"windows-eventlog"`, `"kubernetes-events"`).

If you changed the Prometheus address in **Data Sources** in the UI, that saved address wins over the demo;
set it back to `http://prometheus-demo:9090/prometheus` while testing.

## Turn it off and remove it

1. Remove the `COMPOSE_FILE=...` line from `.env`.
2. `docker compose up -d --remove-orphans` (the UI goes back to your real Prometheus; demo containers are removed)
3. `docker volume rm monitoring_demo-prom-data monitoring_demo-state` (the project name may differ: `docker volume ls | grep demo`)
4. Delete the `demo/` folder.

The made-up logs and traces already in Loki and Tempo age out with the normal retention (30 days logs,
7 days traces), or clear those volumes if you want them gone now.

## Options (in `.env`)

| Setting | Default | Meaning |
|---|---|---|
| `DEMO_DAYS` | 8 | days of metric history written at the first start |
| `DEMO_LOG_HOURS` | 6 | hours of past logs and traces pushed at the first start |

To start again from scratch: `docker compose down`, remove the two demo volumes, `docker compose up -d`.
