# ObservaOne Linux Agent (Go agent 1.1)

One small Go binary per Linux server (about 7 MB, about 11 MB of RAM, standard library only). It enrolls once, sends a
heartbeat every 30 s and sends host metrics every 15 s, all over HTTPS to the ObservaOne server. No port is opened
on the monitored server.

Status: **built and tested end to end on Linux in a lab** (see [Test results](#test-results)). Not yet run on a real
cloud VM with real systemd: follow [Testing on a real VM](#testing-on-a-real-vm).

---

## 1. Architecture and data flow

```
 Monitored Linux server                                ObservaOne server (Docker Compose)
 ┌──────────────────────────────┐   HTTPS 443         ┌────────────────────────────────────────────────┐
 │ observaone-agent (systemd,   │  ─────────────────▶ │ Nginx ──▶ ObservaOne UI/API (Node.js)          │
 │ user observaone-agent)       │  enroll (once)      │           │  enroll / heartbeat ──▶ PostgreSQL │
 │  collectors: /proc, /sys     │  heartbeat (30 s)   │           │  metrics: check + relabel          │
 │  buffer (bounded)            │  metrics (15 s,gzip)│           └──▶ Prometheus (remote write)       │
 │  127.0.0.1:9109 diagnostics  │                     │ Agents / Infrastructure / Overview pages read  │
 └──────────────────────────────┘                     │ PostgreSQL + Prometheus                        │
                                                      └────────────────────────────────────────────────┘
```

* **Control plane** (`/api/agent/v1/enroll`, `/api/agent/v1/heartbeat`): identity, status, diagnostics. It is stored in
  PostgreSQL and does not depend on Prometheus.
* **Metrics path** (`/api/agent/v1/metrics`): the agent POSTs the Prometheus text format (gzip). The server
  * checks every line (finite numbers only, at most 20,000 series and 30 labels),
  * sets the identity labels itself from the database (`host`, `agent_id`, `job`, `platform`, `env`, `role`, plus custom labels),
  * corrects a wrong host clock,
  * writes the samples to Prometheus with remote write.
  If Prometheus is down, the agent gets **503**. It keeps the data in its buffer, and heartbeats keep working.
* **Why push and not Prometheus scraping:** the agent must reach the server for enrollment and heartbeats anyway, so
  push adds no new network path. Scraping would need an inbound port on every server, open to the
  Prometheus host, plus TLS and auth on each one. With push, cloud VMs behind NAT need only outbound 443.
* **Metric names follow node_exporter** (`node_cpu_seconds_total`, `node_memory_MemAvailable_bytes`, ...). The existing
  dashboards, Overview and Infrastructure work unchanged. Agent-computed values (rates, ratios) use the `observaone_`
  prefix.

The code is split so other platforms plug in without touching the core:

```
agent/go/
  cmd/observaone-agent/       commands: run, enroll, status, check-config, config show, reload, version
  internal/core/              config (+conf.d, remote settings), identity/credential storage, HTTPS client, backoff,
                              metric batch (refuses NaN/Inf/negative counters), counter-delta rates
  internal/agent/             run loop: collect -> buffer -> upload, heartbeats, reload, status file, local /metrics
  internal/collector/         Collector interface (shared by every platform)
  internal/collector/linux/   cpu, memory, load, uptime, filesystem, disk, network, system, agent
```

## 2. Supported systems

| | Tested | Expected to work (not tested yet) |
|---|---|---|
| OS | Ubuntu 24.04 (lab, without systemd: service actions simulated) | Ubuntu 20.04+, Debian 11+, RHEL/Rocky/Alma 8+, Amazon Linux 2/2023, SUSE 15 |
| CPU | amd64 | arm64 (binary built, not run) |
| Init | - | systemd (required by the installer) |

Windows, Docker and Kubernetes still use the previous-generation agent (OpenTelemetry Collector). The Agents page
marks them **Previous agent**.

## 3. Network, firewall, TLS

| From | To | Port | Why |
|---|---|---|---|
| Monitored server | ObservaOne server | **TCP 443** (HTTPS) | enrollment, heartbeats, metrics, installer download |
| - | Monitored server | **none** | the agent opens no inbound port (diagnostics are on 127.0.0.1:9109 only) |

* `server` must be the address of the ObservaOne server **as the monitored server reaches it**. Never `localhost`:
  the agent refuses it.
* ObservaOne on a laptop or WSL is not reachable from a cloud VM. Run ObservaOne on a server the VMs can reach (e.g. an
  EC2 instance), or publish it through a tunnel or reverse proxy.
* **TLS is always verified.** There is no "insecure" option.
  * **Self-signed certificate (default setup):** the install command carries its SHA-256 fingerprint. The installer
    downloads the certificate, accepts it only if the fingerprint matches, and stores it as
    `/etc/observaone-agent/ca.crt`. From then on the agent trusts only that certificate.
  * **Company CA:** pass `--ca-file`.
  * **Public certificate (Let's Encrypt):** nothing to pass.
  * A wrong, expired or different certificate stops the agent with a clear TLS error.
* **AWS example:** the ObservaOne server's security group allows inbound 443 from the monitored VMs (and from you). The
  monitored VMs need outbound 443 (the default) and no inbound rule.

## 4. Install and enroll

1. In ObservaOne go to **Agents → Linux → Install** and **Create a token**. Pick its validity and how many servers may
   enroll with it ("Once" for a single server). The token is shown once; only its SHA-256 is stored.
2. On the server, run the two lines shown on the page:

   ```bash
   curl -fsSL https://observaone.example.com/agent/install.sh -o observaone-install.sh
   sudo bash observaone-install.sh --server https://observaone.example.com --ca-sha256 <FINGERPRINT> --env prod --role web --label team=payments
   ```

3. Paste the token when asked. What you type is hidden, so it never reaches shell history or the process list.

What the installer does:
* checks systemd, CPU type, free space, and HTTPS reachability with a verified certificate;
* downloads `observaone-agent-linux-<arch>` and checks it against `SHA256SUMS`;
* creates the system user `observaone-agent` and the folders `/etc/observaone-agent` (0750) and `/var/lib/observaone-agent` (0750);
* writes `agent.conf` (first time only; later runs change only the options you pass and keep your edits);
* enrolls as the agent user: the token is exchanged for the agent's own credential (`/var/lib/observaone-agent/credential`,
  0600), then the token file is deleted;
* installs and starts the hardened systemd unit and waits for the first heartbeat.

Automation (Ansible, cloud-init): write the token to a root-only file and pass `--token-file /path/to/file`. The installer
deletes it after use. In cloud-init, keep the token in your secrets store, not in plain user-data.

**Copy-and-paste caution:** the token is visible on screen while you paste it and sits in your clipboard. Use one-time
or short-lived tokens, and revoke any token that leaked. Revoking only stops new enrollments.

## 5. Configuration (externalised; you can change it)

Files are read in this order. Later wins, and the host always has the final say:

1. built-in defaults
2. settings sent by the ObservaOne server in the heartbeat answer (only: `collect_interval`, `heartbeat_interval`,
   `disable`, `buffer_payloads`, `env`, `role`, `label.*`; saved in `/var/lib/observaone-agent/server-settings.json`).
   The agent supports this already; the server-side screen to set them is the next step, so today this layer is empty.
3. `/etc/observaone-agent/agent.conf`
4. `/etc/observaone-agent/conf.d/*.conf` (name order)

The server can never change `server`, `ca_file`, paths or `listen`, and it can never run commands on the host.

| Setting | Default | Meaning |
|---|---|---|
| `server` | (required) | `https://` address of ObservaOne as this server reaches it |
| `ca_file` | system trust | CA / self-signed certificate to trust (the installer sets it) |
| `env`, `role` | empty | labels on every metric |
| `label.<name>` | - | up to 10 extra labels; names `a-z0-9_`, values `A-Za-z0-9._-` |
| `hostname` | short host name | name requested at enrollment (the server may add `-2` if it is taken) |
| `collect_interval` | `15s` | 5s - 5m |
| `heartbeat_interval` | server's value (30s) | 5s - 5m |
| `disable` | - | collectors to turn off: `cpu,memory,load,uptime,filesystem,disk,network,system,agent` |
| `buffer_payloads` | `40` | collections kept while the server is unreachable (40 × 15 s = 10 min); oldest dropped first |
| `listen` | `127.0.0.1:9109` | local diagnostics (`/metrics`, `/healthz`); loopback only; empty = off |
| `state_dir` | `/var/lib/observaone-agent` | identity, credential, status |
| `proc_path`, `sys_path`, `root_path` | `/proc`, `/sys`, `/` | for running in a container against the host |
| `config_version` | `1` | a file written for a newer agent is refused |

Change, check, apply without a restart:

```bash
sudo nano /etc/observaone-agent/conf.d/20-mine.conf    # e.g.  collect_interval = 30s
sudo observaone-agent check-config                      # validates; nothing is applied
sudo systemctl reload observaone-agent                  # an invalid file is refused; the agent keeps its old settings
sudo observaone-agent config show                       # every setting, its value and where it came from
```

## 6. Service operations

```bash
sudo systemctl status observaone-agent        # service state
sudo observaone-agent status                  # last heartbeat, last upload, buffer, collector states, last error
journalctl -u observaone-agent -f             # JSON logs (never contain tokens or credentials)
sudo systemctl restart | stop | start observaone-agent
curl -s http://127.0.0.1:9109/metrics         # what the agent collected last
```

The unit runs as `observaone-agent` (not root). It sets `NoNewPrivileges`, `ProtectSystem=strict`, write access only
to `/var/lib/observaone-agent`, `MemoryMax=128M` and `CPUQuota=25%`, and uses `Restart=on-failure` and
`ExecReload` (SIGHUP).

## 7. Metrics

Collected every `collect_interval` from `/proc` and `/sys`. A value the host does not provide, or that cannot be read
(permission, missing file, hung mount), is **left out**, never sent as 0. A collector that fails sends nothing for that
round and reports `error` or `unavailable` in the heartbeat. Rates come from counter deltas over elapsed time. A counter
that goes down (reset, reboot, device re-attached) gives no rate for that round, so there are no spikes and no negative
rates. A reboot is detected from the boot time and resets all rates.

| Area | Metrics (type) |
|---|---|
| CPU | `node_cpu_seconds_total{cpu,mode}` (counter), `observaone_cpu_utilization_ratio` (gauge 0-1), `observaone_cpu_count`, `node_context_switches_total`, `node_procs_running` |
| Memory | `node_memory_{MemTotal,MemFree,MemAvailable,Buffers,Cached,SwapTotal,SwapFree,Shmem,SReclaimable,Dirty,Active,Inactive}_bytes`, `observaone_memory_used_bytes`, `observaone_memory_utilization_ratio` |
| Filesystems | `node_filesystem_{size,free,avail}_bytes`, `node_filesystem_files{,_free}`, `node_filesystem_readonly`, `node_filesystem_device_error`, `observaone_filesystem_utilization_ratio` (= df Use%) - labels `device, fstype, mountpoint`; pseudo, overlay and FUSE filesystems skipped; max 100 mounts; 2 s timeout per mount |
| Disks | `node_disk_{reads,writes}_completed_total`, `node_disk_{read,written}_bytes_total`, `node_disk_{read,write}_time_seconds_total`, `node_disk_io_time_seconds_total`, `node_disk_io_now`, `observaone_disk_{read,write}_bytes_per_second`, `observaone_disk_{reads,writes}_per_second`, `observaone_disk_busy_ratio` - whole disks only (no partitions, loop, ram); max 64 |
| Network | `node_network_{receive,transmit}_{bytes,packets,errs,drop}_total`, `node_network_up`, `observaone_network_{receive,transmit}_bytes_per_second` - `lo` and container/bridge interfaces skipped; max 32 |
| Load / time | `node_load1`, `node_load5`, `node_load15`, `node_boot_time_seconds`, `observaone_uptime_seconds`, `node_time_seconds` |
| System | `node_uname_info{sysname,release,machine,nodename}`, `node_os_info{id,name,pretty_name,version_id,version_codename}` |
| Agent itself | `observaone_agent_info{version}`, `observaone_agent_collector_success{collector}`, `observaone_agent_collector_duration_seconds{collector}`, `observaone_agent_upload_failures_total`, `observaone_agent_buffered_payloads`, `observaone_agent_dropped_payloads_total`, `process_resident_memory_bytes`, `process_cpu_seconds_total`, `go_goroutines` |
| Added by the server | `up{job="linux",agent="observaone"} = 1` for every accepted upload; labels `host, agent_id, job, platform, agent, os, env, role` + custom labels |

There are no per-process labels and nothing from environment variables, command lines or file contents. A typical server
has about 200 series.

## 8. Agent status

Every time is the **server's** time of receipt; the agent's clock is never used. Thresholds are set on the server in `.env`.

| Status | Rule | Meaning |
|---|---|---|
| **Waiting for first heartbeat** | enrolled, no heartbeat yet | just installed, or it never started |
| **Online** | heartbeat within `AGENT_ONLINE_SECONDS` (150 s) and no problem | |
| **Needs attention** | online, but a real problem: a collector failing, uploads failing, an unsupported version (`AGENT_MIN_VERSION`), heartbeats arriving but no metrics | the agent runs; something needs a look |
| **Not reporting** | no heartbeat for more than 150 s | the agent or the network stopped. **The host may still be up.** Last-seen time shown. |
| **Offline** | no heartbeat for more than `AGENT_OFFLINE_SECONDS` (900 s) | |
| **Blocked** | blocked by an admin | heartbeats and uploads refused (403) |
| (no row) | never enrolled | nothing is invented |

One missed heartbeat never changes the status: 150 s is 5 heartbeats. Previous-generation agents have no heartbeat
and are judged by their last upload.

## 9. Tokens and security

* **Enrollment token** (`oat_…`): created by an admin (`integrations.manage`) with a validity and a maximum number of
  uses. Only its SHA-256 is stored. Expired, revoked or used-up tokens are refused.
* **Agent credential** (`oac_…`): one per agent, issued at enrollment, stored on the host (0600) and as a SHA-256 on the
  server. The agent's identity comes from this credential, never from what the agent says. An agent therefore cannot
  claim another agent's ID, and the `host` label on its metrics is set by the server.
* **Revoking a token** stops new enrollments only. To cut off an enrolled agent, **Block** it (immediate) or **Remove** it
  (deletes the credential).
* **Duplicate host names:** the second machine is shown as `name-2`; nothing is overwritten. The same machine
  re-enrolling after an uninstall gets its old record back (matched by a salted hash of `/etc/machine-id`), but never while
  that record is online.
* **Limits:**
  * 10 failed enrollments per address per 10 min, and 300 enrollments in total, so a fleet behind one NAT address can enroll together;
  * request bodies: enroll and heartbeat 8 kB, metrics 4 MB;
  * at most one heartbeat write per agent every 5 s (a burst is answered but not written).
* **Audit log:** `agent.token.create`, `agent.token.revoke`, `agent.enroll`, `agent.reenroll`, `agent.enroll.denied`,
  `agent.enroll.rate_limited`, `agent.first_heartbeat`, `agent.heartbeat.denied`, `agent.block`, `agent.unblock`,
  `agent.remove`, `agent.impersonation_refused`.
* **Retries:** exponential backoff with jitter (2 s up to 2 min) and the server's `Retry-After`. A fleet never retries in
  lockstep, and the buffer is bounded, so a long outage loses the oldest data, not memory.

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| Installer: "Cannot reach … over HTTPS" | DNS, security group (inbound 443 on the ObservaOne server), `--ca-sha256` value |
| `curl: (90) public key does not match pinned public key` right after the certificate was replaced | the UI still shows the old certificate (it mounts the file, and a replaced file is not seen): `docker compose up -d --force-recreate observa nginx`, reload the Agents page, copy the command again |
| Installer: "fingerprint does not match" | you are not talking to your server, or it has a new certificate: copy the new command from the Agents page |
| `token_expired` / `token_revoked` / `token_used_up` | create a new token |
| Agent **Not reporting** | `sudo observaone-agent status`; `journalctl -u observaone-agent -n 50`; outbound 443 open? |
| Agent **Needs attention** | the Agents page detail lists the problem; collectors `unavailable` (permission) are informational |
| Heartbeats OK, no metrics | Prometheus down or remote-write receiver off (`--web.enable-remote-write-receiver`); Data Sources page |
| TLS error in the log | certificate changed or expired: re-run the installer with the new `--ca-sha256` |
| Credential refused (401) | the agent was removed in ObservaOne: `sudo rm /var/lib/observaone-agent/{credential,identity.json}` and re-run the installer with a new token |
| Same server counted twice | it is also in `prometheus/targets/linux*.yml`: remove it there once the agent is installed |

## 11. Upgrade, rollback, uninstall

* **Upgrade:** run the same two install lines again. The identity and your settings are kept. The previous binary is
  kept as `/opt/observaone-agent/bin/observaone-agent.prev`. If the new one does not send a heartbeat within 45 s, the
  installer **rolls back automatically**.
* **Manual rollback:**
  `sudo mv /opt/observaone-agent/bin/observaone-agent.prev /opt/observaone-agent/bin/observaone-agent && sudo systemctl restart observaone-agent`
* **Uninstall:** `sudo bash observaone-install.sh --uninstall`. This stops and removes the service, `/opt/observaone-agent`,
  `/etc/observaone-agent`, `/var/lib/observaone-agent` and the `observaone-agent` user, and nothing else. Then remove the
  agent on the Agents page.
* **Previous-generation Linux agent** (otelcol + node_exporter): the installer replaces it. It stops
  `observaone-node-exporter` and removes the old binaries, config and token.
* **Server side:** `docker compose up -d --build`. The `agent-build` service compiles the agent (Go 1.24 image) into
  `agent/files/` before Nginx starts. Database migration 5 only adds columns and indexes, so going back to the
  previous version is safe; the new columns are simply ignored.

## 12. Testing on a real VM

On the monitored VM, after installing:

```bash
curl -fsSL https://observaone.example.com/agent/test/vm-check.sh -o vm-check.sh   # or copy agent/test/vm-check.sh
sudo bash vm-check.sh               # service, user, permissions, secrets, numbers vs free/df/uptime/proc, restart,
                                    # config reload, 70-second network cut with iptables
sudo reboot
sudo bash vm-check.sh --reboot-check
```

Paste the output back. On the ObservaOne server, `agent/test/scenarios.sh` runs the server-side scenario suite
(see the header of the script).

## Test results

Re-run on 2026-10-18 after merging into `react` (React Agents screens): scenarios.sh 41 PASS / 0 FAIL, server tests 40/40,
Go tests pass, Agents and Metrics UI checks pass. S46/S67/S73 still need a real VM (see above).

Run on 2026-10-11 in a Linux lab: Ubuntu 24.04, PostgreSQL 16, Prometheus 3.5 (remote-write receiver), Nginx with a
self-signed TLS certificate, the ObservaOne app from this branch, and the agent installed by `install.sh`. systemd is not
available in the lab, so a stand-in started and stopped the unit's command; everything else is real.

| ID | Scenario | Result | How |
|---|---|---|---|
| S01 | valid token enrolls | PASS | scenarios.sh |
| S02 | invalid token rejected (401) | PASS | scenarios.sh |
| S03 | expired token rejected | PASS | scenarios.sh |
| S04 | revoked token rejected | PASS | scenarios.sh |
| S05 | one-time token cannot be reused | PASS | scenarios.sh |
| S06 | 8 concurrent enrollments on a 3-use token → exactly 3 | PASS | scenarios.sh |
| S07 | reinstall / restart keeps identity | PASS | installer re-run + vm-check.sh |
| S08 | duplicate host name → `name-2`, nothing overwritten | PASS | scenarios.sh |
| S09 | missing/invalid config fails with a clear error | PASS | Go unit tests (9 cases) |
| S10 | viewer cannot create/revoke tokens (403); signed out 401 | PASS | scenarios.sh |
| S11 | forged credential 401; other agent's ID ignored; metric `host` set by server | PASS | scenarios.sh |
| S12 | 7 malformed enrollments → 400 | PASS | scenarios.sh |
| S13 | failed enrollments rate-limited (429 after 10) | PASS | scenarios.sh |
| S14 | no token/credential in server, agent, proxy logs | PASS | scenarios.sh |
| S15/16 | untrusted certificate refused, no fallback | PASS | scenarios.sh + Go client (no insecure option exists) |
| S17/18 | Online after heartbeat; heartbeats continue | PASS | scenarios.sh |
| S19 | stopped → Not reporting, then Offline | PASS | scenarios.sh (thresholds 20 s / 60 s) |
| S20 | restart → Online, same identity, one row | PASS | scenarios.sh |
| S21/22 | network cut (iptables) → buffer; recovery → catch-up | PASS | vm-check.sh |
| S23 | last heartbeat never moves backwards | PASS | scenarios.sh (server time, GREATEST) |
| S24 | invalid heartbeat credential 401 | PASS | scenarios.sh |
| S25 | app restart keeps identities | PASS | app restarted several times during tests |
| S26 | PostgreSQL unavailable → 503, no corruption, recovers | PASS | happened for real (~10 min): app answered 503, agent backed off and recovered |
| S27/28 | version change shown; unsupported version → Needs attention | PASS | scenarios.sh |
| S29 | CPU vs independent /proc/stat sample | PASS | scenarios.sh, vm-check.sh |
| S30 | memory vs /proc/meminfo, free | PASS | scenarios.sh, vm-check.sh |
| S31 | root filesystem size = df, Use% within 1 | PASS | scenarios.sh, vm-check.sh |
| S32 | pseudo/FUSE filesystems skipped; unreadable mount → device_error, no size | PASS | Go unit test |
| S33/34 | disk/network rates from deltas; counter reset → no spike | PASS | Go unit tests |
| S35 | reboot detected, rates reset; uptime matches | PASS (unit) / NOT RUN (real reboot) | Go unit test; real reboot: vm-check.sh --reboot-check |
| S36/37/38 | missing files, permission denied, unsupported → unavailable, not 0 | PASS | Go unit tests (permission case run as root: covered by error classification) |
| S39 | no NaN/Inf/negative stored | PASS | Prometheus query + Go unit test |
| S40 | overhead: 11 MB RSS, 0.04 % CPU, ~2 ms per round | PASS | scenarios.sh |
| S41 | ~203 series per host, no high-cardinality labels | PASS | scenarios.sh |
| S42 | no sensitive data in labels | PASS | scenarios.sh |
| S43 | Prometheus holds the agent's data | PASS | scenarios.sh |
| S44/45 | unreachable target / firewall diagnosed | PASS | Infrastructure shows a failing scrape separately; installer + agent name TLS/DNS/timeout causes |
| S46 | agent reaches ObservaOne from a real cloud VM | **NOT RUN** | needs your EC2 VMs |
| S47 | localhost never assumed | PASS | installer and agent refuse localhost/127.x |
| S48 | valid certificate accepted, invalid refused | PASS | scenarios.sh |
| S49 | compose restart keeps config and agents | PARTIAL | compose file validated; app/DB restarts tested; full `docker compose` stack not runnable here (no Docker Hub access) |
| S50 | repeated config does not duplicate targets | PASS | push model: no scrape targets are created |
| S51 | Prometheus down: uploads 503, heartbeats 200 | PASS | scenarios.sh |
| S52 | no retry storm | PASS | backoff with jitter (Go unit test) + Retry-After |
| S53-56 | Agents list, one Infrastructure row per host, last-seen, stale shows Not reporting | PASS | scenarios.sh + screenshots |
| S57/58/59 | empty state, missing value "-", API error state | PASS | UI (existing state components) |
| S60 | Agents module off → pages hidden, API 404; agents keep reporting | PASS | scenarios.sh |
| S61 | permissions on agent/token APIs | PASS | scenarios.sh |
| S62 | revocation visible and effective | PASS | scenarios.sh |
| S63/64/65 | pagination, filters, no duplicate requests | PASS | UI (50 per page) |
| S66 | installer re-run safe (identity + edits kept, no duplicate lines) | PASS | installer re-run |
| S67 | starts after VM reboot | **NOT RUN** | real systemd + reboot: vm-check.sh --reboot-check |
| S68 | shutdown/restart does not corrupt state | PASS | atomic writes (tmp + fsync + rename); restarts |
| S69 | disk full / unwritable state | PARTIAL | atomic writes; error messages; not run with a full disk |
| S70 | newer config_version refused | PASS | Go unit test |
| S71 | partial migration recoverable | PASS (by design) | all migrations run in one transaction |
| S72 | container recreation keeps agents | PASS (by design) | identities are in PostgreSQL (named volume) |
| S73 | uninstall removes only the agent's files | NOT RUN on a real VM | code review: removes only its 3 folders, unit and user |
| S74 | burst of 30 heartbeats | PASS | scenarios.sh (≤ 1 write per 5 s) |
| S75 | oversized / malformed requests | PASS | scenarios.sh (413 / 400) |
| S76 | logs useful, no secrets | PASS | journal JSON lines with cause; S14 |
| S77 | clock skew | PASS | unit tests (skew correction, age never negative) |
| S78 | many agents enroll and report | PASS | concurrent enrollment test; several agents reported together |

Other checks: 43/43 app tests (node:test, including the API suite against the running server), Go unit tests (core +
Linux collectors), no horizontal overflow on the Agents/Infrastructure pages from 390 to 1920 px, axe WCAG 2.1 AA clean
in dark and light.

## Known limitations

* Not yet run on a real cloud VM or with real systemd (S46, S67, S73).
* arm64 binary built but not run.
* Windows, Docker and Kubernetes still use the previous-generation agent; their tokens are sent with every upload.
* Changing settings from the UI (server → agent): the agent applies settings sent in the heartbeat answer, but the server
  does not send any yet (Agents → agent → Configuration is the next step).
* Logs and traces are not collected by the Go agent yet. Use the previous agent where you need them.
* A host monitored by both a Prometheus scrape and the agent is shown once, but its data exists twice in Prometheus:
  remove the scrape target.
* Rate limits are kept in memory in one UI container; with several UI containers each has its own counters.
