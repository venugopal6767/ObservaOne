#!/usr/bin/env bash
# ObservaOne Agent installer for Linux servers (systemd), Go agent 1.2.
#
#   curl -fsSL https://SERVER/agent/install.sh -o observaone-install.sh
#   sudo bash observaone-install.sh --server https://SERVER [--ca-sha256 HEX] [--env prod]
#   -> asks for the enrollment token (typing is hidden; it never lands in shell history or the process list)
#
# Options:
#   --server URL        ObservaOne address, https only                                     (required)
#   --token TOKEN       enrollment token (one use, short-lived; the Agents page puts it in the command). Also: OBSERVAONE_TOKEN
#   --token-file FILE   read the enrollment token from FILE instead of asking (automation); FILE is deleted after use
#   --ca-sha256 HEX     trust the server's self-signed certificate with this SHA-256 fingerprint
#   --ca-file FILE      trust this CA file (your company CA)
#   --host NAME         name shown in ObservaOne (default: this server's short host name)
#   --env NAME          environment label (prod / uat / dev)
#   --role NAME         role label (web / database / app)
#   --label KEY=VALUE   extra label, may be repeated (max 10)
#   --mode push|pull    push (default): send metrics to ObservaOne (outbound 443 only)
#                       pull: ObservaOne's Prometheus scrapes this server (inbound port, mutual TLS)
#   --pull-port N       pull mode: port to listen on (default 9110)
#   --pull-advertise A  pull mode: address Prometheus should use (NAT / several interfaces), e.g. 10.0.0.5
#   --pull-allow CIDR   pull mode: only these source addresses may connect, may be repeated
#   --docker-metrics    also read Docker containers (adds the agent user to the docker group: root-equivalent)
#   --nginx-status URL  read Nginx stub_status, e.g. http://127.0.0.1/nginx_status
#   --jolokia NAME=URL  read a JVM through Jolokia (NAME becomes service_name), may be repeated
#   --exporter NAME=URL read a local Prometheus exporter and forward it, may be repeated
#   --disk-buffer       push mode: keep up to 100 MB / 2 h of collections on disk during long outages
#   --trust-new-release-key  accept a release signing key that differs from the one pinned at first install
#   --files-dir DIR     take the agent binary from this folder (no download)
#   --docker            Docker host: uses the previous-generation installer (install-legacy.sh)
#   --uninstall         stop and remove the agent (only its own files, user and service)
#
# Safe to run again: the agent keeps its identity, your edits in /etc/observaone-agent are kept,
# and an upgrade that fails to start is rolled back to the previous binary automatically.
# An old agent.conf (agent 1.1) is converted to agent.yaml once (the old file is kept as agent.conf.migrated).
set -euo pipefail

AGENT_VERSION="1.3.1"
PREFIX=/opt/observaone-agent
ETC=/etc/observaone-agent
VAR=/var/lib/observaone-agent
SVC=observaone-agent
SVC_USER=observaone-agent
UNIT=/etc/systemd/system/observaone-agent.service

SERVER="" TOKEN_FILE="" TOKEN_ARG="${OBSERVAONE_TOKEN:-}" CA_SHA="" CA_FILE_IN="" HOST_NAME="" ENV_NAME="" ROLE="" FILES_DIR="" UNINSTALL=0 DOCKER=0
MODE="" PULL_PORT="" PULL_ADVERTISE="" DOCKER_METRICS=0 NGINX_URL=""
JOLOKIA=() EXPORTERS=() NEW_RELKEY=0 DISK_BUFFER=0
LABELS=() PULL_ALLOW=()
ORIG_ARGS=("$@")

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m OK\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="${2%/}"; shift 2 ;;
    --token-file) TOKEN_FILE="$2"; shift 2 ;;
    --token) TOKEN_ARG="$2"; shift 2 ;;   # one-use, short-lived: worthless once this host enrolled (it stays in shell history)
    --ca-sha256) CA_SHA="$(echo "$2" | tr 'A-F' 'a-f' | tr -d ':')"; shift 2 ;;
    --ca-file) CA_FILE_IN="$2"; shift 2 ;;
    --host) HOST_NAME="$2"; shift 2 ;;
    --env) ENV_NAME="$2"; shift 2 ;;
    --role) ROLE="$2"; shift 2 ;;
    --label) LABELS+=("$2"); shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --pull-port) PULL_PORT="$2"; shift 2 ;;
    --pull-advertise) PULL_ADVERTISE="$2"; shift 2 ;;
    --pull-allow) PULL_ALLOW+=("$2"); shift 2 ;;
    --docker-metrics) DOCKER_METRICS=1; shift ;;
    --nginx-status) NGINX_URL="$2"; shift 2 ;;
    --jolokia) JOLOKIA+=("$2"); shift 2 ;;
    --exporter) EXPORTERS+=("$2"); shift 2 ;;
    --trust-new-release-key) NEW_RELKEY=1; shift ;;
    --disk-buffer) DISK_BUFFER=1; shift ;;
    --files-dir) FILES_DIR="$2"; shift 2 ;;
    --docker) DOCKER=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,35p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Run as root (sudo)."

