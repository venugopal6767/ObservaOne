# ObservaOne monitoring stack

One Docker setup that gives you a monitoring website with login:

| Address | What it is | Who can open it |
|---|---|---|
| `https://SERVER/` | **ObservaOne UI**: Overview, Dashboards, Metrics, Logs, Traces, Services, Infrastructure, Alerting, Data Sources, Settings | UI users (admin / operator / viewer) |
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
| `datasource_settings` | Loki/Tempo URLs set by admins |
| `user_preferences` | each user's time range and last Metrics/Logs/Traces query, so they follow you to another browser |
| `audit_log` | every sign-in, change and denied action |

- **See and end sign-ins:** **Settings → Sessions** shows your own sign-ins. Admins see everyone's and can sign anyone out.
- **Tables are created automatically** on start, and new versions upgrade them by themselves.
- **Upgrading from the JSON version:** old `users.json` / `dashboards.json` / `audit.log` files are imported once and renamed to `*.imported`.
- **Open a database shell:** `docker compose exec observa-db psql -U observa`

## 4. Add servers with the ObservaOne Agent (recommended)

One agent per server collects **metrics, logs and traces** and sends them to ObservaOne over HTTPS.
Nothing on the server has to be reachable from the monitoring server (no inbound ports, no firewall rule).

| Platform | Agent | What it collects |
|---|---|---|
| **Linux** (systemd) | **ObservaOne Go agent 1.1** (new) | CPU, memory, filesystems, disk and network I/O, load, uptime, OS info. Logs and traces: not yet (use the previous agent where needed) |
| **Windows** Server 2016+ | previous agent (OpenTelemetry Collector) | windows_exporter metrics · event logs · your log files · traces |
| **Docker host** | previous agent | the host + every container (cAdvisor) · container logs · traces |
| **Kubernetes / OpenShift** | previous agent | nodes, containers, pod logs, events, kube-state-metrics · traces |

The Linux agent is documented in full in **[docs/agent/LINUX-AGENT.md](docs/agent/LINUX-AGENT.md)**: architecture, network and TLS, configuration, status rules, metrics, troubleshooting, upgrade and rollback, and test results.

**Install (Linux)**
1. ObservaOne → **Agents → Linux → Install**, then **Create a token** (choose how long it is valid and how many servers may use it).
2. Run the two lines shown on the page on the server. The installer asks for the token; what you type is hidden, so it never lands in shell history.
3. The server shows up under **Agents → Linux** within a minute (status **Online**), and in Infrastructure, Overview and Dashboards.

```bash
curl -fsSL https://monitor.example.local/agent/install.sh -o observaone-install.sh
sudo bash observaone-install.sh --server https://monitor.example.local --ca-sha256 <FINGERPRINT> --env prod --role web
```

The monitored server needs **outbound HTTPS (443) to ObservaOne** and nothing else. ObservaOne must be reachable at that
address from the server: a laptop or WSL install is not reachable from cloud VMs.

**Windows / Docker / Kubernetes:** Agents → *platform* → Install shows the command for the previous agent.

**Safety built in**
- Linux agent: the enrollment token is swapped once for the agent's own credential; ObservaOne decides the agent's identity and the `host` label on its metrics. Revoking a token stops new enrollments; **Block** or **Remove** cuts off one server at once.
- Previous agent (Windows / Docker / Kubernetes): the token is checked on every upload. Revoking it stops every agent using it within a minute.
- Self-signed certificate? The command pins your server's certificate fingerprint. Agents refuse any other server, so there is no "ignore certificate errors".
- Every download is checked against a fixed SHA-256 before it is installed.
- Linux: runs as the unprivileged user `observaone-agent` in a hardened systemd unit (read-only system, 128 MB memory cap); its diagnostics page listens on 127.0.0.1 only.
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

Every page shows only real data. Until something sends logs, traces or application metrics, the **Logs**, **Traces** and **Services** pages show an empty state that says what to connect. There is no demo or sample data.

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

Data appears on the Logs and Traces pages as soon as it reaches Loki and Tempo. Check the connection in **Data Sources → Test**.

**Services page (request rate, latency, errors):** edit `observa-ui/config/services.json` so the 3 PromQL queries match your applications' metrics. Services with no requests show **No traffic**, not Down.

## 7. Alerts and email

- Alert rules are in `prometheus/rules/host-alerts.yml`: server down, CPU above 90%, memory above 90%, disk below 20% (warning) and below 10% (critical). After editing, run `docker compose restart prometheus`.
- Admins can also create rules in **Alerting → New Alert Rule**. The UI checks the query, writes the rule and reloads Prometheus. If Prometheus rejects the rule, the change is undone.
- To turn on **email**, fill in the `smtp_*` lines and `email_configs` in `alertmanager/alertmanager.yml`, then run `docker compose restart alertmanager`.
- To **silence** an alert (for example during maintenance), switch off **Notify** on it in Alerting. This needs the operator role or higher.

## 7b. Tests

The UI has an automated test suite (Node's built-in test runner, no extra packages):

```bash
cd observa-ui
npm ci            # once
npm test          # unit + source checks; API tests are skipped
```

To also run the API tests against a running ObservaOne (they change Settings > Modules and put it back afterwards):

```bash
OBSERVA_TEST_URL=https://SERVER OBSERVA_TEST_ADMIN_PASSWORD='...' \
OBSERVA_TEST_VIEWER_PASSWORD='...' NODE_TLS_REJECT_UNAUTHORIZED=0 npm test
```

`NODE_TLS_REJECT_UNAUTHORIZED=0` is only for the self-signed lab certificate. What is checked: no demo or sample data, health rules (no traffic, not reporting), module visibility on the API, permissions, no Grafana links in the UI, and that every page's imports exist.

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
