# ObservaOne Alerting

Status as of 2026-10-20 (branch `react`). Scope: alerts on metrics. Logs and traces are out of scope.

## Architecture: hybrid

ObservaOne does not replace Prometheus or Alertmanager. They are the alerting engine; ObservaOne is the product layer.

```
Linux Agent ──HTTPS──> ObservaOne ingest ──remote write──> Prometheus ──alerts──> Alertmanager ──> Email / Teams / Webhook / Slack / PagerDuty ...
                                                             │  rules: evaluation,            │  grouping, deduplication,
                                                             │  recording rules               │  silences, inhibition, routing
                                                             ▼                                ▼
                                       ObservaOne alerting layer: rule authoring (test first), tenant scoping,
                                       alert list and history, alert -> evidence -> investigation -> action
```

| Layer | Does | Where |
|---|---|---|
| Prometheus | evaluates alert rules every 30 s, keeps Pending / Firing, recording rules | `prometheus/rules/*.yml`, UI rules file (`UI_RULES_FILE`) |
| Alertmanager | groups, deduplicates, silences, inhibits, routes, sends | `alertmanager/alertmanager.yml` |
| ObservaOne | create rules (with a test first), tenant scoping, alert list, history (Pending -> Firing -> Resolved with value, peak, duration), alert details with evidence | `observa-ui/src/alerting.js`, `src/routes/alerting.js`, `web/src/pages/Alerting.tsx`, `AlertDetail.tsx` |

## Lifecycle

| State | Meaning |
|---|---|
| Normal (Prometheus: *inactive*) | the condition is false |
| Pending | the condition is true, but not yet for the rule's `for` duration (e.g. *For: 5m*) |
| Firing | true for the whole `for` duration: Alertmanager sends notifications |
| Resolved | false again (Alertmanager sends "resolved" where the channel has `send_resolved`) |
| Cleared | was Pending, became false before it fired: never notified |

The alert state tracker reads Prometheus' rule evaluation every 15 s and keeps one row per alert episode in
PostgreSQL (`alert_episodes`, migration 12): when it became true, fired, resolved, its last and peak value. Several UI
containers can run; an advisory lock lets one write per round. History is kept 30 days.

## Screens

* **Alerting → All Alerts / Firing / Pending / Resolved**: Severity, Alert Name, State (with Silenced / Muted),
  Host / Resource, Current Value (peak for resolved ones), Duration, Team, Actions (Details, Silence). Filters: text,
  severity, and the time range at the top for resolved alerts (active ones always show).
* **Create alert**: name, PromQL query, threshold (comparison + value), *for* duration, severity, labels, notification
  policy (team), runbook link, message. **Test query** runs it now: "Query is valid – N instances affected" (with the
  matching hosts) or the parse error. Nothing is created until *Create alert*.
* **Alert details** (`/alerting/alert/<id>`): state, host, current value, threshold, started, duration, *for*, team;
  tabs Overview, Metric Graph (the rule's value for this alert's series with the threshold line, from 1 h before it
  started), History (earlier episodes of the same alert), Labels, Annotations; on the right the server now (CPU, top
  processes) and the next steps: Open Metrics, Open Host, Investigate, Runbook.
* Rules, Silences and Notifications stay as tabs of the same page.

## Rules shipped

| Rule | Severity | Condition |
|---|---|---|
| ServerDown | critical | a scraped server's `up == 0` for 2 m |
| AgentNotReporting | critical | an ObservaOne Agent seen in the last 24 h sent nothing for 3 m |
| LinuxHighCPU / WindowsHighCPU | warning | CPU (1 - idle / total) > 90% for 10 m |
| LinuxHighMemory / WindowsHighMemory | warning | memory in use > 90% for 10 m |
| LinuxDiskSpaceLow / Critical, Windows… | warning / critical | free space < 20% / < 10% for 10 m |
| HostDiskWillFillIn24h | warning | the 6 h trend says the disk is full within 24 h (disks already under 30% free) |
| WindowsNetworkErrors, AgentSendFailures, AgentQueueFilling, stack health | warning | see `prometheus/rules/` |