# ---------------------------------------------------------------- uninstall (only our own files)
if [ "$UNINSTALL" -eq 1 ]; then
  say "Removing ObservaOne Agent"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now observaone-agent.service observaone-agent-updater.path observaone-node-exporter.service 2>/dev/null || true
    rm -f "$UNIT" /etc/systemd/system/observaone-node-exporter.service /etc/systemd/system/observaone-agent-updater.path /etc/systemd/system/observaone-agent-updater.service
    systemctl daemon-reload 2>/dev/null || true
  fi
  if [ -f "$PREFIX/docker-compose.yml" ] && command -v docker >/dev/null 2>&1; then (cd "$PREFIX" && docker compose down) || true; fi
  rm -rf "$PREFIX" "$ETC" "$VAR"; rm -f /usr/local/bin/observaone-agent
  id "$SVC_USER" >/dev/null 2>&1 && { userdel "$SVC_USER" 2>/dev/null || true; }
  ok "Agent removed. It shows as Not reporting in ObservaOne until you remove it on the Agents page."
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
case "$MODE" in ""|push|pull) ;; *) die "--mode must be push or pull" ;; esac
[ -z "$PULL_PORT" ] || { [[ "$PULL_PORT" =~ ^[0-9]{4,5}$ ]] && [ "$PULL_PORT" -ge 1024 ] && [ "$PULL_PORT" -le 65535 ]; } || die "--pull-port must be 1024..65535 (the agent does not run as root)"
[ -z "$PULL_ADVERTISE" ] || [[ "$PULL_ADVERTISE" =~ ^[A-Za-z0-9.:_\[\]-]{1,255}$ ]] || die "--pull-advertise: a host name or IP, optionally :port"
for a in "${PULL_ALLOW[@]}"; do [[ "$a" =~ ^[0-9A-Fa-f.:]+(/[0-9]{1,3})?$ ]] || die "--pull-allow $a: an IP address or CIDR"; done
URL_RE='^https?://[A-Za-z0-9._~:@%/?&=+-]{1,400}$'
[ -z "$NGINX_URL" ] || [[ "$NGINX_URL" =~ $URL_RE ]] || die "--nginx-status: an http:// or https:// URL"
for j in "${JOLOKIA[@]}" "${EXPORTERS[@]}"; do [[ "${j%%=*}" =~ ^[a-z][a-z0-9_]{0,30}$ ]] && [[ "${j#*=}" =~ $URL_RE ]] || die "$j: use name=URL (name lower case a-z 0-9 _; URL http:// or https://)"; done

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
  cp "$FILES_DIR/SHA256SUMS.sig" "$TMP/" 2>/dev/null || true; cp "$FILES_DIR/release.pub" "$TMP/" 2>/dev/null || true
else
  "${SRV_CURL[@]}" -o "$TMP/SHA256SUMS" "$SERVER/agent/files/SHA256SUMS" || die "Cannot download SHA256SUMS from $SERVER/agent/files/ (did the server build the agent? see agent-build in docker compose)"
  "${SRV_CURL[@]}" -o "$TMP/$BIN" "$SERVER/agent/files/$BIN" || die "Cannot download $BIN from $SERVER/agent/files/"
  "${SRV_CURL[@]}" -o "$TMP/SHA256SUMS.sig" "$SERVER/agent/files/SHA256SUMS.sig" 2>/dev/null || rm -f "$TMP/SHA256SUMS.sig"
  "${SRV_CURL[@]}" -o "$TMP/release.pub" "$SERVER/agent/files/release.pub" 2>/dev/null || rm -f "$TMP/release.pub"
