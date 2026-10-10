# ObservaOne monitoring stack

One Docker setup that gives you a monitoring website with login:

| Address | What it is | Who can open it |
|---|---|---|
| `https://SERVER/` | **ObservaOne UI**: Overview, Incidents, Services, Infrastructure, Metrics, Logs, Traces, Dashboards, Agents, Data Sources, Insights, Settings | UI users (admin / operator / viewer) |
| `https://SERVER/grafana/` | Grafana with the same Windows/Linux dashboards | Grafana users |
| `https://SERVER/prometheus/` | Prometheus (raw metrics, targets) | `WEB_ADMIN_USER` only |
| `https://SERVER/alertmanager/` | Alertmanager (raw alerts, silences) | `WEB_ADMIN_USER` only |
| `https://SERVER/loki/api/v1/push`, `/otlp/v1/logs`, `/otlp/v1/traces` | Intake for logs and traces (push only) | `INGEST_USER` only |
| `https://SERVER/agent/` | ObservaOne Agent installers (no secrets inside) | anyone who can reach the server |
| `https://SERVER/ingest/agent/...` | Uploads from ObservaOne Agents | agents with a valid agent token |

```
 ObservaOne Agent (Linux / Windows / Docker / Kubernetes)
   metrics + logs + traces ── HTTPS + agent token ──► Nginx ──► Prometheus / Loki / Tempo

 Windows servers (windows_exporter :9182) ─┐   (or without an agent: Prometheus pulls)
 Linux servers   (node_exporter    :9100) ─┼──► Prometheus ──► Alertmanager ──► email
                                           │        │
 Log / trace shippers (Alloy, OTel) ─► Nginx ─► Loki / Tempo
                                           │        │
 Browser ── HTTPS ──► Nginx ──► ObservaOne UI / Grafana (read everything above)
                                    │
                                    └──► PostgreSQL (users, sessions, dashboards, settings, audit log)
```

---

## 1. What you need

- **Windows PC (lab):** Docker Desktop.
- **Linux server (real):** Docker Engine 24+ with the compose plugin. Size it at 4 CPU, 8 GB RAM and 50 GB disk to start.
- **Internet on first start**, to download images and build the UI. On a network without internet, build and push the images to your own registry first (see section 10).

## 2. First start (10 minutes)

1. Copy the `monitoring-stack` folder to the machine.
2. Create your settings file and change **every** password in it:
   ```bash
   cp .env.example .env          # Windows PowerShell: copy .env.example .env
   ```
   - Passwords need 12+ characters with upper case, lower case, a number and a symbol.
   - Don't use `$ " ' \ #` or spaces.
   - Set `SERVER_NAME` to the name or IP people will type in the browser.
3. Start everything:
   ```bash
   docker compose up -d --build
   ```
   The first time takes a few minutes. Check that everything is running:
   ```bash
   docker compose ps
   ```
   `nginx`, `observa`, `observa-db`, `grafana`, `prometheus`, `alertmanager`, `loki` and `tempo` should be `running` / `healthy`. The `*-init` and `grafana-users` jobs show `exited (0)`, which is correct because they run once.
4. Open `https://SERVER/` (lab: `https://localhost/`).
   - The certificate is self-signed, so the browser warns once. Click **Advanced → Continue**.
   - Sign in with `UI_ADMIN_USER` / `UI_ADMIN_PASSWORD` from `.env`.

> **Passwords from `.env` are only used the first time.** After that, users and passwords live in the database. Change them in **Settings → Users**, or each user changes their own in **Settings → My profile**.

## 2b. Finding your way around (click-through)

Everything on the **Overview** opens the page behind it:

| Click on | Opens |
|---|---|
| A KPI card (hosts, services, incidents, error rate, latency) | Infrastructure, Services, Incidents, Services, Traces |
| Service Health / Top Services / a service name anywhere | **Service page**: Overview, Metrics, Logs, Traces, Dependencies, Deployments |
| An active incident | **Incident page**: status, assign, notes, timeline, the service's metrics, logs and traces during the incident |
| A log line | **Log Details**: Message, JSON, Context (lines around it), Related Traces, **View Trace** |
| A trace | **Trace page**: Duration, Services, Spans, Status; Timeline, Spans, Logs, Metrics, Service Map |

**Incidents** open automatically when alerts fire (one per alert and service/host) and resolve themselves when the alerts stop. People acknowledge, mark as investigating, assign, add notes and resolve. You can also declare one with **Create Incident**. Alert rules and silences are under **Alert Rules** in the Manage group.

