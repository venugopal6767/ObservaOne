#!/usr/bin/env bash
# ObservaOne Agent installer for Linux (systemd) and Docker hosts.
#
#   curl -fsSL https://SERVER/agent/install.sh | sudo bash -s -- --server https://SERVER --token oat_xxx
#
# Options:
#   --server URL        ObservaOne address, e.g. https://monitor.example.local          (required)
#   --token TOKEN       agent token from the Agents page (oat_...)                       (required on first install)
#   --ca-sha256 HEX     trust the server's own (self-signed) certificate with this SHA-256 fingerprint
#   --ca-file FILE      trust this CA file instead (your company CA)
#   --host NAME         name shown in ObservaOne (default: this server's short host name)
#   --env NAME          environment label, e.g. prod / uat / dev
#   --role NAME         role label, e.g. web / database / app
#   --logs "A,B"        extra log files or patterns, e.g. "/var/log/nginx/*.log,/opt/app/logs/*.log"
#   --docker            install as Docker containers (adds container metrics + container logs)
#   --files-dir DIR     take the downloads from this folder (servers without internet)
#   --uninstall         remove the agent
#
# Downloads come from SERVER/agent/files/ when the admin mirrored them there, otherwise from GitHub.
# Every download is checked against the SHA-256 below before it is used.
set -euo pipefail

AGENT_VERSION="1.0.0"
OTEL_VERSION="0.162.0"
NODE_EXPORTER_VERSION="1.12.1"
CADVISOR_VERSION="0.60.6"
declare -A SHA256=(
  ["otelcol-contrib_${OTEL_VERSION}_linux_amd64.tar.gz"]="fcc063749f730f8c21fe29f2d340ff174f5f1c5885bd3156fb6c985a3036fcc3"
  ["otelcol-contrib_${OTEL_VERSION}_linux_arm64.tar.gz"]="ecf6a917e2b53beb1703b19a84bc4e112a2fcaba549639cf6b0ba58446bfd7d2"
  ["node_exporter-${NODE_EXPORTER_VERSION}.linux-amd64.tar.gz"]="b51d8a76aa2a9156a55d501aca6276fae09e262259a5e4e831d2c2222f084e63"
  ["node_exporter-${NODE_EXPORTER_VERSION}.linux-arm64.tar.gz"]="ad35b605f9954b9f1ffddf5ba054bdc5a98d790b9eae5291e1eeb83f1ecbd0e7"
)

PREFIX=/opt/observaone-agent
ETC=/etc/observaone-agent
VAR=/var/lib/observaone-agent
SVC_USER=observaone-agent
NODE_EXPORTER_ADDR=127.0.0.1:9101

SERVER="" TOKEN="" CA_SHA="" CA_FILE_IN="" HOST_NAME="" ENV_NAME="" ROLE="" EXTRA_LOGS="" MODE=systemd FILES_DIR="" UNINSTALL=0

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m OK\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="${2%/}"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --ca-sha256) CA_SHA="$(echo "$2" | tr 'A-F' 'a-f' | tr -d ':')"; shift 2 ;;
    --ca-file) CA_FILE_IN="$2"; shift 2 ;;
    --host) HOST_NAME="$2"; shift 2 ;;
    --env) ENV_NAME="$2"; shift 2 ;;
    --role) ROLE="$2"; shift 2 ;;
    --logs) EXTRA_LOGS="$2"; shift 2 ;;
    --docker) MODE=docker; shift ;;
    --files-dir) FILES_DIR="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,22p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Run as root (sudo)."

# ---------------------------------------------------------------- uninstall
if [ "$UNINSTALL" -eq 1 ]; then
  say "Removing ObservaOne Agent"
  if [ -f "$PREFIX/docker-compose.yml" ] && command -v docker >/dev/null 2>&1; then
    (cd "$PREFIX" && docker compose down -v) || true
  fi
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now observaone-agent.service observaone-node-exporter.service 2>/dev/null || true
    rm -f /etc/systemd/system/observaone-agent.service /etc/systemd/system/observaone-node-exporter.service
    systemctl daemon-reload || true
  fi
  rm -rf "$PREFIX" "$ETC" "$VAR"
  id "$SVC_USER" >/dev/null 2>&1 && userdel "$SVC_USER" 2>/dev/null || true
  ok "Agent removed. Forget it on the Agents page if you do not reinstall it."
  exit 0
fi