Recording rules (`prometheus/rules/recording.yml`) give one series per server for CPU, memory and disk usage
(`observaone:host_cpu_usage:percent`, `observaone:host_memory_usage:percent`, `observaone:host_disk_usage:percent`)
with the same definitions as every ObservaOne screen (docs/metrics/METRICS.md), labels host, env, role, tenant.
New rules can use them: `observaone:host_cpu_usage:percent > 85`.

## Grouping, routing, muting

* **Grouping** by `alertname`, `severity`, `env`: 100 servers with high CPU in prod = 1 notification listing them
  (was `alertname, host`: one per server). Verified in the lab: 10 servers with AgentNotReporting -> 1 group.
* **Routing** on labels, first match wins: `team="infra"` -> infra-team, `team="ops"` -> ops-team, critical in prod
  -> platform-team every hour, everything else -> platform-team. Rules created in ObservaOne set `team` from the
  *Notification policy* field and any labels you add (e.g. `service`, `env`). Fill the receivers' channels in
  `alertmanager/alertmanager.yml` (email, `msteamsv2_configs` for Teams, webhook, Slack, PagerDuty ...).
* **Inhibition**: ServerDown or AgentNotReporting mutes that host's warnings (matched on `host`; it was `instance`,
  which agent-pushed hosts do not have, so it never matched them). A critical disk alert mutes the warning and the
  forecast for the same disk.

## Tenants

* A tenant user's rule is stored with its query scoped (`tenant="<id>"` added to every selector) and a `tenant`
  label: it only ever sees that tenant's servers, and its alerts only show to that tenant (and the platform).
* Alert list, details, counts and Alertmanager alerts: a tenant sees only alerts carrying its tenant label; another
  tenant's alert answers 404. The platform rules keep the `tenant` label of the series they alert on, so a tenant
  also sees platform alerts about its own servers.
* Silences: a tenant's silence always carries its tenant matcher (a `tenant` it types is replaced); it lists and ends
  only its own.
* Not yet per tenant: Alertmanager receivers (routing per tenant needs a route per tenant label).

## Runbooks

### High CPU
1. Open the alert: the graph shows when it started; *Top processes now* shows who uses it.
2. A single process: check its own dashboards / logs; restart or scale it if it is stuck.
3. Everything busy: compare with yesterday (host view → CPU → *Compare: yesterday*); it may be load, not a fault.

### Disk will fill
1. Open the host view → Disk: which mount, how fast.
2. Clean up (old logs, caches, core dumps) or extend the volume before the *Disk space low* alerts fire.

## Tests

| Suite | What | Result (lab, 2026-10-20) |
|---|---|---|
| `tests/alerting.test.js` | alert identity, threshold parsing, rule expressions, units, rows (state, duration, value) | 5 / 5 |
| `tests/alerting-api.test.js` (needs `OBSERVA_TEST_URL`) | test query (valid / parse error / range vector refused), rule with team + labels + runbook, tenant rule scoped and labelled, tenant cannot see or open platform alerts, tenant silences, per-state lists and details | 6 / 6 |
| `tests/metrics-consistency.test.js` | ran with the rest (94 tests: 92 pass, 1 skip) | the process-share check failed once while the lab agent was cut off and catching up; passed on rerun, not reproduced: watch it |
| Lab, live | HighCPU created from the form → Pending → Firing → Resolved after the rule was removed (peak 68.9%, fired 2 m 34 s); grouping 10 servers → 1 notification; `team=infra` → infra-team | pass |

## Next

* Acknowledge / owner / notes on alerts, MTTA and MTTR per team.
* Threshold layers per environment / target / host (like agent settings).
* Maintenance windows (scheduled silences) from the Agents page and host view.
* Receivers per tenant; SLO burn-rate alerts; dead-man's switch (Watchdog to an external check).