**Insights** predicts problems: *Forecasts* shows when each disk or memory fills up (trend fitted to recent history, ignoring spikes and clean-ups), *Anomalies* shows metrics that are unusual for this time of day or week. It is plain statistics, not a machine-learning model.

**When data cannot load (v1.8.2):** every page shows grey placeholders while loading. If a refresh fails, the last good data stays on screen with "Couldn't refresh at … — showing data from …" and a **Try again** button, and the "Updated … ago" stamp keeps the time of the last success. If the first load fails, the page names the cause and offers **Try again**. Sample data is never shown in place of a failure. Filters, tabs, environment and time range are kept in the URL, so Back, Forward and shared links show the same view. The UI quality gate (baseline, rules, issue tracker) is in `docs/ui-quality/`, and its browser checks are in `observa-ui/test/ui-gate/`.

**Needs your attention** at the top of the Overview is built from live data only: unacknowledged incidents, unhealthy or degraded services, hosts not answering and disks over 90% full. If a source does not answer it says "Could not check …" instead of showing all clear. Values that are missing show "N/A" or "No data", never a made-up number.

**Top bar (v1.8):**
- **Search (Ctrl+K or /):** pages, role and custom dashboards, services, metrics, incidents by number, trace IDs, and actions (switch theme, refresh, profile, keyboard shortcuts, sign out).
- **Auto-refresh:** Auto (page default, usually 30s), Off, 15s, 30s, 1m or 5m. Saved per user. Pages only reload while the tab is visible. "Updated … ago" shows on wide screens, and in the refresh button tooltip.
- **Help (?):** keyboard shortcuts, API reference, data source status, About (version).
- **Menu:** the arrow at the bottom collapses it to icons (saved per user). Below 1100px it is an icon rail; on phones the ☰ button opens it as a drawer.

Light / dark mode: the sun / moon button at the top right. The choice is saved per user.

## 3. Roles

| Role | Can do |
|---|---|
| **Viewer** | Look at everything. Cannot change anything. |
| **Operator** | Viewer + create dashboards, add panels, silence alerts. |
| **Admin** | Operator + create/delete alert rules, manage users, change data sources, read the audit log. |

Security built in:
- Passwords are stored as bcrypt hashes.
- Sessions are stored in the database as SHA-256 hashes, so a copy of the database can't be used to sign in.
- Sessions survive a UI restart. You are signed out after 30 minutes idle, and after 8 hours in total.
- After 5 wrong passwords, that user is locked for 15 minutes from that IP.
- Sign-ins and changes are written to **Settings → Audit log**, which is kept for 365 days.
- The session cookie is HTTP-only and SameSite=Lax (needed for SSO redirects), and every page is served over HTTPS.

**Custom roles.** Settings → Roles shows a permission matrix. Click **New role** to make a role in between (for example "dashboard editor" or "on-call responder"). Nobody can give out a permission they don't have.

**Teams.** Settings → Teams groups people (used later for on-call, incidents and dashboard sharing).

## 3b. Sign-in options

| Option | How to turn it on | Users type |
|---|---|---|
| Username + password | On by default | Their UI password |
| **Two-factor (MFA)** | Each user: Settings → My profile → Set up two-factor. To force it for a role: Settings → Security. | Password, then the 6-digit code from Microsoft/Google Authenticator. 10 one-time recovery codes are given. |
| **LDAP / Active Directory** | Set `LDAP_*` in `.env` | Their normal Windows/directory login |
| **Company SSO** (Entra ID, Okta, Keycloak…) | Set `OIDC_*` in `.env` | Click "Company SSO" |
| **Google** | Set `GOOGLE_*` in `.env` | Click "Google" |
| **GitHub** | Set `GITHUB_*` in `.env` | Click "GitHub" |

Steps for SSO:
1. At your provider, create an app. Redirect URL: `https://SERVER_NAME/api/auth/oidc/callback` (use `google` or `github` instead of `oidc` for those).
2. Copy the client ID and secret into `.env`.
3. Map groups to roles with `*_ROLE_MAP`. Use single quotes around JSON: `OIDC_ROLE_MAP='{"monitoring-admins":"admin"}'`. First match wins.
4. Leave `*_DEFAULT_ROLE` empty to refuse people who are in no listed group.
5. `docker compose up -d`. Check Settings → Security; for LDAP click **Test**.

SSO and LDAP users are created on first sign-in. If a role map is set, their role is updated from their groups at every sign-in, and removing them from all groups removes their access.