# ---------------------------------------------------------------- checks
[ -n "$SERVER" ] || die "--server is required, e.g. --server https://monitor.example.local"
case "$SERVER" in https://*) ;; *) die "--server must start with https://" ;; esac
if [ -z "$TOKEN" ] && [ -s "$ETC/token" ]; then TOKEN="$(cat "$ETC/token")"; say "Re-using the token already on this server"; fi
[ -n "$TOKEN" ] || die "--token is required (create one on the Agents page)"
[[ "$TOKEN" =~ ^oat_[0-9a-f]{8}_[A-Za-z0-9_-]{20,64}$ ]] || die "That does not look like an agent token (oat_...)"
for c in curl tar sha256sum; do command -v "$c" >/dev/null 2>&1 || die "'$c' is needed. Install it first."; done
if [ "$MODE" = systemd ]; then
  command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] || die "systemd not found. Use --docker on container hosts."
else
  command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 || die "Docker with the compose plugin is needed for --docker."
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "CPU type $(uname -m) is not supported (amd64 and arm64 are)." ;;
esac
OS_NAME="$( . /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-Linux}" || echo Linux)"
OS_NAME="$(echo "$OS_NAME" | tr -d "'\"\\$\`")"   # used inside quoted settings files
[ -n "$HOST_NAME" ] || HOST_NAME="$(hostname -s 2>/dev/null || hostname)"
HOST_NAME="$(echo "$HOST_NAME" | tr -cd 'A-Za-z0-9._-')"
[[ "$ENV_NAME$ROLE" =~ ^[A-Za-z0-9._-]*$ ]] || die "--env and --role may only use letters, digits, . _ -"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
CURL=(curl -fsSL --retry 3 --connect-timeout 15)

# ---------------------------------------------------------------- trust the server
CA_FILE=""
if [ -n "$CA_FILE_IN" ]; then
  [ -s "$CA_FILE_IN" ] || die "CA file $CA_FILE_IN not found"
  CA_FILE="$CA_FILE_IN"
elif [ -n "$CA_SHA" ]; then
  say "Fetching the server certificate"
  curl -fsSk --connect-timeout 15 "$SERVER/agent/server.crt" -o "$TMP/server.crt" || die "Cannot reach $SERVER"
  # fingerprint = SHA-256 of the certificate itself (DER), the same value a browser shows
  GOT="$(sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/{p;/-----END CERTIFICATE-----/q}' "$TMP/server.crt" | sed '/-----/d' | tr -d '\r\n' | base64 -d 2>/dev/null | sha256sum | cut -d' ' -f1)"
  [ "$GOT" = "$CA_SHA" ] || die "Certificate fingerprint does not match. Expected $CA_SHA, got $GOT. Do not continue: you may not be talking to your ObservaOne server."
  CA_FILE="$TMP/server.crt"
  ok "Server certificate fingerprint matches"
fi
SRV_CURL=("${CURL[@]}")
[ -n "$CA_FILE" ] && SRV_CURL+=(--cacert "$CA_FILE")

# ---------------------------------------------------------------- agent id (kept across re-installs)
install -d -m 0750 "$VAR"
[ -s "$VAR/agent-id" ] || cat /proc/sys/kernel/random/uuid > "$VAR/agent-id"
AGENT_ID="$(cat "$VAR/agent-id")"

# ---------------------------------------------------------------- test the token before installing anything
say "Checking the token with $SERVER"
CODE="$("${SRV_CURL[@]}" -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $TOKEN" -H "X-Agent-Id: $AGENT_ID" -H "X-Agent-Host: $HOST_NAME" -H "X-Agent-Platform: $([ "$MODE" = docker ] && echo docker || echo linux)" \
  -H "X-Agent-Version: $AGENT_VERSION" -H "X-Agent-Os: $OS_NAME" -H "X-Agent-Arch: $ARCH" \
  -H "X-Agent-Env: $ENV_NAME" -H "X-Agent-Role: $ROLE" \
  -H "Content-Type: application/x-protobuf" --data-binary '' "$SERVER/ingest/agent/metrics" 2>/dev/null || true)"
case "$CODE" in
  2??|400) ok "Token accepted" ;;
  401) die "The server refused the token (wrong, revoked or expired). Create a new one on the Agents page." ;;
  403) die "This agent is blocked on the Agents page, or the host name is missing." ;;
  000) die "Cannot connect to $SERVER over HTTPS. Check DNS, firewall (port 443) and the certificate (--ca-sha256 / --ca-file)." ;;
  *) die "Unexpected answer from the server (HTTP $CODE)." ;;
esac