fi
# ---- release signature: SHA256SUMS must be signed by the release key pinned at the first install ----
# Verifier: the agent ALREADY installed here (trusted), else openssl (3.x); on a first install without either,
# the download is trusted through the pinned TLS connection and SHA256SUMS only, and the key is pinned now.
PINNED="$ETC/release.pub"
if [ -s "$PINNED" ] && [ -s "$TMP/release.pub" ] && ! cmp -s "$PINNED" "$TMP/release.pub"; then
  [ "$NEW_RELKEY" -eq 1 ] || die "The server's release signing key differs from the one pinned at install ($PINNED). If the server was rebuilt on purpose, run again with --trust-new-release-key; otherwise stop: this may not be your server's build."
  warn "Trusting a new release signing key (--trust-new-release-key)"
  PINNED_NEW=1
fi
KEY="$PINNED"; { [ -s "$KEY" ] && [ "${PINNED_NEW:-0}" -eq 0 ]; } || KEY="$TMP/release.pub"
if [ -s "$TMP/SHA256SUMS.sig" ] && [ -s "$KEY" ]; then
  IV="$("$PREFIX/bin/observaone-agent" version 2>/dev/null | awk '{print $2}' || true)"
  # the installed agent verifies if it knows the command (1.3+; older ones answer with their usage line)
  VR="$("$PREFIX/bin/observaone-agent" verify-release 2>&1 || true)"
  if [ -n "$IV" ] && ! grep -q '^usage:' <<<"$VR"; then
    "$PREFIX/bin/observaone-agent" verify-release --key "$KEY" --sums "$TMP/SHA256SUMS" --sig "$TMP/SHA256SUMS.sig" >/dev/null 2>&1 \
      || die "SIGNATURE MISMATCH: SHA256SUMS was not signed by the release key. Not installing."
    ok "Release signature verified (by the installed agent $IV)"
  elif command -v openssl >/dev/null && openssl pkeyutl -help 2>&1 | grep -q rawin; then
    base64 -d "$TMP/SHA256SUMS.sig" > "$TMP/sig.bin" 2>/dev/null || die "Release signature unreadable. Not installing."
    openssl pkeyutl -verify -pubin -inkey "$KEY" -rawin -in "$TMP/SHA256SUMS" -sigfile "$TMP/sig.bin" >/dev/null 2>&1 \
      || die "SIGNATURE MISMATCH: SHA256SUMS was not signed by the release key. Not installing."
    ok "Release signature verified (openssl)"
  else
    warn "No signature verifier on this host yet (first install, openssl < 3): trusting the pinned TLS connection and SHA256SUMS; later upgrades are signature-checked"
  fi
elif [ -s "$PINNED" ]; then
  die "The server publishes no release signature, but this host pinned a release key. Not installing an unsigned build."
else
  warn "The server publishes no release signature (older server build): trusting the pinned TLS connection and SHA256SUMS"
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
chown -R "$SVC_USER":"$SVC_USER" "$VAR"   # its own state only (a re-created user may have another uid)

# ---------------------------------------------------------------- configuration (your edits are kept)
CONF="$ETC/agent.yaml"
# agent 1.1 left agent.conf: convert it once with the NEW binary (same settings, old file kept as *.migrated)
MIGRATED=0
if [ -f "$ETC/agent.conf" ] && [ ! -f "$CONF" ]; then
  say "Converting $ETC/agent.conf to agent.yaml"
  MIGRATED=1
  [ -f "$UNIT" ] && cp -p "$UNIT" "$UNIT.prev"   # the 1.1 unit (--config agent.conf), for a rollback
  "$TMP/$BIN" config migrate --config "$ETC/agent.conf" || die "Could not convert $ETC/agent.conf (see above). Fix it, or move it away and run the installer again."