**API keys.** Settings → API keys. A key can do at most what its owner can do. Use it as `Authorization: Bearer oo_...`. Admins can make *service account* keys that keep working when a person leaves. Every endpoint is listed in Settings → API reference.

## 3a. The database (PostgreSQL)

The UI keeps its data in the `observa-db` container:

| Table | What is in it |
|---|---|
| `users` | usernames, roles, password hashes, disabled flag, last sign-in |
| `sessions` | who is signed in, from which browser and IP, and when it expires |
| `login_failures` | wrong-password counters and lockouts |
| `dashboards` | custom dashboards and their panels |
| `datasource_settings` | Loki/Tempo URLs and live/demo mode set by admins |
| `user_preferences` | each user's time range and last Metrics/Logs/Traces query, so they follow you to another browser |
| `audit_log` | every sign-in, change and denied action |

- **See and end sign-ins:** **Settings → Sessions** shows your own sign-ins. Admins see everyone's and can sign anyone out.
- **Tables are created automatically** on start, and new versions upgrade them by themselves.
- **Upgrading from the JSON version:** old `users.json` / `dashboards.json` / `audit.log` files are imported once and renamed to `*.imported`.
- **Open a database shell:** `docker compose exec observa-db psql -U observa`

## 4. Add servers with the ObservaOne Agent (recommended)

One agent per server collects **metrics, logs and traces** and sends them to ObservaOne over HTTPS.
Nothing on the server has to be reachable from the monitoring server (no inbound ports, no firewall rule).

| Platform | What the agent collects |
|---|---|
| **Linux** (systemd) | CPU, memory, disk, network, systemd services (node_exporter) · syslog/messages/auth logs or the journal · your log files · traces from apps |
| **Windows** Server 2016+ | windows_exporter metrics · Application + System event logs (Security optional) · your log files · traces |
| **Docker host** | the host + every container (cAdvisor) · container stdout/stderr · traces |
| **Kubernetes / OpenShift** | every node, container CPU/memory, pod logs, Kubernetes events, kube-state-metrics · traces on the node IP |

**Install**
1. ObservaOne → **Agents → Install agent**.
2. Pick the platform, click **New token**, and fill in environment / role / extra log files if you want them.
3. Copy the command and run it on the server (Linux: as root; Windows: PowerShell **Run as administrator**; Kubernetes: with `kubectl`).
4. The server shows up on the **Agents** page within a minute, and on Infrastructure, Dashboards and Logs.

Example (Linux):
```bash
curl -fsSL https://monitor.example.local/agent/install.sh | sudo bash -s -- \
  --server https://monitor.example.local --token oat_xxxxxxxx_xxxx --env prod --role web \
  --logs "/var/log/nginx/*.log"
```

**Safety built in**
- The agent token is checked by ObservaOne on **every** upload. Revoke a token (Agents → Tokens) and every agent using it stops within a minute. **Block** cuts off a single server.
- Self-signed certificate? The command pins your server's certificate fingerprint. Agents refuse any other server, so there is no "ignore certificate errors".
- Every download is checked against a fixed SHA-256 before it is installed.
- Linux: runs as the user `observaone-agent` with only the right to read log files (`CAP_DAC_READ_SEARCH`). node_exporter listens on 127.0.0.1 only.
- Windows: windows_exporter listens on 127.0.0.1 only. The token file is readable by SYSTEM and Administrators only.
- If ObservaOne is unreachable, logs and traces wait on disk and are sent later. Metrics wait in memory, and Prometheus accepts them up to 30 minutes late.

**Lab / one machine: run the agent with Docker Compose** (Windows + Docker Desktop, WSL, or a Linux PC). No installer and no systemd needed:
1. Start the stack and sign in: `docker compose up -d --build`.
2. **Agents → Tokens → New token**. Put the token in `.env`: `AGENT_TOKEN=oat_...` (optionally `AGENT_HOST=my-laptop`).
3. Start the agent next to the stack:
   ```bash
   docker compose --profile agent up -d
   docker compose --profile agent ps        # agent, agent-node-exporter, agent-cadvisor = running
   docker compose logs agent                # problems show here
   ```
4. Within a minute **docker-host** appears on the Agents page, with every container's CPU and memory.

The profile watches the machine Docker runs on. With Docker Desktop that is Docker's Linux VM, not Windows itself: for Windows metrics and event logs, install the Windows agent too. The agent talks to Nginx inside Docker (`https://nginx`) and checks the same certificate. Apps on the machine can send traces to `127.0.0.1:4317` / `:4318`. Stop it with `docker compose --profile agent down` (the stack stops too) or `docker compose stop agent agent-node-exporter agent-cadvisor`.

