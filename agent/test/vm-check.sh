#!/usr/bin/env bash
# Run ON THE MONITORED LINUX VM after installing the agent (sudo bash vm-check.sh).
# Checks the real systemd service, identity across restarts, and the agent's numbers against the OS tools.
# Paste the whole output back; nothing secret is printed (no token, no credential).
#   --reboot-check   run after "sudo reboot": confirms the service came back with the same identity
set -uo pipefail
VAR=/var/lib/observaone-agent
pass=0 fail=0
ok()  { printf 'PASS  %s\n' "$*"; pass=$((pass+1)); }
bad() { printf 'FAIL  %s\n' "$*"; fail=$((fail+1)); }
chk() { local m=$1; shift; if "$@"; then ok "$m"; else bad "$m"; fi; }
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
id_now() { sed -n 's/.*"agentId": *"\([^"]*\)".*/\1/p' $VAR/identity.json 2>/dev/null; }
hb_age() { local t; t=$(sed -n 's/.*"lastHeartbeatOk": *"\([^"]*\)".*/\1/p' $VAR/status.json 2>/dev/null); [ -n "$t" ] && echo $(( $(date +%s) - $(date -d "$t" +%s) )) || echo 9999; }
metric() { curl -s --max-time 5 http://127.0.0.1:9109/metrics | awk -v m="$1" '$1==m {print $2; exit}'; }
metric_l() { curl -s --max-time 5 http://127.0.0.1:9109/metrics | grep -F "$1" | head -1 | awk '{print $2}'; }

echo "== ObservaOne agent VM check on $(hostname) ($(. /etc/os-release; echo "$PRETTY_NAME"), $(uname -m), kernel $(uname -r))"
ID0=$(id_now)
if [ "${1:-}" = "--reboot-check" ]; then
  chk "service active after reboot" systemctl is-active --quiet observaone-agent
  chk "service enabled at boot" systemctl is-enabled --quiet observaone-agent
  sleep 40
  chk "heartbeat after reboot ($(hb_age) s ago)" [ "$(hb_age)" -lt 60 ]
  chk "same identity after reboot ($ID0)" [ -n "$ID0" ]
  UP=$(metric observaone_uptime_seconds); chk "uptime reset by the reboot ($UP s)" awk -v u="${UP:-99999999}" 'BEGIN{exit !(u<900)}'
  echo; echo "passed $pass, failed $fail"; exit $fail
fi

chk "service active" systemctl is-active --quiet observaone-agent
chk "service enabled at boot" systemctl is-enabled --quiet observaone-agent
U=$(systemctl show -p User --value observaone-agent); chk "runs as non-root user ($U)" [ "$U" = observaone-agent ]
P=$(systemctl show -p MainPID --value observaone-agent); PU=$(ps -o user= -p "$P" 2>/dev/null | tr -d ' ')
chk "process owner is $PU" [ "$PU" = observaone-agent ]
chk "credential file is 0600 and owned by the agent" bash -c "[ \"\$(stat -c '%a %U' $VAR/credential)\" = '600 observaone-agent' ]"
chk "no enrollment token left on disk" bash -c "! ls $VAR/enroll-token /etc/observaone-agent/token 2>/dev/null | grep -q ."
chk "no token in shell history" bash -c "! grep -qsE 'oat_[0-9a-f]{8}_' /root/.bash_history /home/*/.bash_history"
chk "no token/credential in the journal" bash -c "! journalctl -u observaone-agent --no-pager 2>/dev/null | grep -qE 'oat_[0-9a-f]{8}_|oac_[0-9a-f]{20}_'"
chk "metrics endpoint is loopback only" bash -c "ss -ltn | grep -q '127.0.0.1:9109' && ! ss -ltn | grep -qE '(0.0.0.0|\\*|\\[::\\]):9109'"
chk "heartbeat in the last 60 s ($(hb_age) s ago)" [ "$(hb_age)" -lt 60 ]
observaone-agent status

echo "-- numbers vs the OS"
MA=$(metric node_memory_MemAvailable_bytes); FA=$(awk '/MemAvailable/ {print $2*1024}' /proc/meminfo)
chk "memory available: agent $MA vs /proc/meminfo $FA (5%)" awk -v a="$MA" -v b="$FA" 'BEGIN{d=(a-b)/b; if(d<0)d=-d; exit !(a>0 && d<0.05)}'
MT=$(metric node_memory_MemTotal_bytes); FT=$(free -b | awk '/Mem:/ {print $2}')
chk "memory total: agent $MT vs free $FT" awk -v a="$MT" -v b="$FT" 'BEGIN{exit !(a==b)}'
FS=$(metric_l 'node_filesystem_size_bytes{device=' | head -1); RS=$(curl -s http://127.0.0.1:9109/metrics | grep 'node_filesystem_size_bytes{' | grep 'mountpoint="/"' | awk '{print $2}')
DF=$(df -B1 --output=size / | tail -1 | tr -d ' ')
chk "root filesystem size: agent $RS vs df $DF" awk -v a="$RS" -v b="$DF" 'BEGIN{exit !(a==b)}'
DU=$(df --output=pcent / | tail -1 | tr -dc 0-9); AU=$(curl -s http://127.0.0.1:9109/metrics | grep 'observaone_filesystem_utilization_ratio{' | grep 'mountpoint="/"' | awk '{printf "%d", $2*100+0.5}')
chk "root filesystem use: agent ${AU}% vs df ${DU}% (±1)" awk -v a="$AU" -v b="$DU" 'BEGIN{d=a-b; if(d<0)d=-d; exit !(d<=1)}'
UP=$(metric observaone_uptime_seconds); UR=$(cut -d' ' -f1 /proc/uptime)
chk "uptime: agent $UP vs /proc/uptime $UR (60 s)" awk -v a="$UP" -v b="$UR" 'BEGIN{d=a-b; if(d<0)d=-d; exit !(d<60)}'
read -r _ u n s i w q sq st _ < /proc/stat; sleep 15; read -r _ u2 n2 s2 i2 w2 q2 sq2 st2 _ < /proc/stat
T=$(( (u2+n2+s2+i2+w2+q2+sq2+st2) - (u+n+s+i+w+q+sq+st) )); B=$(( T - ((i2+w2)-(i+w)) ))
CI=$(awk -v b=$B -v t=$T 'BEGIN{print b/t}'); CA=$(metric observaone_cpu_utilization_ratio)
chk "CPU busy: agent $CA vs independent 15 s sample $CI (within 0.15)" awk -v a="$CA" -v b="$CI" 'BEGIN{d=a-b; if(d<0)d=-d; exit !(a!="" && d<0.15)}'
RSS=$(metric process_resident_memory_bytes); chk "agent memory $(awk -v r="$RSS" 'BEGIN{printf "%.1f MB", r/1048576}') (< 64 MB)" awk -v r="$RSS" 'BEGIN{exit !(r>0 && r<64*1048576)}'
NAN=$(curl -s http://127.0.0.1:9109/metrics | grep -v '^#' | grep -ciE ' (nan|[+-]?inf)$'); chk "no NaN/Inf values ($NAN)" [ "$NAN" = 0 ]

echo "-- restart keeps identity"
systemctl restart observaone-agent; sleep 40
chk "same identity after restart ($(id_now))" [ "$(id_now)" = "$ID0" ]
chk "heartbeat after restart ($(hb_age) s ago)" [ "$(hb_age)" -lt 45 ]

echo "-- config reload"
cp /etc/observaone-agent/agent.conf /tmp/agent.conf.bak
echo "collect_interval = 1s" > /etc/observaone-agent/conf.d/99-test.conf
if observaone-agent check-config >/dev/null 2>&1; then bad "invalid value accepted"; else ok "invalid config value refused by check-config"; fi
systemctl reload observaone-agent; sleep 3
chk "agent still running after a bad reload" systemctl is-active --quiet observaone-agent
echo "collect_interval = 20s" > /etc/observaone-agent/conf.d/99-test.conf
systemctl reload observaone-agent; sleep 3
chk "valid change applied (config show)" bash -c "observaone-agent config show | grep -q 'collect_interval *20s'"
rm -f /etc/observaone-agent/conf.d/99-test.conf; systemctl reload observaone-agent

echo "-- network interruption (blocks the server for 70 s with iptables, then restores)"
SRV=$(sed -n 's/^server *= *https:\/\/\([^:/]*\).*/\1/p' /etc/observaone-agent/agent.conf)
PORT=$(sed -n 's/^server *= *https:\/\/[^:/]*:\([0-9]*\).*/\1/p' /etc/observaone-agent/agent.conf); PORT=${PORT:-443}
IP=$(getent ahostsv4 "$SRV" | awk 'NR==1{print $1}')
if command -v iptables >/dev/null && [ -n "$IP" ]; then
  iptables -I OUTPUT -d "$IP" -p tcp --dport "$PORT" -j REJECT
  sleep 70
  B=$(sed -n 's/.*"bufferedPayloads": *\([0-9]*\).*/\1/p' $VAR/status.json)
  chk "agent buffers while the server is unreachable ($B collections)" [ "${B:-0}" -ge 2 ]
  iptables -D OUTPUT -d "$IP" -p tcp --dport "$PORT" -j REJECT
  sleep 90
  B2=$(sed -n 's/.*"bufferedPayloads": *\([0-9]*\).*/\1/p' $VAR/status.json)
  chk "catches up after the network is back (buffered $B2)" [ "${B2:-99}" -le 1 ]
  chk "heartbeat resumed ($(hb_age) s ago)" [ "$(hb_age)" -lt 120 ]
else echo "SKIP  network interruption (needs iptables)"; fi

echo; echo "passed $pass, failed $fail"
echo "Now check in ObservaOne: Agents > Linux shows $(hostname -s) Online; Infrastructure shows it once with CPU/memory/disk."
echo "Then: sudo reboot ; and after it is back: sudo bash vm-check.sh --reboot-check"
exit $fail