fi
ysetkey() { # ysetkey KEY VALUE: set a top-level "key: value" line in agent.yaml (replace or append)
  local k="$1" v="$2" tmp
  tmp="$(mktemp -p "$ETC")"
  awk -v k="$k" -v v="$v" 'BEGIN{done=0} { if (!done && $0 ~ "^"k":") { print k": \""v"\""; done=1 } else print } END { if (!done) print k": \""v"\"" }' "$CONF" > "$tmp"
  cat "$tmp" > "$CONF"; rm -f "$tmp"
}
NEW_CONF=0
if [ ! -f "$CONF" ]; then
  NEW_CONF=1
  {
    cat <<EOF
# ObservaOne Agent configuration. Edit freely; the installer keeps your changes.
# More settings can go in $ETC/conf.d/*.yaml (read in name order; later files win).
# After a change:  sudo observaone-agent check-config && sudo systemctl reload observaone-agent
# See every setting in effect and where it comes from:  sudo observaone-agent config show
config_version: 2

# Where the agent sends heartbeats (and metrics in push mode). https, reachable from THIS server.
server: "$SERVER"

# Labels on every metric of this host
env: ""
role: ""
labels:
EOF
    for l in "${LABELS[@]}"; do printf '  %s: "%s"\n' "${l%%=*}" "${l#*=}"; done
    [ ${#LABELS[@]} -gt 0 ] || echo "  # team: payments"
    cat <<EOF

# push: the agent sends metrics to ObservaOne (only outbound HTTPS 443 is needed).
# pull: ObservaOne's Prometheus scrapes this agent on pull.listen (inbound port; mutual TLS, certificates
#       are issued by ObservaOne automatically). Changing mode needs a restart, not just a reload.
mode: ${MODE:-push}
pull:
  listen: ":${PULL_PORT:-9110}"
EOF
    if [ -n "$PULL_ADVERTISE" ]; then printf '  advertise: "%s"\n' "$PULL_ADVERTISE"; else echo '  # advertise: "10.0.0.5"          # address Prometheus should use (NAT, several interfaces)'; fi
    if [ ${#PULL_ALLOW[@]} -gt 0 ]; then printf '  allow: [%s]\n' "$(IFS=,; echo "${PULL_ALLOW[*]}" | sed 's/,/, /g')"; else echo '  # allow: [10.0.0.0/8]             # only these source addresses may connect'; fi
    cat <<EOF

# How often to collect (5s..5m) and to send a heartbeat (the server may suggest another value)
collect_interval: 15s
# heartbeat_interval: 30s

# Turn collectors off: cpu, memory, load, uptime, filesystem, disk, network, system, agent
# disable: [network]

# Local diagnostics page, loopback only (curl http://127.0.0.1:9109/metrics). Empty = off.
listen: "127.0.0.1:9109"

# Push mode: collections kept while the server is unreachable (each ~15 s; 40 = 10 minutes)
buffer_payloads: 40
EOF
  } > "$CONF"
fi
ysetkey server "$SERVER"
[ -n "$ENV_NAME" ] && ysetkey env "$ENV_NAME"
[ -n "$ROLE" ] && ysetkey role "$ROLE"
[ -n "$HOST_NAME" ] && ysetkey hostname "$HOST_NAME"
[ -n "$MODE" ] && [ "$NEW_CONF" -eq 0 ] && ysetkey mode "$MODE"
# re-run with labels / pull options on an existing agent.yaml: they go into their own file, so nested
# sections you edited by hand are never rewritten (conf.d files are read after agent.yaml and win)
if [ "$NEW_CONF" -eq 0 ] && { [ ${#LABELS[@]} -gt 0 ] || [ -n "$PULL_PORT$PULL_ADVERTISE" ] || [ ${#PULL_ALLOW[@]} -gt 0 ]; }; then
  OPT="$ETC/conf.d/50-installer.yaml"
  {
    echo "# Written by the installer from its command-line options (last run: $(date -u +%Y-%m-%dT%H:%MZ))."
    if [ ${#LABELS[@]} -gt 0 ]; then echo "labels:"; for l in "${LABELS[@]}"; do printf '  %s: "%s"\n' "${l%%=*}" "${l#*=}"; done; fi
    if [ -n "$PULL_PORT$PULL_ADVERTISE" ] || [ ${#PULL_ALLOW[@]} -gt 0 ]; then
      echo "pull:"
      [ -n "$PULL_PORT" ] && printf '  listen: ":%s"\n' "$PULL_PORT"
      [ -n "$PULL_ADVERTISE" ] && printf '  advertise: "%s"\n' "$PULL_ADVERTISE"
      [ ${#PULL_ALLOW[@]} -gt 0 ] && printf '  allow: [%s]\n' "$(IFS=,; echo "${PULL_ALLOW[*]}" | sed 's/,/, /g')"
    fi
  } > "$OPT"
  chown root:"$SVC_USER" "$OPT"; chmod 0640 "$OPT"
fi
# application collectors from the command line go to their own file (re-running with none keeps the file)
if [ "$DOCKER_METRICS" -eq 1 ] || [ -n "$NGINX_URL" ] || [ ${#JOLOKIA[@]} -gt 0 ] || [ ${#EXPORTERS[@]} -gt 0 ] || [ "$DISK_BUFFER" -eq 1 ]; then
  COL="$ETC/conf.d/60-collectors.yaml"
  {
    echo "# Written by the installer from its command-line options (last run: $(date -u +%Y-%m-%dT%H:%MZ))."
    if [ "$DOCKER_METRICS" -eq 1 ]; then printf 'docker:\n  enabled: true\n'; fi
    if [ "$DISK_BUFFER" -eq 1 ]; then printf 'disk_buffer:\n  enabled: true\n  max_mb: 100\n  max_age: 2h\n'; fi
    if [ -n "$NGINX_URL" ]; then printf 'nginx:\n  status_url: "%s"\n' "$NGINX_URL"; fi
    if [ ${#JOLOKIA[@]} -gt 0 ]; then echo "jolokia:"; for j in "${JOLOKIA[@]}"; do printf '  %s: "%s"\n' "${j%%=*}" "${j#*=}"; done; fi
    if [ ${#EXPORTERS[@]} -gt 0 ]; then echo "exporters:"; for j in "${EXPORTERS[@]}"; do printf '  %s: "%s"\n' "${j%%=*}" "${j#*=}"; done; fi
  } > "$COL"
  chown root:"$SVC_USER" "$COL"; chmod 0640 "$COL"   # may hold a Jolokia password: not world-readable
fi
if [ "$DOCKER_METRICS" -eq 1 ]; then
  if getent group docker >/dev/null; then
    usermod -aG docker "$SVC_USER" && warn "The agent user is now in the docker group. That is root-equivalent on this host; the agent only sends GET requests to the Docker API."
  else
    warn "--docker-metrics: no docker group on this host (is Docker installed?). Container metrics stay off."
  fi
fi
if [ -n "$CA_FILE" ] && [ "$CA_FILE" != "$ETC/ca.crt" ]; then install -m 0644 "$CA_FILE" "$ETC/ca.crt"; fi
# pin the release signing key (first install, or --trust-new-release-key): the updater only installs builds it signed
if [ -s "$TMP/release.pub" ] && { [ ! -s "$ETC/release.pub" ] || [ "${PINNED_NEW:-0}" -eq 1 ]; }; then install -m 0644 "$TMP/release.pub" "$ETC/release.pub"; fi
[ -s "$ETC/ca.crt" ] && ysetkey ca_file "$ETC/ca.crt"
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
# a running agent that was removed in ObservaOne may ask its updater to uninstall it: not while installing
systemctl stop observaone-agent-updater.path observaone-agent.service 2>/dev/null || true
rm -f "$VAR/uninstall-request.json"
if [ -s "$VAR/credential" ] && [ -s "$VAR/identity.json" ]; then
  OLDID="$(sed -n 's/.*"agentId": *"\([^"]*\)".*/\1/p' "$VAR/identity.json")"
  # does the server still know this identity? (it is forgotten when the agent is removed on the Agents page
  # or the server's database is reset; keeping it would only give "401 invalid_credential" forever)
  CC_RC=0; CC_OUT="$(runuser -u "$SVC_USER" -- "$NEW" check-credential --config "$CONF" 2>&1)" || CC_RC=$?
  case "$CC_RC" in
    0) ok "Already enrolled ($OLDID): keeping this identity" ;;
    3) warn "$CC_OUT"
       warn "Enrolling again with a new token (the old identity is kept as $VAR/*.old)"
       mv -f "$VAR/credential" "$VAR/credential.old"; mv -f "$VAR/identity.json" "$VAR/identity.json.old" ;;
    4) die "$CC_OUT. Unblock it on the Agents page, then run the installer again." ;;
    *) ok "Already enrolled ($OLDID): keeping this identity (could not check it with the server: ${CC_OUT:-no answer})" ;;
  esac
fi
if [ ! -s "$VAR/credential" ] || [ ! -s "$VAR/identity.json" ]; then
  TF="$VAR/enroll-token"
  ( umask 077; : > "$TF" )
  chown "$SVC_USER":"$SVC_USER" "$TF"
  if [ -n "$TOKEN_ARG" ]; then
    printf '%s' "$TOKEN_ARG" > "$TF"
  elif [ -n "$TOKEN_FILE" ]; then
    [ -s "$TOKEN_FILE" ] || die "--token-file $TOKEN_FILE is empty or missing"
    cat "$TOKEN_FILE" > "$TF"; rm -f "$TOKEN_FILE"
  else
    { : < /dev/tty; } 2>/dev/null || die "No terminal to ask for the token. Use --token-file FILE (a new token from Agents > Linux > Install)."
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

# ---------------------------------------------------------------- updater (upgrades requested on the Agents page)
# The agent never replaces its own binary and never runs as root. When an admin clicks Upgrade, the agent writes
# upgrade-request.json in its state folder; this root-owned path unit notices it and runs the updater, which
# downloads the binary from the SAME server with the SAME trust settings, verifies it, swaps it (keeping .prev),
# restarts the agent and rolls back if no heartbeat arrives in 60 s. It reads only the action id from the request:
# the version installed is whatever this server publishes, never something the request names.
UPD="$PREFIX/bin/observaone-agent-updater"
cat > "$UPD.new" <<'UPDATER'
#!/usr/bin/env bash
# observaone-agent-updater: run by systemd (root) when the agent asks for an upgrade (Agents page -> Upgrade).
set -uo pipefail
PREFIX=${OBSERVA_PREFIX:-/opt/observaone-agent} VAR=${OBSERVA_VAR:-/var/lib/observaone-agent} ETC=${OBSERVA_ETC:-/etc/observaone-agent} SVC_USER=observaone-agent
AGENT="$PREFIX/bin/observaone-agent"
REQ="$VAR/upgrade-request.json" RES="$VAR/upgrade-result.json"
# Removed in ObservaOne with "uninstall": the agent got 410 agent_uninstall and asked for it. The request carries
# no instructions; it only says "uninstall", which the agent user could do anyway by stopping the agent for good.
if [ -f "$VAR/uninstall-request.json" ]; then
  logger -t observaone-agent-updater "removed in ObservaOne: uninstalling the ObservaOne Agent" 2>/dev/null || true
  systemctl disable --now observaone-agent.service 2>/dev/null || true
  systemctl disable observaone-agent-updater.path 2>/dev/null || true
  rm -f /etc/systemd/system/observaone-agent.service /etc/systemd/system/observaone-agent-updater.path /etc/systemd/system/observaone-agent-updater.service
  rm -f /usr/local/bin/observaone-agent
  rm -rf "$PREFIX" "$ETC" "$VAR"
  id "$SVC_USER" >/dev/null 2>&1 && { userdel "$SVC_USER" 2>/dev/null || true; }
  systemctl daemon-reload 2>/dev/null || true
  exit 0
fi
[ -f "$REQ" ] || exit 0
WORK="$(mktemp -p "$VAR" upgrade.XXXXXX)"; mv -f "$REQ" "$WORK"
ACTION="$(head -c 4096 "$WORK" | sed -n 's/.*"actionId": *\([0-9]\{1,18\}\).*/\1/p' | head -1)"; rm -f "$WORK"
[ -n "$ACTION" ] || exit 0
OLDV="$("$AGENT" version 2>/dev/null | awk '{print $2}')"
result() { # result OK(true|false) MESSAGE VERSION
  local tmp msg; tmp="$(mktemp -p "$VAR" result.XXXXXX)"; msg="$(printf '%s' "$2" | tr -d '"\\\r\n' | cut -c1-300)"
  printf '{"actionId":%s,"ok":%s,"message":"%s","version":"%s","finishedAt":"%s"}\n' "$ACTION" "$1" "$msg" "$3" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp"
  chown "$SVC_USER:$SVC_USER" "$tmp"; chmod 0640 "$tmp"; mv -f "$tmp" "$RES"
  logger -t observaone-agent-updater "$msg" 2>/dev/null || true
  rm -rf "${TMPD:-/nonexistent}"
  exit 0
}
cfg() { "$AGENT" config show 2>/dev/null | awk -v k="$1" '$1==k {print $2}'; }
SERVER="$(cfg server)"; CA="$(cfg ca_file)"; [ "$CA" = "(empty)" ] && CA=""
[ -n "$SERVER" ] || result false "cannot read the server address from the configuration" "$OLDV"
case "$(uname -m)" in x86_64|amd64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) result false "unsupported CPU $(uname -m)" "$OLDV" ;; esac
BIN="observaone-agent-linux-$ARCH"
CURL=(curl -fsS --connect-timeout 15 --max-time 300); [ -n "$CA" ] && CURL+=(--cacert "$CA")
TMPD="$(mktemp -d /var/tmp/observaone-upgrade.XXXXXX)"; chmod 0755 "$TMPD"   # check-config runs as the agent user
"${CURL[@]}" -o "$TMPD/SHA256SUMS" "$SERVER/agent/files/SHA256SUMS" || result false "cannot download SHA256SUMS from $SERVER" "$OLDV"
"${CURL[@]}" -o "$TMPD/$BIN" "$SERVER/agent/files/$BIN" || result false "cannot download $BIN from $SERVER" "$OLDV"
if [ -s "$ETC/release.pub" ]; then
  "${CURL[@]}" -o "$TMPD/SHA256SUMS.sig" "$SERVER/agent/files/SHA256SUMS.sig" || result false "the server publishes no signature for this build; nothing changed" "$OLDV"
  "$AGENT" verify-release --key "$ETC/release.pub" --sums "$TMPD/SHA256SUMS" --sig "$TMPD/SHA256SUMS.sig" >/dev/null 2>&1 \
    || result false "SHA256SUMS is not signed by the pinned release key; nothing changed" "$OLDV"
fi
WANT="$(awk -v f="$BIN" '$2==f || $2=="*"f {print $1}' "$TMPD/SHA256SUMS")"; GOT="$(sha256sum "$TMPD/$BIN" | cut -d' ' -f1)"
[ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || result false "checksum mismatch for $BIN; nothing changed" "$OLDV"
chmod 0755 "$TMPD/$BIN"
NEWV="$("$TMPD/$BIN" version 2>/dev/null | awk '{print $2}')"
[ -n "$NEWV" ] || result false "the downloaded agent does not run on this machine; nothing changed" "$OLDV"
[ "$NEWV" = "$OLDV" ] && result true "already at $OLDV (the server publishes this version)" "$OLDV"
runuser -u "$SVC_USER" -- "$TMPD/$BIN" check-config >/dev/null 2>&1 || result false "$NEWV refuses the current configuration; nothing changed" "$OLDV"
cp -p "$AGENT" "$AGENT.prev"
install -m 0755 "$TMPD/$BIN" "$AGENT.new" && mv -f "$AGENT.new" "$AGENT"
echo "$NEWV" > "$PREFIX/VERSION"
START="$(date -u +%s)"
systemctl restart observaone-agent.service
for _ in $(seq 1 60); do
  HB="$(sed -n 's/.*"lastHeartbeatOk": *"\([^"]*\)".*/\1/p' "$VAR/status.json" 2>/dev/null)"
  V="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$VAR/status.json" 2>/dev/null | head -1)"
  if [ "$V" = "$NEWV" ] && [ -n "$HB" ] && [ "$(date -d "$HB" +%s 2>/dev/null || echo 0)" -ge "$START" ]; then
    result true "upgraded $OLDV -> $NEWV" "$NEWV"
  fi
  sleep 1
done
mv -f "$AGENT" "$AGENT.failed"; mv -f "$AGENT.prev" "$AGENT"; echo "$OLDV" > "$PREFIX/VERSION"
systemctl restart observaone-agent.service
result false "$NEWV sent no heartbeat within 60 s: rolled back to $OLDV (the new binary is kept as $AGENT.failed)" "$OLDV"
UPDATER
chmod 0755 "$UPD.new"; mv -f "$UPD.new" "$UPD"
cat > /etc/systemd/system/observaone-agent-updater.service <<EOF
[Unit]
Description=ObservaOne Agent updater (upgrades and removals requested on the Agents page)
After=network-online.target

[Service]
Type=oneshot
ExecStart=$UPD
TimeoutStartSec=600
EOF
cat > /etc/systemd/system/observaone-agent-updater.path <<EOF
[Unit]
Description=Watch for upgrade requests from the ObservaOne Agent

[Path]
PathExists=$VAR/upgrade-request.json
PathExists=$VAR/uninstall-request.json

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable observaone-agent.service >/dev/null 2>&1
systemctl enable --now observaone-agent-updater.path >/dev/null 2>&1 || warn "Could not enable the updater: upgrades from the Agents page will not work on this host (re-running this installer still does)."
STARTED_AT="$(date -u +%s)"
systemctl restart observaone-agent.service

# ---------------------------------------------------------------- wait for the first heartbeat; roll back a failed upgrade
say "Waiting for the first heartbeat"
OKHB=0
for _ in $(seq 1 45); do
  # a heartbeat from THIS start (status.json survives restarts, so an old success must not count)
  HB="$(sed -n 's/.*"lastHeartbeatOk": *"\([^"]*\)".*/\1/p' "$VAR/status.json" 2>/dev/null || true)"   # no status.json yet on a first install
  if [ -n "$HB" ] && [ "$(date -d "$HB" +%s 2>/dev/null || echo 0)" -ge "$STARTED_AT" ]; then OKHB=1; break; fi
  sleep 1
done
if [ "$OKHB" -eq 1 ]; then
  rm -f "$NEW.prev.failed" "$UNIT.prev"
  ok "ObservaOne Agent is running and connected."
  "$NEW" status --config "$CONF" || true
  echo
  echo "  Status   : sudo observaone-agent status        |  systemctl status observaone-agent"
  echo "  Logs     : journalctl -u observaone-agent -f"
  echo "  Config   : $CONF (+ $ETC/conf.d/*.yaml), then: sudo systemctl reload observaone-agent"
  if grep -q '^mode: *"\{0,1\}pull' "$CONF" "$ETC"/conf.d/*.yaml 2>/dev/null; then
    echo "  Pull mode: open TCP ${PULL_PORT:-9110} from the ObservaOne server only, e.g."
    echo "             sudo firewall-cmd --add-rich-rule='rule family=ipv4 source address=OBSERVAONE_IP port port=${PULL_PORT:-9110} protocol=tcp accept' --permanent"
    echo "             sudo ufw allow from OBSERVAONE_IP to any port ${PULL_PORT:-9110} proto tcp"
  fi
  echo "  Settings : sudo observaone-agent config show"
  echo "  Remove   : sudo bash $0 --uninstall"
else
  warn "No heartbeat within 45 s. Last log lines:"
  journalctl -u observaone-agent -n 15 --no-pager 2>/dev/null || true
  if grep -q 'invalid_credential\|credential is not valid' "$VAR/status.json" 2>/dev/null \
     || journalctl -u observaone-agent -n 50 --no-pager 2>/dev/null | grep -q 'invalid_credential'; then
    # not the new binary's fault: the server refused this identity. Rolling back would change nothing.
    rm -f "$NEW.prev.failed" "$UNIT.prev"
    die "The server refused this agent's credential (removed on the Agents page, or the server's database was reset). Re-enroll: sudo rm $VAR/credential $VAR/identity.json && sudo bash $0 --server $SERVER"
  fi
  if [ -x "$NEW.prev" ]; then
    warn "Rolling back to the previous agent binary"
    mv -f "$NEW" "$NEW.prev.failed"; mv -f "$NEW.prev" "$NEW"
    if [ "$MIGRATED" -eq 1 ] && [ -f "$ETC/agent.conf.migrated" ]; then   # the 1.1 binary reads only agent.conf
      mv -f "$ETC/agent.conf.migrated" "$ETC/agent.conf"
      for f in "$ETC"/conf.d/*.conf.migrated; do [ -e "$f" ] && mv -f "$f" "${f%.migrated}"; done
      mv -f "$CONF" "$CONF.failed"
      [ -f "$UNIT.prev" ] && mv -f "$UNIT.prev" "$UNIT" && systemctl daemon-reload
    fi
    systemctl restart observaone-agent.service || true
    die "Upgrade failed and was rolled back. The new binary is kept as $NEW.prev.failed for inspection."
  fi
  die "The agent started but has not reached $SERVER yet. Check: sudo observaone-agent status ; journalctl -u observaone-agent -n 50"
fi