**Servers without internet:** run `./scripts/fetch-agent-files.sh` once on the monitoring server. Installers then download the binaries from `https://SERVER/agent/files/` instead of GitHub. Docker and Kubernetes agents use container images: copy them to your own registry.

**Update:** run the install command again. The token and the agent ID are kept, so the server stays the same entry.
**Remove:** Linux/Docker `curl -fsSL https://SERVER/agent/install.sh | sudo bash -s -- --uninstall` · Windows `install.ps1 -Uninstall` · Kubernetes `kubectl delete -f kubernetes.yaml`. Then click **Forget** on the Agents page.

**Alerts** (`prometheus/rules/agent-alerts.yml`):
- **AgentNotReporting**: a server sent nothing for 5 minutes.
- **AgentSendFailures**: uploads keep failing.
- **AgentQueueFilling**: the agent is holding back a lot of data.

**Already scraping a server from `prometheus/targets/`?** Remove it there after installing the agent, so it is not counted twice.

**Traces from your apps:** point OpenTelemetry at the local agent: `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`. On Kubernetes, set an env var `NODE_IP` from `status.hostIP` and use `http://$(NODE_IP):4318`.

## 4b. Add Windows servers without an agent (Prometheus pulls)

On each Windows server (PowerShell as Administrator), replace the IP with your monitoring server's IP:
```powershell
msiexec /i windows_exporter-0.31.8-amd64.msi /qn ADDLOCAL=FirewallException REMOTE_ADDR=10.20.30.40
```
Then add the server to `prometheus/targets/windows.yml`:
```yaml
- targets: ["winapp01.example.local:9182", "winapp02.example.local:9182"]
  labels: { env: prod, role: app }
```
No restart is needed. It appears in **Infrastructure** within about a minute.

**Lab:** the file already points to `host.docker.internal:9182`, which means windows_exporter running on the same PC as Docker Desktop.

## 5. Add Linux servers without an agent

Run `node_exporter` on port 9100 on each server, then add it to `prometheus/targets/linux.yml` in the same way.

## 6. Turn on real logs and traces

Out of the box, the **Logs**, **Traces** and **Services** pages show **demo data**, with a yellow `DEMO DATA` badge. Metrics, Infrastructure and Alerting are always real.

**Logs:** install Grafana Alloy on the servers and push to Loki through Nginx. Example `config.alloy` (check it against your Alloy version):
```alloy
loki.source.windowsevent "app" {
  eventlog_name = "Application"
  labels        = { app = "windows-eventlog" }
  forward_to    = [loki.write.central.receiver]
}
loki.write "central" {
  endpoint {
    url = "https://monitoring.example.local/loki/api/v1/push"
    basic_auth { username = "shipper"  password = "INGEST_PASSWORD from .env" }
    tls_config { ca_file = "C:/certs/monitoring-ca.pem" }
  }
}
```

**Traces:** point your OpenTelemetry Collector's `otlphttp` exporter at `https://monitoring.example.local/otlp`, with basic auth `INGEST_USER` / `INGEST_PASSWORD`. Traces go to Tempo and logs sent over OTLP go to Loki.

Then in the UI go to **Data Sources → Loki → Edit → Mode: Live**, and do the same for Tempo. To make this the default, set `LOKI_MODE=live` and `TEMPO_MODE=live` in `.env`.

**Services page (request rate, latency, errors):** edit `observa-ui/config/services.json` so the 3 PromQL queries match your applications' metrics. Then switch **Service metrics** to Live.

## 7. Alerts and email

- Alert rules are in `prometheus/rules/host-alerts.yml`: server down, CPU above 90%, memory above 90%, disk below 20% (warning) and below 10% (critical). After editing, run `docker compose restart prometheus`.
- Admins can also create rules in **Alerting → New Alert Rule**. The UI checks the query, writes the rule and reloads Prometheus. If Prometheus rejects the rule, the change is undone.
- To turn on **email**, fill in the `smtp_*` lines and `email_configs` in `alertmanager/alertmanager.yml`, then run `docker compose restart alertmanager`.
- To **silence** an alert (for example during maintenance), switch off **Notify** on it in Alerting. This needs the operator role or higher.

## 8. Everyday commands

