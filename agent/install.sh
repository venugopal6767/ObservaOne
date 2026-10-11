#!/usr/bin/env bash
# ObservaOne Agent installer for Linux servers (systemd), Go agent 1.1.
#
#   curl -fsSL https://SERVER/agent/install.sh -o observaone-install.sh
#   sudo bash observaone-install.sh --server https://SERVER [--ca-sha256 HEX] [--env prod]
#   -> asks for the enrollment token (typing is hidden; it never lands in shell history or the process list)
#
# Options:
#   --server URL        ObservaOne address, https only                                     (required)
#   --token-file FILE   read the enrollment token from FILE instead of asking (automation); FILE is deleted after use
#   --ca-sha256 HEX     trust the server's self-signed certificate with this SHA-256 fingerprint
#   --ca-file FILE      trust this CA file (your company CA)
#   --host NAME         name shown in ObservaOne (default: this server's short host name)
#   --env NAME          environment label (prod / uat / dev)
#   --role NAME         role label (web / database / app)
#   --label KEY=VALUE   extra label, may be repeated (max 10)
#   --files-dir DIR     take the agent binary from this folder (no download)
#   --docker            Docker host: uses the previous-generation installer (install-legacy.sh)
#   --uninstall         stop and remove the agent (only its own files, user and service)
#
# Safe to run again: the agent keeps its identity, your edits in /etc/observaone-agent are kept,
# and an upgrade that fails to start is rolled back to the previous binary automatically.
set -euo pipefail

AGENT_VERSION="1.1.0"
PREFIX=/opt/observaone-agent
ETC=/etc/observaone-agent
VAR=/var/lib/observaone-agent
SVC=observaone-agent
SVC_USER=observaone-agent
UNIT=/etc/systemd/system/observaone-agent.service

SERVER="" TOKEN_FILE="" CA_SHA="" CA_FILE_IN="" HOST_NAME="" ENV_NAME="" ROLE="" FILES_DIR="" UNINSTALL=0 DOCKER=0
LABELS=()
ORIG_ARGS=("$@")

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m OK\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="${2%/}"; shift 2 ;;
    --token-file) TOKEN_FILE="$2"; shift 2 ;;
    --token) die "--token is not accepted (it would be stored in your shell history). Run without it and paste the token when asked, or use --token-file." ;;
    --ca-sha256) CA_SHA="$(echo "$2" | tr 'A-F' 'a-f' | tr -d ':')"; shift 2 ;;
    --ca-file) CA_FILE_IN="$2"; shift 2 ;;
    --host) HOST_NAME="$2"; shift 2 ;;
    --env) ENV_NAME="$2"; shift 2 ;;
    --role) ROLE="$2"; shift 2 ;;
    --label) LABELS+=("$2"); shift 2 ;;
    --files-dir) FILES_DIR="$2"; shift 2 ;;
    --docker) DOCKER=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,23p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Run as root (sudo)."

# ---------------------------------------------------------------- uninstall (only our own files)
if [ "$UNINSTALL" -eq 1 ]; then
  say "Removing ObservaOne Agent"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now observaone-agent.service observaone-node-exporter.service 2>/dev/null || true
    rm -f "$UNIT" /etc/systemd/system/observaone-node-exporter.service
    systemctl daemon-reload 2>/dev/null || true
  fi
  if [ -f "$PREFIX/docker-compose.yml" ] && command -v docker >/dev/null 2>&1; then (cd "$PREFIX" && docker compose down) || true; fi
  rm -rf "$PREFIX" "$ETC" "$VAR"
  id "$SVC_USER" >/dev/null 2>&1 && { userdel "$SVC_USER" 2>/dev/null || true; }
  ok "Agent removed. It shows as Offline in ObservaOne until you remove it on the Agents page."
  exit 0
fi

[ -n "$SERVER" ] || die "--server is required, e.g. --server https://monitor.example.com"
case "$SERVER" in https://*) ;; *) die "--server must start with https:// (plain http is not allowed)";; esac
case "$SERVER" in https://localhost*|https://127.*|https://\[::1\]*) die "--server points at this machine. Use the address of your ObservaOne server, as this server reaches it.";; esac

if [ "$DOCKER" -eq 1 ]; then
  say "Docker host: handing over to the previous-generation installer"
  CURLX=(curl -fsSL --connect-timeout 15); [ -n "$CA_FILE_IN" ] && CURLX+=(--cacert "$CA_FILE_IN")
  T="$(mktemp)"; "${CURLX[@]}" -o "$T" "$SERVER/agent/install-legacy.sh" || die "Cannot download install-legacy.sh"
  ARGS=(); for a in "${ORIG_ARGS[@]}"; do ARGS+=("$a"); done
  exec bash "$T" "${ARGS[@]}"
