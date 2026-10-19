# ObservaOne Linux Agent (Go agent 1.3)

One small Go binary per Linux server (about 7 MB, about 11 MB of RAM, standard library only). It enrolls once, sends a
heartbeat every 30 s and sends host metrics every 15 s, all over HTTPS to the ObservaOne server. No port is opened
on the monitored server.

**Pull mode** (1.2, optional): Prometheus scrapes the agent instead, over mutual TLS with certificates that ObservaOne
issues automatically. Heartbeats still go out over HTTPS. See [Pull mode](#13-pull-mode).

**1.3** adds management from ObservaOne (Add Target wizard, settings per environment / target / agent, diagnostics,
restart and upgrade with rollback), application collectors (top processes, Docker, Nginx, JVM, local exporters),
credential rotation, signed releases, an optional disk buffer, tenants and site gateways: sections 14-19.

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

* **Control plane** (`/api/v1/agents/register`, `/api/v1/agents/{id}/heartbeat`): identity, status, diagnostics. It
  is stored in PostgreSQL and does not depend on Prometheus. The id in the path must be the credential's own agent
  (403 otherwise). Agent 1.1 paths (`/api/agent/v1/enroll|heartbeat|metrics`) still work for one release.
* **Metrics path** (`/api/v1/agents/{id}/metrics`, push mode): the agent POSTs the Prometheus text format (gzip). The server
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
  cmd/observaone-agent/       commands: run, enroll, status, check-config, config show, config migrate, reload, version
  internal/core/              config (+conf.d, remote settings), identity/credential storage, HTTPS client, backoff,
                              metric batch (refuses NaN/Inf/negative counters), counter-delta rates
  internal/agent/             run loop: collect -> buffer -> upload (push) or HTTPS endpoint (pull), heartbeats,
                              reload, status file, local /metrics
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
| - | Monitored server | **none** (push) | the agent opens no inbound port (diagnostics are on 127.0.0.1:9109 only) |
| ObservaOne server | Monitored server | **TCP 9110** (pull mode only) | Prometheus scrapes the agent (mutual TLS) |
| ObservaOne server | Monitored server | ICMP (optional) | reachability probe for the diagnosis; blocked ICMP only makes it "unknown" |

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
* writes `agent.yaml` (first time only; later runs change only the options you pass and keep your edits; labels and
  pull options from a re-run go to `conf.d/50-installer.yaml`). An agent 1.1 `agent.conf` is converted once
  (`agent.conf.migrated` is kept);
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
2. settings from ObservaOne (environment → target → agent, set on the Agents page; see section 14). Only
   `collect_interval`, `heartbeat_interval`, `disable`, `buffer_payloads`, `processes.top` and `docker.enabled`;
   saved in `/var/lib/observaone-agent/server-settings.json` with their version.
3. `/etc/observaone-agent/agent.yaml`
4. `/etc/observaone-agent/conf.d/*.yaml` (name order)

The server can never change `server`, `ca_file`, paths, `listen`, `mode` or `pull.*`, and it can never run commands on
the host.

The format is a small, strict YAML subset: `key: value`, the `labels:` and `pull:` sections, lists as `[a, b]` or
`- item`, `#` comments, quotes optional. Anchors, tabs, flow maps and several documents are refused with the line
number. An agent 1.1 `agent.conf` (`key = value`) is still read, with a warning, for one release:
`sudo observaone-agent config migrate` converts it (the installer does this for you).

```yaml
config_version: 2
server: "https://observaone.example.com"
env: prod
role: web
labels:
  team: payments
mode: push            # or pull
pull:
  listen: ":9110"
  # advertise: "10.0.0.5"     # address Prometheus should use (NAT, several networks)
  # allow: [10.0.0.0/8]       # only these source addresses may connect
collect_interval: 15s
disable: [network]
```

| Setting | Default | Meaning |
|---|---|---|
| `server` | (required) | `https://` address of ObservaOne as this server reaches it |
| `ca_file` | system trust | CA / self-signed certificate to trust (the installer sets it) |
| `env`, `role` | empty | labels on every metric |
| `labels:` | - | up to 10 extra labels; names `a-z0-9_`, values `A-Za-z0-9._-` |
| `mode` | `push` | `push`: send metrics over HTTPS; `pull`: Prometheus scrapes the agent (restart to change) |
| `pull.listen` | `:9110` | pull mode: address and port of the HTTPS endpoint (restart to change) |
| `pull.advertise` | - | pull mode: host name or IP Prometheus should use; goes into the certificate |
| `pull.allow` | any | pull mode: source IPs / CIDRs allowed to connect (a client certificate is always required as well) |
| `hostname` | short host name | name requested at enrollment (the server may add `-2` if it is taken) |
| `collect_interval` | `15s` | 5s - 5m |
| `heartbeat_interval` | server's value (30s) | 5s - 5m |
| `disable` | - | collectors to turn off: `cpu,memory,load,uptime,filesystem,disk,network,system,agent` |
| `buffer_payloads` | `40` | collections kept while the server is unreachable (40 × 15 s = 10 min); oldest dropped first |
| `listen` | `127.0.0.1:9109` | local diagnostics (`/metrics`, `/healthz`); loopback only; empty = off |
| `state_dir` | `/var/lib/observaone-agent` | identity, credential, status |
| `proc_path`, `sys_path`, `root_path` | `/proc`, `/sys`, `/` | for running in a container against the host |
| `config_version` | `2` | a file written for a newer agent is refused (`1` = old agent.conf) |

Change, check, apply without a restart:

```bash
sudo nano /etc/observaone-agent/conf.d/20-mine.yaml    # e.g.  collect_interval: 30s
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
| Added by the server | push: `up{job="linux",agent="observaone"} = 1` for every accepted upload; pull: Prometheus's own `up`. Same labels either way: `host, agent_id, job, platform, agent, os, env, role` + custom labels |

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

### Diagnosis: why an agent looks the way it does

The status says *what*; the diagnosis on the Agents page says *why*, from signals collected independently of the agent:
heartbeats, metric uploads (push), Prometheus's scrape result (pull), a blackbox ICMP ping of the host and a TCP connect
to the pull port. Each agent gets one reason and the evidence behind it.

| Signals | Diagnosis |
|---|---|
| heartbeats + data | **Healthy** (or *Healthy, rebooted recently* when the host started less than 15 min ago) |
| heartbeats, no uploads (push) | **Heartbeats arrive, metrics do not**: Nginx / Prometheus remote write |
| heartbeats, pull endpoint not open | **Pull endpoint not running** (no certificate yet, port in use) |
| heartbeats, scrape times out / port closed | **Prometheus cannot reach the agent**: firewall, security group, or set `pull.advertise` |
| heartbeats, connections closed by `pull.allow` | **The agent refuses ObservaOne** |
| heartbeats, TLS error | **Certificate problem on the pull endpoint** |
| no heartbeat, scrape OK (pull) | **Scraped, but no heartbeats**: outbound HTTPS from the host blocked |
| no heartbeat, host answers ping / port | **Host up, agent silent**: the agent stopped, or outbound 443 blocked |
| no heartbeat, no ping answer | **Host not reachable**: down, rebooting, or network |
| no heartbeat, no probe possible | **No heartbeat** (unknown whether the host is up) |

Probes that cannot run are "not measured", never "down".

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
* **Registration replay protection (1.2):** every registration carries a random nonce and the agent's time. The server
  refuses a nonce it has seen in the last 10 minutes and a time more than 5 minutes off its own (check NTP).
* **Rename:** an admin can rename an enrolled agent on the Agents page (`PATCH /api/agents/{id}`). New samples use the new
  `host` label at once (push) or at the next discovery refresh (pull, 30 s); old samples keep the old name.
* **Audit log:** `agent.renamed`, `agent.pull_certificate`, `agent.token.create`, `agent.token.revoke`, `agent.enroll`, `agent.reenroll`, `agent.enroll.denied`,
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
| `replay_check` at enrollment | the host clock is more than 5 minutes off: fix NTP (`timedatectl`), run the installer again |
| Pull mode: diagnosis says Prometheus cannot reach the agent | open TCP 9110 from the ObservaOne server; behind NAT set `pull.advertise` |
| Pull mode: "not scraped yet" for minutes | `docker compose logs prometheus` (the `observaone-agents` job); the files in volume `agent-pull` |

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
* **1.1 → 1.2:** the installer converts `agent.conf` to `agent.yaml` with the new binary. If the 1.2 agent does not send
  a heartbeat within 45 s, the rollback also restores `agent.conf` and the old unit (the 1.1 binary reads only that).
* **From the Agents page (1.3+):** agent → **Upgrade to x.y.z**. See section 14.
* **Server side:** `docker compose up -d --build`. The `agent-build` service compiles the agent (Go 1.24 image) into
  `agent/files/` and signs `SHA256SUMS` (section 16) before Nginx starts; `agent-pki-init` creates the agent CA before
  Prometheus starts. Database migrations 5-9 only add columns, tables and indexes, so going back to the previous
  version is safe; the new columns are simply ignored.

## 12. Testing on a real VM

On the monitored VM, after installing:

```bash
curl -fsSL https://observaone.example.com/agent/test/vm-check.sh -o vm-check.sh   # or copy agent/test/vm-check.sh
sudo bash vm-check.sh               # service, user, permissions, secrets, numbers vs free/df/uptime/proc, restart,
                                    # config reload, 70-second network cut with iptables
sudo reboot
sudo bash vm-check.sh --reboot-check
```

Paste the output back. On the ObservaOne server, `agent/test/scenarios.sh` runs the server-side scenario suite,
`agent/test/pull-scenarios.sh` the 1.2 / pull-mode suite, `agent/test/manage-scenarios.sh` the management suite and
`agent/test/phase6-scenarios.sh` rotation, signatures, disk buffer, tenants and the gateway (see the script headers).

## 13. Pull mode

```bash
sudo bash observaone-install.sh --server https://observaone.example.com --ca-sha256 <FP> --mode pull [--pull-port 9110] \
  [--pull-advertise 10.0.0.5] [--pull-allow 10.0.0.0/8]
```

1. The agent enrolls and sends heartbeats as in push mode (outbound HTTPS).
2. It makes its own P-256 key (`/var/lib/observaone-agent/pull.key`, 0600; it never leaves the host) and asks
   ObservaOne for a certificate (`POST /api/v1/agents/{id}/pull-certificate`) for its addresses. The name in the
   certificate is the agent id from the credential. Certificates last 90 days and are renewed at 2/3 of their life or when
   the host's addresses change.
3. It serves `https://<address>:9110/metrics`. Every connection must present the **Prometheus client certificate** from
   the same ObservaOne agent CA with the name `observaone-prometheus`; anything else is refused during the TLS handshake.
   `pull.allow` restricts source addresses further.
4. Prometheus finds the agents through **HTTP service discovery** (`/api/v1/sd/agents`, job `observaone-agents` in
   `prometheus/prometheus.yml`), with the same identity labels as push. The discovery endpoint needs its own token, is
   called inside the stack only, and is refused through Nginx.

The ObservaOne agent CA, the Prometheus client certificate and the discovery token are created on first start
(service `agent-pki-init`) in the `observa-data` volume, and copied for Prometheus to the `agent-pull` volume
(readable by Prometheus only). The CA key never leaves `observa-data`.

When to use pull: Prometheus must own the scrape schedule, or policy forbids monitored hosts from pushing data. Otherwise
push is simpler: no inbound port, and it buffers through short outages (in pull mode a missed scrape is a gap).

## 14. Managing agents from ObservaOne

**Add a server:** Infrastructure → **Add target**. Choose the type (Linux today), describe it (name, environment, role,
labels, push or pull), and the wizard creates a one-use, short-lived token and shows the two install lines (or the
`--token-file` version for Ansible / cloud-init). It then shows a live checklist while the agent connects:
enrolled → first heartbeat → first metrics → Prometheus has data; a stuck step says its likely cause. When all are
done, **Start monitoring** opens the host view. The agent is bound to the target and takes its environment, role and
labels where the installer did not set them.

**Settings:** layers, later wins: environment (Agents → Settings) → target → agent (agent detail → Configure) →
files on the host. Only `collect_interval`, `heartbeat_interval`, `buffer_payloads`, `disable`, `processes.top` and
`docker.enabled` can be set from ObservaOne; never the server address, trust, paths, network settings or any URL the
agent would read. Every change gets a new version; the agent applies a newer version at its next heartbeat, checks it
against its files and reports the version it applied. The detail shows **Pending** until it does, **Applied**
afterwards, or **Refused** with the agent's reason (the agent then keeps its previous settings). Settings set in a file
on the host are shown as locked: the file wins.

**Actions** (agent detail; a fixed list, never a command):

| Action | What happens |
|---|---|
| Request diagnostics | The agent uploads a bundle (≤ 1 MB): status, settings in effect and where each comes from, collectors, system facts, state folder listing (names only), DNS / TLS check to the server, the last 300 log lines. No credential, token, key, environment or command line; the server scrubs anything that looks like a secret again. The 5 newest bundles are kept, viewable and downloadable. |
| Restart agent | The agent reports, then exits with code 75; systemd (`Restart=on-failure`) starts it again in about 10 s. Done actions are remembered on disk, so it never restarts twice. |
| Upgrade to x.y.z | The agent writes `upgrade-request.json`; the root-owned **updater** (`observaone-agent-updater.path` → `.service`, installed by the installer) downloads the published build from the same server with the same trust settings, checks `SHA256SUMS` and its signature, runs `check-config` with the new binary as the agent user, swaps it (keeping `.prev`), restarts and waits 60 s for a heartbeat from the new version. Otherwise it **rolls back** and keeps the failed binary as `.failed`. The result appears on the Agents page. The agent itself never replaces its binary and never runs as root; the updater reads only the action id from the request (the version installed is whatever the server publishes). |
| Rotate credential | See section 16. |

Actions are delivered with the next heartbeat, expire after 24 hours, and are refused for blocked agents. A host
view (`/metrics/host/<host>`) shows a health strip: overall diagnosis, agent status, metrics, reachability, last metric
and agent version, with the diagnosis line when they disagree.

## 15. Application collectors

| Collector | Default | Metrics | Set with |
|---|---|---|---|
| processes | on, top 10 | `namedprocess_namegroup_cpu_seconds_total{groupname,mode}`, `namedprocess_namegroup_memory_bytes{groupname,memtype}`, `namedprocess_namegroup_num_procs`, `observaone_processes_total` (process-exporter names: the host view's Processes tab works unchanged) | `processes.top` (0 = off; also from ObservaOne) |
| docker | off | `container_cpu_usage_seconds_total`, `container_memory_usage_bytes`, `container_memory_working_set_bytes`, `container_spec_memory_limit_bytes` (cAdvisor names, labels `name`, `image`), `observaone_docker_container_info{state}`, `observaone_docker_containers{state}` | installer `--docker-metrics` (adds the agent user to the docker group: **root-equivalent**; the agent only sends GET requests), or `docker.enabled: true` |
| nginx | off | `nginx_up`, `nginx_connections_{active,reading,writing,waiting,accepted,handled}`, `nginx_http_requests_total` (nginx-prometheus-exporter names) | `nginx.status_url` / `--nginx-status URL` (stub_status) |
| jvm | off | `jvm_memory_{used,committed,limit}_bytes{jvm_memory_type}`, `jvm_thread_count`, `jvm_gc_collections_total`, `jvm_gc_collection_seconds_total`, `jvm_uptime_seconds`, `observaone_jvm_up` with `service_name` (OpenTelemetry names: the JVM heap metric in Metrics works) | `jolokia.<service>: URL` / `--jolokia name=URL` (Jolokia agent; user:password@ in the URL is supported and never shown) |
| exporters | off | everything a local exporter publishes, with `exporter="<name>"`; identity labels it sends are dropped | `exporters.<name>: URL` / `--exporter name=URL` (≤ 5,000 series, 4 MB) |

Addresses are host-only settings; the server can turn a collector off (`disable`) or switch processes / Docker,
never point the agent at an address. Reads have a 4-second timeout, a size limit and follow no redirects. Process
CPU counters only grow (a process that exits takes nothing away), so `rate()` never sees fake resets.

## 16. Credentials and releases

* **Credential rotation (1.3):** agent detail → **Rotate credential**, or automatically when the credential is older
  than `AGENT_CREDENTIAL_DAYS` (default 90; 0 = never). The heartbeat answer says `rotate`; the agent asks for a new
  credential (only with its current one), saves it atomically, and only then uses it. The server accepts the old one
  until **10 minutes after the new one is first used**, so an agent that fails to save never locks itself out.
* **Signed releases:** `agent-build` signs `SHA256SUMS` with an Ed25519 release key (created on the first build in the
  `agent-signing` volume; `.agent-keys/` for manual builds; never served) and publishes `SHA256SUMS.sig` and
  `release.pub`. The installer checks the signature (with the agent already installed, or openssl 3) and **pins**
  `release.pub` in `/etc/observaone-agent` on the first install. Later, the installer and the updater refuse a build
  not signed by the pinned key, and the installer refuses a different key unless run with `--trust-new-release-key`.
  On a first install on a host without openssl 3, the download is trusted through the pinned TLS connection and
  `SHA256SUMS` (the installer says so). Back up the `agent-signing` volume: losing the key means re-pinning every host.

## 17. Disk buffer

For sites with outages longer than the 10-minute memory buffer (push mode):

```yaml
disk_buffer:
  enabled: true      # installer: --disk-buffer
  max_mb: 100        # oldest dropped first
  max_age: 2h        # at most 2h: Prometheus accepts samples up to 2 h late (out_of_order_time_window)
```

A collection that would be dropped from memory, and whatever is still waiting when the agent stops, goes to
`/var/lib/observaone-agent/buffer` (gzip, 0600). Uploads send the disk buffer first, oldest first. `observaone-agent
status` and the agent detail show how many collections wait.

## 18. Tenants

For one ObservaOne serving several organisations (Settings → Tenants; platform admins only).

* Every agent, token, target and settings layer belongs to a tenant; an agent belongs to the tenant of its token.
* Users of the **Default** tenant run the platform and see everything. Users of another tenant see only their own
  agents, tokens, targets and gateways; another tenant's ids answer 404.
* Series from a non-default tenant's agents carry `tenant="<id>"`, set by the server; a `tenant` label sent by an
  agent is dropped. Every PromQL query a tenant user runs through ObservaOne (Metrics, dashboards, host views, alert
  previews, label pickers) is rewritten so each selector also matches their tenant; a query that cannot be read is
  refused rather than run unscoped.
* Environment settings layers are per tenant. Two tenants cannot both have an enrolled host with the same name (the
  second becomes `name-2`).
* Not tenant-scoped yet: logs (Loki), traces (Tempo) and Alertmanager alerts (the Go agent sends none of them).

## 19. Site gateways

An **ObservaOne Gateway** relays the agents of a site that cannot reach ObservaOne, and keeps heartbeats and metrics
while the link is down (spooled up to 1 GB / 2 h, replayed oldest first, heartbeats replayed with the time they were
received). Create it in Agents → Gateways (the token is shown once), run `gateway/docker-compose.yml` in the site
(see `gateway/README.md`), and install the site's agents with `--server https://<gateway>`. The centre still checks
every credential and payload; only credentials the centre accepted recently are spooled; a tenant's gateway relays
only that tenant's agents. The Agents page shows each gateway's state and spool, and "via gateway" on its agents.
Pull mode does not go through a gateway.

## Test results

Re-run on 2026-10-18 after merging into `react` (React Agents screens): scenarios.sh 41 PASS / 0 FAIL, server tests 40/40,
Go tests pass, Agents and Metrics UI checks pass. S46/S67/S73 still need a real VM (see above).

### 1.2 (2026-10-19)

Lab as below, plus a blackbox exporter and Prometheus with the `observaone-agents` / probe jobs. The lab agent (1.1, with
an `agent.conf`) was upgraded by the installer: the config was converted, the identity kept, heartbeats moved to the
`/api/v1/agents` paths.

* `agent/test/pull-scenarios.sh`: **20 PASS, 0 FAIL** (S80-S99): replay protection (nonce reuse, 10-minute clock skew,
  missing nonce), path id must match the credential, certificate requests validated (loopback, bad key), certificates
  signed by the agent CA with the agent id, discovery token required and refused through the proxy, mutual TLS on the
  pull endpoint (no client certificate, a same-name certificate from another CA, an agent certificate, plain HTTP: all
  refused), Prometheus scrapes with the same labels as push, diagnosis for a firewalled pull port, blocked outbound
  HTTPS and a stopped agent, rename reaching Prometheus through discovery, config migration.
* Also checked by hand: `pull.allow` excluding ObservaOne → "The agent refuses ObservaOne".
* `agent/test/scenarios.sh` against the 1.2 agent in push mode: **41 PASS, 0 FAIL** (old 1.1 paths still served).
* Go unit tests (YAML parser, migration round trip, certificate renewal rules), server unit tests (diagnosis matrix,
  discovery, replay check, the CA): all pass.

### 1.1 (2026-10-11)

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
* Add Target offers Linux only; Windows, Kubernetes, VMware and network devices are shown as "not yet".
* Tenants: logs, traces and Alertmanager alerts are not tenant-scoped; Prometheus queried directly (not through
  ObservaOne) is not scoped either: keep Prometheus behind ObservaOne for tenant users.
* The updater needs systemd path units (every supported distribution has them); hosts installed before 1.3 get the
  updater on their next installer run.
* Logs and traces are not collected by the Go agent yet. Use the previous agent where you need them.
* A host monitored by both a Prometheus scrape and the agent is shown once, but its data exists twice in Prometheus:
  remove the scrape target.
* Rate limits are kept in memory in one UI container; with several UI containers each has its own counters.
* Pull mode: no buffer (a missed scrape is a gap); the agent CA is single-level, with no revocation list: a removed or
  blocked agent's certificate stays valid until it expires (90 days), but discovery drops the agent at once, so
  Prometheus stops scraping it.
* The ICMP probe needs the blackbox container's NET_RAW capability; where ICMP is filtered the diagnosis cannot tell
  "host down" from "agent stopped".