```bash
docker compose ps                      # status
docker compose logs -f observa         # UI log (also: prometheus, nginx, grafana, loki, tempo)
docker compose restart prometheus      # after editing prometheus.yml or rules
docker compose down                    # stop (data is kept)
docker compose up -d --build           # start / apply changes
```
**Backup the UI database** (users, dashboards, audit log). Do this daily:
```bash
docker compose exec -T observa-db pg_dump -U observa -Fc observa > observa-$(date +%F).dump
```
**Restore it:**
```bash
docker compose stop observa
docker compose exec -T observa-db pg_restore -U observa -d observa --clean --if-exists < observa-2026-10-09.dump
docker compose start observa
```
The other data lives in Docker volumes: `grafana-data`, `prometheus-data`, `loki-data` and `tempo-data`.

## 9. Problems and fixes

| Problem | Fix |
|---|---|
| Browser says "not secure" | Normal with the self-signed certificate. For production use a real certificate (section 10). |
| Can't sign in to the UI after changing `.env` | `.env` passwords are only used the first time. An admin resets the password in Settings → Users. |
| Forgot the only admin password | Delete all UI users, then restart. The users from `.env` are created again: `docker compose exec observa-db psql -U observa -c "TRUNCATE users CASCADE"` and then `docker compose restart observa`. Dashboards and the audit log are kept. |
| `observa` keeps restarting | `docker compose logs observa`. "Database not reachable" means `observa-db` is not healthy yet, or `DB_PASSWORD` was changed after the first start. The database keeps the password it was created with. |
| A server shows **DOWN** | On that server, check the windows_exporter service is running and port 9182 is open to the monitoring server. Then check the name in `targets/windows.yml`. |
| Data source shows **Error** | **Data Sources → Test** shows the reason. Run `docker compose logs loki` (or tempo, prometheus). |
| Port 443 or 80 already in use | Change `HTTPS_PORT` / `HTTP_PORT` in `.env`. |
| Agent install: "Cannot connect" | From that server, `curl -k https://SERVER/agent/install.sh` must work: check DNS, port 443 and proxies. |
| Agent install: "refused the token" | The token was revoked, expired or mistyped. Create a new one on Agents → Tokens. |
| Agent install: "fingerprint does not match" | The server certificate changed (new cert) or something sits in between. Copy a fresh command from the Agents page. |
| Agent shows **Offline** | Linux: `systemctl status observaone-agent` and `journalctl -u observaone-agent -n 50`. Windows: `Get-Service ObservaOneAgent` and Event Viewer > Application. Docker: `docker compose -f /opt/observaone-agent/docker-compose.yml logs agent`. Kubernetes: `kubectl -n observaone logs ds/observaone-agent -c agent`. |
| Agent shows "failed" uploads | Usually a revoked token (401) or a blocked agent (403). The agent log says which. |

## 10. Before production