fi

# ---------------------------------------------------------------- checks
command -v curl >/dev/null 2>&1 || die "'curl' is needed. Install it first (apt install curl / dnf install curl)."
command -v sha256sum >/dev/null 2>&1 || die "'sha256sum' is needed (coreutils)."
{ command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; } || die "systemd not found. This installer is for systemd servers; for containers use --docker."
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "CPU type $(uname -m) is not supported (amd64 and arm64 are)." ;;
esac
OS_NAME="$( . /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-Linux}" || echo Linux)"
[[ "$ENV_NAME$ROLE" =~ ^[A-Za-z0-9._-]*$ ]] || die "--env and --role may only use letters, digits, . _ -"
[ -z "$HOST_NAME" ] || [[ "$HOST_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$ ]] || die "--host: letters, digits, . _ - (max 63)"
[ ${#LABELS[@]} -le 10 ] || die "At most 10 --label options."
for l in "${LABELS[@]}"; do [[ "$l" =~ ^[a-z][a-z0-9_]{0,30}=[A-Za-z0-9._-]{0,64}$ ]] || die "--label $l: use key=value, key in lower case (a-z 0-9 _), value letters/digits/. _ -"; done

TMP_BASE="${OBSERVA_TMPDIR:-/var/tmp}"; [ -d "$TMP_BASE" ] || TMP_BASE=/tmp
FREE_MB="$(df -Pm "$TMP_BASE" | awk 'NR==2 {print $4}')"; [ "${FREE_MB:-0}" -ge 50 ] || die "Only ${FREE_MB} MB free in $TMP_BASE; 50 MB needed."
FREE_MB="$(df -Pm /opt 2>/dev/null | awk 'NR==2 {print $4}')"; [ "${FREE_MB:-0}" -ge 50 ] || die "Only ${FREE_MB} MB free for /opt; 50 MB needed."
TMP="$(mktemp -d -p "$TMP_BASE" observaone.XXXXXX)"; trap 'rm -rf "$TMP"' EXIT
CURL=(curl -fsSL --retry 3 --connect-timeout 15 --max-time 300)

# ---------------------------------------------------------------- trust the server (TLS is always verified)
CA_FILE=""
if [ -n "$CA_FILE_IN" ]; then
  [ -s "$CA_FILE_IN" ] || die "CA file $CA_FILE_IN not found"
  CA_FILE="$CA_FILE_IN"
elif [ -n "$CA_SHA" ]; then
  say "Fetching the server certificate"
  # -k only for this one download; the certificate is then accepted ONLY if its fingerprint matches
  curl -fsSk --connect-timeout 15 "$SERVER/agent/server.crt" -o "$TMP/server.crt" || die "Cannot reach $SERVER (DNS, firewall: outbound 443?)"
  GOT="$(sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/{p;/-----END CERTIFICATE-----/q}' "$TMP/server.crt" | sed '/-----/d' | tr -d '\r\n' | base64 -d 2>/dev/null | sha256sum | cut -d' ' -f1)"
  [ "$GOT" = "$CA_SHA" ] || die "Certificate fingerprint does not match (expected $CA_SHA, got $GOT). Stop: you may not be talking to your ObservaOne server."
  CA_FILE="$TMP/server.crt"
  ok "Server certificate fingerprint matches"
elif [ -s "$ETC/ca.crt" ]; then
  CA_FILE="$ETC/ca.crt"   # re-run: keep trusting what was trusted before
fi
SRV_CURL=("${CURL[@]}"); [ -n "$CA_FILE" ] && SRV_CURL+=(--cacert "$CA_FILE")
"${SRV_CURL[@]}" -o /dev/null "$SERVER/agent/install.sh" 2>/dev/null \
  || die "Cannot reach $SERVER over HTTPS with a trusted certificate. Check DNS, firewall (outbound 443), and --ca-sha256 / --ca-file."

# ---------------------------------------------------------------- download + verify the agent
BIN="observaone-agent-linux-$ARCH"
say "Installing ObservaOne Agent $AGENT_VERSION on $(hostname) ($OS_NAME, $ARCH)"
if [ -n "$FILES_DIR" ]; then
  cp "$FILES_DIR/$BIN" "$TMP/$BIN" && cp "$FILES_DIR/SHA256SUMS" "$TMP/SHA256SUMS" || die "$BIN or SHA256SUMS missing in $FILES_DIR"
else
  "${SRV_CURL[@]}" -o "$TMP/SHA256SUMS" "$SERVER/agent/files/SHA256SUMS" || die "Cannot download SHA256SUMS from $SERVER/agent/files/ (did the server build the agent? see agent-build in docker compose)"
  "${SRV_CURL[@]}" -o "$TMP/$BIN" "$SERVER/agent/files/$BIN" || die "Cannot download $BIN from $SERVER/agent/files/"
fi
WANT="$(awk -v f="$BIN" '$2==f || $2=="*"f {print $1}' "$TMP/SHA256SUMS")"
GOT="$(sha256sum "$TMP/$BIN" | cut -d' ' -f1)"
[ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || die "Checksum mismatch for $BIN (want ${WANT:-none}, got $GOT). Not installing."
chmod 0755 "$TMP/$BIN"
"$TMP/$BIN" version >/dev/null 2>&1 || die "The downloaded agent does not run on this machine."
ok "$BIN verified ($("$TMP/$BIN" version))"

# ---------------------------------------------------------------- user, folders
id "$SVC_USER" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir "$VAR" --shell /usr/sbin/nologin "$SVC_USER" 2>/dev/null \
  || useradd -r -M -d "$VAR" -s /sbin/nologin "$SVC_USER"
install -d -m 0755 "$PREFIX" "$PREFIX/bin"
install -d -m 0750 -o root -g "$SVC_USER" "$ETC" "$ETC/conf.d"
install -d -m 0750 -o "$SVC_USER" -g "$SVC_USER" "$VAR"

# ---------------------------------------------------------------- configuration (your edits are kept)
CONF="$ETC/agent.conf"
setkey() { # setkey KEY VALUE: replace the line if present, else append
  local k="$1" v="$2"
  if grep -qE "^[[:space:]]*${k//./\\.}[[:space:]]*=" "$CONF"; then
    local tmp; tmp="$(mktemp -p "$ETC")"
    awk -v k="$k" -v v="$v" 'BEGIN{done=0} { if (!done && $0 ~ "^[[:space:]]*"k"[[:space:]]*=") { print k" = "v; done=1 } else print }' "$CONF" > "$tmp"
    cat "$tmp" > "$CONF"; rm -f "$tmp"
  else
    printf '%s = %s\n' "$k" "$v" >> "$CONF"
  fi
}
if [ ! -f "$CONF" ]; then
  cat > "$CONF" <<EOF
# ObservaOne Agent configuration. Edit freely; the installer keeps your changes.
# More settings can go in $ETC/conf.d/*.conf (read in name order; later files win).
# After a change:  sudo observaone-agent check-config && sudo systemctl reload observaone-agent
# See every setting in effect and where it comes from:  sudo observaone-agent config show
config_version = 1

# Where the agent sends data. Must be https and reachable from THIS server (never localhost).
server = $SERVER

# Labels on every metric of this host
env =
role =
# label.team = payments

# How often to collect (5s..5m) and to send a heartbeat (the server may suggest another value)
collect_interval = 15s
# heartbeat_interval = 30s

# Turn collectors off: cpu, memory, load, uptime, filesystem, disk, network, system, agent
# disable =

# Local diagnostics page, loopback only (curl http://127.0.0.1:9109/metrics). Empty = off.
listen = 127.0.0.1:9109

# Collections kept while the server is unreachable (each ~15 s; 40 = 10 minutes)
buffer_payloads = 40
EOF
fi
setkey server "$SERVER"
[ -n "$ENV_NAME" ] && setkey env "$ENV_NAME"
[ -n "$ROLE" ] && setkey role "$ROLE"
[ -n "$HOST_NAME" ] && setkey hostname "$HOST_NAME"
for l in "${LABELS[@]}"; do setkey "label.${l%%=*}" "${l#*=}"; done
if [ -n "$CA_FILE" ] && [ "$CA_FILE" != "$ETC/ca.crt" ]; then install -m 0644 "$CA_FILE" "$ETC/ca.crt"; fi
[ -s "$ETC/ca.crt" ] && setkey ca_file "$ETC/ca.crt"
chown root:"$SVC_USER" "$CONF"; chmod 0640 "$CONF"

# ---------------------------------------------------------------- binary (keep the previous one for rollback)
NEW="$PREFIX/bin/observaone-agent"
if [ -x "$NEW" ]; then cp -p "$NEW" "$NEW.prev"; fi
install -m 0755 "$TMP/$BIN" "$NEW.new" && mv -f "$NEW.new" "$NEW"
ln -sf "$NEW" /usr/local/bin/observaone-agent
echo "$AGENT_VERSION" > "$PREFIX/VERSION"

say "Checking the configuration"
runuser -u "$SVC_USER" -- "$NEW" check-config --config "$CONF" || die "The configuration is not valid (see above). Fix $CONF and run the installer again."

# ---------------------------------------------------------------- enrollment (once; identity is kept on re-runs)
if [ -s "$VAR/credential" ] && [ -s "$VAR/identity.json" ]; then
  ok "Already enrolled ($(sed -n 's/.*"agentId": *"\([^"]*\)".*/\1/p' "$VAR/identity.json")): keeping this identity"
else
  TF="$VAR/enroll-token"
  ( umask 077; : > "$TF" )
  chown "$SVC_USER":"$SVC_USER" "$TF"
  if [ -n "$TOKEN_FILE" ]; then
    [ -s "$TOKEN_FILE" ] || die "--token-file $TOKEN_FILE is empty or missing"
    cat "$TOKEN_FILE" > "$TF"; rm -f "$TOKEN_FILE"
  else
    [ -r /dev/tty ] || die "No terminal to ask for the token. Use --token-file FILE."
    printf 'Paste the enrollment token from the Agents page (input hidden): ' > /dev/tty
    IFS= read -rs TOKEN < /dev/tty; echo > /dev/tty
    printf '%s' "$TOKEN" > "$TF"; unset TOKEN
  fi
  say "Enrolling with $SERVER"
  if ! runuser -u "$SVC_USER" -- "$NEW" enroll --config "$CONF" --token-file "$TF"; then
    rm -f "$TF"
    die "Enrollment failed (see above). Nothing was started."
  fi
  rm -f "$TF"
fi

# ---------------------------------------------------------------- previous-generation agent (otelcol + node_exporter)
if [ -f /etc/systemd/system/observaone-node-exporter.service ] || [ -x "$PREFIX/bin/otelcol-contrib" ]; then
  say "Replacing the previous-generation agent (otelcol + node_exporter)"
  systemctl disable --now observaone-node-exporter.service 2>/dev/null || true
  rm -f /etc/systemd/system/observaone-node-exporter.service "$PREFIX/bin/otelcol-contrib" "$PREFIX/bin/node_exporter" "$ETC/config.yaml" "$ETC/agent.env" "$ETC/token"
  rm -rf "$VAR/queue"
fi

# ---------------------------------------------------------------- systemd service
cat > "$UNIT" <<EOF
[Unit]
Description=ObservaOne Agent
Documentation=https://github.com/venugopal6767/ObservaOne
After=network-online.target
Wants=network-online.target

[Service]
User=$SVC_USER
Group=$SVC_USER
ExecStart=$NEW run --config $CONF
ExecReload=/bin/kill -HUP \$MAINPID
Restart=on-failure
RestartSec=10
TimeoutStopSec=15
# least privilege: no root, no new privileges, read-only system, writes only to its own state folder
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$VAR
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryMax=128M
CPUQuota=25%

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable observaone-agent.service >/dev/null 2>&1
systemctl restart observaone-agent.service

# ---------------------------------------------------------------- wait for the first heartbeat; roll back a failed upgrade
say "Waiting for the first heartbeat"
OKHB=0
for _ in $(seq 1 45); do
  if [ -s "$VAR/status.json" ] && grep -q '"lastHeartbeatOk": "' "$VAR/status.json"; then OKHB=1; break; fi
  sleep 1
done
if [ "$OKHB" -eq 1 ]; then
  rm -f "$NEW.prev.failed"
  ok "ObservaOne Agent is running and connected."
  "$NEW" status --config "$CONF" || true
  echo
  echo "  Status   : sudo observaone-agent status        |  systemctl status observaone-agent"
  echo "  Logs     : journalctl -u observaone-agent -f"
  echo "  Config   : $CONF (+ $ETC/conf.d/*.conf), then: sudo systemctl reload observaone-agent"
  echo "  Settings : sudo observaone-agent config show"
  echo "  Remove   : sudo bash $0 --uninstall"
else
  warn "No heartbeat within 45 s. Last log lines:"
  journalctl -u observaone-agent -n 15 --no-pager 2>/dev/null || true
  if [ -x "$NEW.prev" ]; then
    warn "Rolling back to the previous agent binary"
    mv -f "$NEW" "$NEW.prev.failed"; mv -f "$NEW.prev" "$NEW"
    systemctl restart observaone-agent.service || true
    die "Upgrade failed and was rolled back. The new binary is kept as $NEW.prev.failed for inspection."
  fi
  die "The agent started but has not reached $SERVER yet. Check: sudo observaone-agent status ; journalctl -u observaone-agent -n 50"
fi