# ---------------------------------------------------------------- downloads
fetch() { # fetch FILE GITHUB_URL -> $TMP/FILE, checked
  local f="$1" gh="$2" want="${SHA256[$1]:-}"
  [ -n "$want" ] || die "No checksum known for $f"
  if [ -n "$FILES_DIR" ] && [ -s "$FILES_DIR/$f" ]; then
    cp "$FILES_DIR/$f" "$TMP/$f"
  elif "${SRV_CURL[@]}" -o "$TMP/$f" "$SERVER/agent/files/$f" 2>/dev/null; then
    :
  else
    say "Downloading $f from GitHub"
    "${CURL[@]}" -o "$TMP/$f" "$gh" || die "Download failed: $gh (no internet? use --files-dir or ask the admin to run scripts/fetch-agent-files.sh)"
  fi
  local got; got="$(sha256sum "$TMP/$f" | cut -d' ' -f1)"
  [ "$got" = "$want" ] || die "Checksum mismatch for $f (got $got). The file is damaged or was changed. Not installing."
  ok "$f verified"
}

write_settings() { # common files in $ETC
  install -d -m 0755 "$ETC"
  umask 027
  printf '%s' "$TOKEN" > "$ETC/token"
  if [ -n "$CA_FILE" ]; then cp "$CA_FILE" "$ETC/ca.crt"; CA_DEST="$1/ca.crt"; else rm -f "$ETC/ca.crt"; CA_DEST=""; fi
  umask 022
  # log files: system logs that exist + the ones you asked for
  local files=() f
  for f in /var/log/syslog /var/log/messages /var/log/auth.log /var/log/secure /var/log/kern.log; do [ -e "$f" ] && files+=("$f"); done
  SYSTEM_FILES=${#files[@]}
  IFS=',' read -r -a extra <<< "$EXTRA_LOGS"
  for f in "${extra[@]}"; do f="$(echo "$f" | xargs)"; [ -n "$f" ] && files+=("$f"); done
  [ ${#files[@]} -gt 0 ] || files=("/var/log/observaone-agent/none.log")
  LOG_FILES="[$(printf '"%s",' "${files[@]}" | sed 's/,$//')]"
}

if [ "$MODE" = docker ]; then
  # ============================================================== Docker host
  say "Installing ObservaOne Agent $AGENT_VERSION as Docker containers"
  install -d -m 0755 "$PREFIX"
  write_settings /etc/observaone-agent
  "${SRV_CURL[@]}" -o "$PREFIX/docker-compose.yml" "$SERVER/agent/docker-compose.yml" || die "Cannot download docker-compose.yml from $SERVER/agent/"
  "${SRV_CURL[@]}" -o "$ETC/config.yaml" "$SERVER/agent/configs/docker.yaml" || die "Cannot download the agent config"
  cat > "$PREFIX/.env" <<EOF
OBSERVA_SERVER='$SERVER'
OBSERVA_HOST='$HOST_NAME'
OBSERVA_AGENT_ID='$AGENT_ID'
OBSERVA_ENV='$ENV_NAME'
OBSERVA_ROLE='$ROLE'
OBSERVA_OS='$OS_NAME (Docker)'
OBSERVA_ARCH='$ARCH'
OBSERVA_AGENT_VERSION='$AGENT_VERSION'
OBSERVA_CA_FILE='${CA_DEST}'
OBSERVA_LOG_FILES='$LOG_FILES'
OTEL_VERSION='$OTEL_VERSION'
NODE_EXPORTER_VERSION='$NODE_EXPORTER_VERSION'
CADVISOR_VERSION='$CADVISOR_VERSION'
EOF
  chmod 0640 "$PREFIX/.env"
  (cd "$PREFIX" && docker compose pull -q && docker compose up -d) || die "docker compose failed"
  sleep 8
  if (cd "$PREFIX" && docker compose ps --status running --services | grep -q agent); then
    ok "Agent containers are running. $HOST_NAME appears on the Agents page within a minute."
  else
    die "The agent container is not running. Look at: cd $PREFIX && docker compose logs agent"
  fi
  exit 0
fi

# ================================================================ systemd host
say "Installing ObservaOne Agent $AGENT_VERSION on $HOST_NAME ($OS_NAME, $ARCH)"
OT="otelcol-contrib_${OTEL_VERSION}_linux_${ARCH}.tar.gz"
NE="node_exporter-${NODE_EXPORTER_VERSION}.linux-${ARCH}.tar.gz"
fetch "$OT" "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${OTEL_VERSION}/${OT}"
fetch "$NE" "https://github.com/prometheus/node_exporter/releases/download/v${NODE_EXPORTER_VERSION}/${NE}"
"${SRV_CURL[@]}" -o "$TMP/config.yaml" "$SERVER/agent/configs/linux.yaml" || die "Cannot download the agent config from $SERVER/agent/configs/linux.yaml"

id "$SVC_USER" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir "$VAR" --shell /usr/sbin/nologin "$SVC_USER" 2>/dev/null \
  || useradd -r -M -d "$VAR" -s /sbin/nologin "$SVC_USER"
for g in adm systemd-journal; do getent group "$g" >/dev/null && usermod -aG "$g" "$SVC_USER"; done

systemctl stop observaone-agent.service observaone-node-exporter.service 2>/dev/null || true
install -d -m 0755 "$PREFIX/bin"
tar -xzf "$TMP/$OT" -C "$TMP" otelcol-contrib
tar -xzf "$TMP/$NE" -C "$TMP" --strip-components=1 "node_exporter-${NODE_EXPORTER_VERSION}.linux-${ARCH}/node_exporter"
install -m 0755 "$TMP/otelcol-contrib" "$PREFIX/bin/otelcol-contrib"
install -m 0755 "$TMP/node_exporter" "$PREFIX/bin/node_exporter"
echo "$AGENT_VERSION" > "$PREFIX/VERSION"

write_settings "$ETC"
install -m 0644 "$TMP/config.yaml" "$ETC/config.yaml"
RECEIVERS="[file_log]"
if [ "$SYSTEM_FILES" -eq 0 ] && command -v journalctl >/dev/null 2>&1; then RECEIVERS="[file_log, journald]"; fi
cat > "$ETC/agent.env" <<EOF
# ObservaOne Agent settings (keep the single quotes). After a change: systemctl restart observaone-agent
OBSERVA_SERVER='$SERVER'
OBSERVA_HOST='$HOST_NAME'
OBSERVA_AGENT_ID='$AGENT_ID'
OBSERVA_ENV='$ENV_NAME'
OBSERVA_ROLE='$ROLE'
OBSERVA_OS='$OS_NAME'
OBSERVA_ARCH='$ARCH'
OBSERVA_AGENT_VERSION='$AGENT_VERSION'
OBSERVA_CA_FILE='$CA_DEST'
OBSERVA_NODE_EXPORTER='$NODE_EXPORTER_ADDR'
OBSERVA_LOG_FILES='$LOG_FILES'
OBSERVA_LOG_RECEIVERS='$RECEIVERS'
EOF
chown -R root:"$SVC_USER" "$ETC"; chmod 0750 "$ETC"; chmod 0640 "$ETC"/*
rm -rf "$VAR/wal"   # left by agent 1.0 previews
chown -R "$SVC_USER":"$SVC_USER" "$VAR"

cat > /etc/systemd/system/observaone-node-exporter.service <<EOF
[Unit]
Description=ObservaOne Agent - node_exporter (local only)
After=network-online.target

[Service]
User=$SVC_USER
ExecStart=$PREFIX/bin/node_exporter --web.listen-address=$NODE_EXPORTER_ADDR --collector.systemd --collector.processes
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/observaone-agent.service <<EOF
[Unit]
Description=ObservaOne Agent (metrics, logs, traces)
After=network-online.target observaone-node-exporter.service
Wants=network-online.target observaone-node-exporter.service

[Service]
User=$SVC_USER
Group=$SVC_USER
EnvironmentFile=$ETC/agent.env
ExecStart=$PREFIX/bin/otelcol-contrib --config=$ETC/config.yaml
Restart=always
RestartSec=10
# read every log file without running as root
AmbientCapabilities=CAP_DAC_READ_SEARCH
CapabilityBoundingSet=CAP_DAC_READ_SEARCH
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$VAR
PrivateTmp=yes
MemoryMax=600M

[Install]
WantedBy=multi-user.target
EOF

say "Checking the configuration"
set -a; . "$ETC/agent.env"; set +a
"$PREFIX/bin/otelcol-contrib" validate --config="$ETC/config.yaml" >/dev/null || die "The agent configuration is not valid (see above)."

systemctl daemon-reload
systemctl enable --now observaone-node-exporter.service observaone-agent.service >/dev/null
for _ in $(seq 1 20); do
  curl -fsS -o /dev/null http://127.0.0.1:13133/ 2>/dev/null && break
  sleep 1
done
if curl -fsS -o /dev/null http://127.0.0.1:13133/ 2>/dev/null; then
  ok "ObservaOne Agent is running. $HOST_NAME appears on the Agents page within a minute."
  echo
  echo "  Status : systemctl status observaone-agent"
  echo "  Log    : journalctl -u observaone-agent -f"
  echo "  Config : $ETC/agent.env (log files, env, role)"
  echo "  Traces : send OpenTelemetry to 127.0.0.1:4317 (gRPC) or http://127.0.0.1:4318 (HTTP)"
  echo "  Remove : curl -fsSL $SERVER/agent/install.sh | sudo bash -s -- --uninstall"
else
  die "The agent did not start. Look at: journalctl -u observaone-agent -n 50"
fi