- Put a real certificate (from your company CA, or Let's Encrypt) in `nginx/certs/server.crt` and its key in `server.key`. They are used instead of the self-signed ones.
- Change every password in `.env` (including `DB_PASSWORD`), and keep `.env` out of email and chat.
- Schedule the database backup above.
- Firewall:
  - users reach port 443 only;
  - the monitoring server reaches servers on 9182 (Windows) and 9100 (Linux);
  - log shippers reach 443.
- With no internet: run `docker compose build` and `docker compose pull` on a connected machine, push the images to your registry, and change the `image:` names.
- Not included yet: LDAP/Active Directory or SSO login. The SSO buttons on the login page say "not configured". Grafana can use LDAP on its own if needed.

## Files

```
docker-compose.yml        all services
.env.example              settings and passwords (copy to .env)
nginx/nginx.conf          HTTPS, routing, logins for /prometheus /alertmanager and intake
prometheus/               prometheus.yml, targets/*.yml (your servers), rules/*.yml (alerts)
alertmanager/             alertmanager.yml (email etc.)
grafana/                  Grafana data sources and dashboards
loki/ tempo/              log and trace storage settings
observa-ui/               the ObservaOne web app (Node.js + PostgreSQL)
  src/db.js               database connection, tables (migrations), JSON import
  config/dashboards/      built-in dashboards (JSON, editable)
  config/services.json    PromQL for the Services page
agent/                    ObservaOne Agent: install.sh (Linux + Docker), install.ps1 (Windows),
                          kubernetes.yaml, docker-compose.yml, configs/*.yaml, files/ (offline binaries)
scripts/                  one-time setup jobs (certificate, logins, Grafana users), fetch-agent-files.sh
```

## 2c. Dashboards for each role (sample data)

The top bar has a **dashboard selector**. It lists Overview plus the role dashboards your **role** includes. "Home" (`/views`) opens your landing dashboard.

**Choosing dashboards per role:** an admin opens **Settings › Roles › Dashboards for each role**.
- Tick which dashboards each role can open.
- Pick the one its users land on after sign-in ("Opens after sign-in").
- Click **Save dashboards**. Users see the change on their next page load.
- Built-in roles can be changed here too, because this grants no extra rights.
- A new custom role starts with the dashboards its permissions suggest.

| Dashboard | URL | Default roles | Default landing for |
|---|---|---|---|
| Business / Executive | `/views/business` | admin, operator, viewer | viewer |
| DevOps Engineer | `/views/devops` | admin, operator | operator |
| Developer | `/views/developer` | admin, operator, viewer | |
| SRE / Reliability | `/views/sre` | admin, operator | |
| Security Team | `/views/security` | admin, operator | |
| Application Owner | `/views/appowner` | admin, operator, viewer | |
| IT / Platform Admin | `/views/itadmin` | admin | admin |
| Kubernetes | `/views/kubernetes` | admin, operator | |

**Kubernetes:**
- **Pages:** an overview, then cluster › namespace › workload › pod, plus a page per node.
- **Problems explained:** CrashLoopBackOff, OOMKilled, ImagePullBackOff, Pending and NotReady each come with a plain explanation of the cause.
- **Live data:** the built-in **Kubernetes Cluster** and **Kubernetes Workloads** dashboards (Dashboards › System) show live data from the Kubernetes agent (`agent/kubernetes.yaml`: kube-state-metrics, cAdvisor and node metrics with a `cluster` label).

- **Landing page:** press **Set as landing** on any role dashboard. The choice is saved in your browser.
- **Filters follow you:** the **Environment** and **time range** in the top bar are added to every drill-down link, along with page filters (team, service, cluster…). Back and shared links show the same data.
- **Drill-downs per role:**
  - DevOps: deployments, pipelines, clusters.
  - Developer: services, endpoints, error groups, trace timeline.
  - SRE: SLOs, plus the incident workflow (declare → acknowledge → investigate → mitigate → resolve → postmortem).
  - Business: customer services, problems, the monthly report.
  - App Owner: applications, releases.
  - Security: detections (triage, block an address), hosts, source addresses.
  - Platform Admin: agents, platform components (disk forecast), ingestion vs licence.
- **Test states:** add `?mock=error` or `?mock=empty` to any role dashboard URL.
- **Sample data only:** the data comes from `public/js/personas/mock*.js`, and there is no backend for these dashboards yet. Every role dashboard shows a **Sample data** banner with a link to the live page that covers the same ground.
- **Actions that need an integration are locked:** roll back, promote, re-run, rolling restart, cordon, drain, delete pod, block address, scan, page on-call, create ticket, upgrade agents, budget alerts and the weekly e-mail show a lock and "Not available yet". Clicking one says what integration is missing and changes nothing. SRE incident and Security triage changes are kept only in the browser tab (the banner says so).
- **Hosted preview:** `observa-ui/preview/build.sh` builds one HTML file with everything (needs `esbuild`). It shows the role dashboards with sample sign-in and a "View as" role switch. No server is needed.

**How the role dashboards behave:**
- **Needs your attention:** up to 3 items at the top of each dashboard, worst first, each with a button to act on it. When nothing is wrong it shows "All clear".
- **Colour means a problem:** healthy rows are grey; only warnings and failures are coloured.
- **Tables:** click a header to sort (click again to reverse). Long tables get a filter box and pages of 10. In narrow panels the least important column is hidden.
- **Breadcrumbs** on every detail page (for example DevOps Engineer › Deployments › checkout v4.23.1). They keep your environment and time range.
- **"Sample data drawn … ago"** under each role dashboard title.
- **The menu is grouped:** Home, then Observe (Overview, Services, Infrastructure, Kubernetes), Investigate (Incidents, Logs, Traces), Analyze (Metrics, Dashboards, Insights) and Manage (Data Sources, Agents, Alert Rules, Users & Roles, Settings). Items your role cannot use are not shown, and the server still checks every request.

**Personal dashboards** (Dashboards page):
- Each custom dashboard has an owner and a sharing setting: Only me, My team or Everyone.
- Tabs: My dashboards, Shared with me, Favourites (★), System.
- **Copy** turns any dashboard you can see into your own.
- **Edit panels** lets you move, resize, rename or remove panels.
- **Set as home** opens that dashboard after sign-in.
