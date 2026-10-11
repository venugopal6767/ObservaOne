#!/usr/bin/env bash
# ObservaOne Linux agent: scenario tests against a REAL running stack (UI + PostgreSQL + Prometheus + TLS proxy)
# and an agent installed with agent/install.sh on THIS machine.
#
#   OO_URL=https://observaone.example.com OO_UI=http://127.0.0.1:8083 OO_ADMIN_PW=... OO_VIEWER_PW=... \
#   OO_PROM=http://127.0.0.1:9090/prometheus OO_CA=/etc/observaone-agent/ca.crt  sudo -E bash agent/test/scenarios.sh
#
# OO_UI is the app itself (admin API); OO_URL is the HTTPS address agents use. Thresholds must be short for the
# stale/offline checks: start the server with AGENT_ONLINE_SECONDS=20 AGENT_OFFLINE_SECONDS=60 AGENT_HEARTBEAT_SECONDS=5.
# Prints one line per scenario: PASS / FAIL / SKIP with what was observed. Exit code = number of failures.
set -uo pipefail
: "${OO_URL:?}" "${OO_UI:?}" "${OO_ADMIN_PW:?}" "${OO_PROM:?}"
CA=${OO_CA:-/etc/observaone-agent/ca.crt}
CURL=(curl -s --cacert "$CA" --max-time 20)
J=$(mktemp); JV=$(mktemp)
FAILS=0; RESULTS=()
res() { local s=$1 id=$2 msg=$3; printf '%-4s %-5s %s\n' "$s" "$id" "$msg"; RESULTS+=("$s|$id|$msg"); [ "$s" = FAIL ] && FAILS=$((FAILS+1)); return 0; }
check() { local id=$1 msg=$2; shift 2; if "$@"; then res PASS "$id" "$msg"; else res FAIL "$id" "$msg"; fi; }
api() { curl -s -b "$J" -H 'X-Requested-With: observa' -H 'Content-Type: application/json' "$@"; }
login() { curl -s -c "$1" -H 'X-Requested-With: observa' -H 'Content-Type: application/json' -d "{\"username\":\"$2\",\"password\":\"$3\"}" "$OO_UI/api/login" -o /dev/null -w '%{http_code}'; }
mktoken() { api -d "$1" "$OO_UI/api/agent-tokens"; }
enroll() { # enroll TOKEN BODYJSON -> "code body"
  "${CURL[@]}" -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -d "$2" -w ' %{http_code}' "$OO_URL/api/agent/v1/enroll"; }
code() { echo "${1##* }"; }
body() { echo "${1% *}"; }
agent_json() { api "$OO_UI/api/agents" | jq -c --arg h "$1" '.agents[] | select(.host==$h)'; }
promq() { curl -s -G "$OO_PROM/api/v1/query" --data-urlencode "query=$1" | jq -r '.data.result[0].value[1] // empty'; }
RUN=${RUN:-r$RANDOM}  # unique host names per run, so re-runs never collide
EB() { echo "{\"hostname\":\"$1-$RUN\",\"platform\":\"linux\",\"arch\":\"amd64\",\"version\":\"1.1.0\",\"os\":\"Test OS\"${2:-}}"; }

[ "$(login "$J" admin "$OO_ADMIN_PW")" = 200 ] || { echo "admin login failed"; exit 99; }
HOST=$(sed -n 's/.*"host": *"\([^"]*\)".*/\1/p' /var/lib/observaone-agent/identity.json)
AID=$(sed -n 's/.*"agentId": *"\([^"]*\)".*/\1/p' /var/lib/observaone-agent/identity.json)
CRED=$(cat /var/lib/observaone-agent/credential)
echo "installed agent: $AID ($HOST)"

# ---------------- enrollment and security ----------------
T=$(mktoken '{"name":"scn valid","maxUses":3}' | jq -r .token)
R=$(enroll "$T" "$(EB scn-a)"); check S01 "valid token enrolls a new host (201)" [ "$(code "$R")" = 201 ]
CA_A=$(body "$R" | jq -r .credential)
R=$(enroll "oat_00000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAA" "$(EB scn-x)"); check S02 "invalid token rejected (401 invalid_token)" [ "$(code "$R")" = 401 ]
TE=$(mktoken '{"name":"scn expired","expiresDays":1}'); TEID=$(echo "$TE" | jq -r .id); TE=$(echo "$TE" | jq -r .token)
psql -h /tmp -p 5433 -U postgres -d agenttest -qc "UPDATE agent_tokens SET expires_at = now() - interval '1 minute' WHERE id = $TEID" 2>/dev/null \
  && { R=$(enroll "$TE" "$(EB scn-e)"); check S03 "expired token rejected (token_expired)" bash -c "[[ '$R' == *token_expired*401 ]]"; } \
  || res SKIP S03 "expired token (needs DB access to back-date expiry)"
TR=$(mktoken '{"name":"scn revoked"}'); TRID=$(echo "$TR" | jq -r .id); TR=$(echo "$TR" | jq -r .token)
api -X DELETE "$OO_UI/api/agent-tokens/$TRID" >/dev/null
R=$(enroll "$TR" "$(EB scn-r)"); check S04 "revoked token rejected (token_revoked)" bash -c "[[ '$R' == *token_revoked*401 ]]"
T1=$(mktoken '{"name":"scn one-time","maxUses":1}' | jq -r .token)
R1=$(enroll "$T1" "$(EB scn-o1)"); R2=$(enroll "$T1" "$(EB scn-o2)")
check S05 "one-time token cannot be reused (2nd = token_used_up)" bash -c "[ '$(code "$R1")' = 201 ] && [[ '$R2' == *token_used_up*401 ]]"
TC=$(mktoken '{"name":"scn concurrent","maxUses":3}' | jq -r .token)
for i in $(seq 1 8); do (enroll "$TC" "$(EB scn-c$i)" > /tmp/scn-c$i.out) & done; wait
OKS=$(for i in $(seq 1 8); do code "$(cat /tmp/scn-c$i.out)"; done | grep -c 201)
check S06 "8 concurrent enrollments with a 3-use token: exactly 3 succeed (got $OKS)" [ "$OKS" = 3 ]
TD=$(mktoken '{"name":"scn dup","maxUses":5}' | jq -r .token)
D1=$(enroll "$TD" "$(EB scn-dup)"); D2=$(enroll "$TD" "$(EB scn-dup)")
H1=$(body "$D1" | jq -r .host); H2=$(body "$D2" | jq -r .host)
check S08 "duplicate host name gets a distinct name, nothing overwritten ($H1 / $H2)" bash -c "[ '$H1' = scn-dup-$RUN ] && [ '$H2' = scn-dup-$RUN-2 ]"
TV=$(mktoken '{"name":"scn validation","maxUses":20}' | jq -r .token)
BAD=0
for b in '{"hostname":"bad host!","arch":"amd64","version":"1.1.0"}' '{"hostname":"h","arch":"mips","version":"1.1.0"}' '{"hostname":"h","arch":"amd64","version":"x"}' \
         '{"hostname":"h","arch":"amd64","version":"1.1.0","labels":{"host":"evil"}}' '[1,2]' 'not json' '{"hostname":"h","arch":"amd64","version":"1.1.0","platform":"solaris"}'; do
  c=$(code "$("${CURL[@]}" -H "Authorization: Bearer $TV" -H 'Content-Type: application/json' -d "$b" -w ' %{http_code}' "$OO_URL/api/agent/v1/enroll")")
  [ "$c" = 400 ] || BAD=$((BAD+1))
done
check S12 "7 malformed enrollment requests all rejected with 400 (non-400: $BAD)" [ "$BAD" = 0 ]
BIG=$(head -c 20000 /dev/zero | tr '\0' 'a')
c=$(code "$("${CURL[@]}" -H "Authorization: Bearer $TV" -H 'Content-Type: application/json' -d "{\"hostname\":\"$BIG\"}" -w ' %{http_code}' "$OO_URL/api/agent/v1/enroll")")
check S75 "oversized enrollment body rejected (413, got $c)" [ "$c" = 413 ]
if [ -n "${OO_VIEWER_PW:-}" ] && [ "$(login "$JV" viewer "$OO_VIEWER_PW")" = 200 ]; then
  c1=$(curl -s -b "$JV" -H 'X-Requested-With: observa' -H 'Content-Type: application/json' -d '{"name":"v"}' -o /dev/null -w '%{http_code}' "$OO_UI/api/agent-tokens")
  c2=$(curl -s -b "$JV" -H 'X-Requested-With: observa' -X DELETE -o /dev/null -w '%{http_code}' "$OO_UI/api/agent-tokens/1")
  c3=$(curl -s -H 'X-Requested-With: observa' -o /dev/null -w '%{http_code}' "$OO_UI/api/agent-tokens")
  check S10 "viewer cannot create ($c1) or revoke ($c2) tokens; signed-out list = $c3" bash -c "[ $c1 = 403 ] && [ $c2 = 403 ] && [ $c3 = 401 ]"
else res SKIP S10 "viewer permission check (set OO_VIEWER_PW)"; fi
# impersonation: agent A's credential with agent B's id in the body/headers changes nothing; a forged credential fails
OTHER=$(echo "$CA_A" | sed 's/^oac_\(.\{20\}\)_/oac_00000000000000000000_/')
c1=$(code "$("${CURL[@]}" -H "Authorization: Bearer $OTHER" -H 'Content-Type: application/json' -d '{}' -w ' %{http_code}' "$OO_URL/api/agent/v1/heartbeat")")
R=$("${CURL[@]}" -H "Authorization: Bearer $CA_A" -H "X-Agent-Id: $AID" -H 'Content-Type: application/json' -d "{\"agentId\":\"$AID\"}" "$OO_URL/api/agent/v1/heartbeat")
check S11 "forged credential = 401 ($c1); claiming another id in body/headers is ignored (answer is for $(echo "$R" | jq -r .agentId))" \
  bash -c "[ $c1 = 401 ] && [ '$(echo "$R" | jq -r .agentId)' != '$AID' ]"
# metric labels cannot be forged: send host="$HOST" with agent A's credential
printf 'scn_forge_%s{host="%s",agent_id="%s",job="windows"} 42\n' "$RUN" "$HOST" "$AID" | gzip > /tmp/forge.gz
"${CURL[@]}" -H "Authorization: Bearer $CA_A" -H 'Content-Encoding: gzip' --data-binary @/tmp/forge.gz -o /dev/null "$OO_URL/api/agent/v1/metrics"
sleep 2
FH=$(curl -s -G "$OO_PROM/api/v1/query" --data-urlencode "query=scn_forge_$RUN" | jq -r '.data.result[0].metric | "\(.host)|\(.agent_id)|\(.job)"')
check S11b "metric labels host/agent_id/job are set by the server, not the agent (stored as $FH)" bash -c "[[ '$FH' == scn-a-$RUN\|agt_*\|linux ]] && [[ '$FH' != *'$AID'* ]]"
LEAK=0
for f in /var/log/syslog /home/claude/e2e/app.log /home/claude/e2e/agent-svc.log /home/claude/e2e/nginx-access.log; do
  [ -f "$f" ] && grep -qE "oat_[0-9a-f]{8}_[A-Za-z0-9_-]{20}|oac_[0-9a-f]{20}_" "$f" && LEAK=$((LEAK+1))
done
check S14 "no token or credential in server, agent or proxy logs" [ "$LEAK" = 0 ]
c=$(code "$(curl -s --max-time 10 --cacert /home/claude/e2e/other.crt -w ' %{http_code}' "$OO_URL/healthz" 2>/dev/null || echo ' 000')")
check S15 "TLS with an untrusted certificate fails (no fallback): curl code $c" [ "$c" = 000 ]

# ---------------- heartbeat and lifecycle ----------------
for i in $(seq 1 30); do [ "$(agent_json "$HOST" | jq -r .status)" = online ] && break; sleep 2; done
A=$(agent_json "$HOST"); check S17 "installed agent is online after its heartbeat ($(echo "$A" | jq -r .status))" [ "$(echo "$A" | jq -r .status)" = online ]
L1=$(echo "$A" | jq -r .lastHeartbeat); sleep 12; L2=$(agent_json "$HOST" | jq -r .lastHeartbeat)
check S18 "heartbeats keep arriving ($L1 -> $L2)" bash -c "[[ '$L2' > '$L1' ]]"
systemctl stop observaone-agent; ST=$(date +%s)
sleep 26; S1=$(agent_json "$HOST" | jq -r .status)
sleep 40; S2=$(agent_json "$HOST" | jq -r .status); R2=$(agent_json "$HOST" | jq -r .statusReason)
check S19 "stopped agent: not_reporting after online threshold ($S1), offline later ($S2)" bash -c "[ $S1 = not_reporting ] && [ $S2 = offline ]"
check S56 "stale agent shows the last-seen age: '$R2'" bash -c "[[ '$R2' == 'No heartbeat for'* ]]"
systemctl start observaone-agent; sleep 8
N=$(api "$OO_UI/api/agents" | jq --arg h "$HOST" '[.agents[] | select(.host==$h or (.host|startswith($h+"-")))] | length')
check S20 "restart restores Online with the same identity (rows for host: $N, status $(agent_json "$HOST" | jq -r .status))" bash -c "[ $N = 1 ] && [ $(agent_json "$HOST" | jq -r .status) = online ]"
c=$(code "$("${CURL[@]}" -H 'Authorization: Bearer oac_00000000000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' -d '{}' -w ' %{http_code}' "$OO_URL/api/agent/v1/heartbeat")")
check S24 "invalid heartbeat credential rejected ($c)" [ "$c" = 401 ]
H0=$(agent_json scn-a-$RUN | jq -r .lastHeartbeat)
for i in $(seq 1 30); do "${CURL[@]}" -H "Authorization: Bearer $CA_A" -H 'Content-Type: application/json' -d '{"version":"1.1.0"}' -o /dev/null "$OO_URL/api/agent/v1/heartbeat" & done; wait
HB=$(psql -h /tmp -p 5433 -U postgres -d agenttest -tAc "SELECT heartbeats FROM agents WHERE host='scn-a-$RUN'" 2>/dev/null)
check S74 "burst of 30 heartbeats in parallel answered; at most a few DB writes (heartbeats=$HB)" bash -c "[ -n '$HB' ] && [ $HB -le 3 ]"
check S23 "last heartbeat never moves backwards (server time, GREATEST)" bash -c "[[ '$(agent_json scn-a-$RUN | jq -r .lastHeartbeat)' > '$H0' || '$(agent_json scn-a-$RUN | jq -r .lastHeartbeat)' == '$H0' ]]"
"${CURL[@]}" -H "Authorization: Bearer $CA_A" -H 'Content-Type: application/json' -d '{"version":"0.9.0"}' -o /dev/null "$OO_URL/api/agent/v1/heartbeat"; sleep 6
"${CURL[@]}" -H "Authorization: Bearer $CA_A" -H 'Content-Type: application/json' -d '{"version":"0.9.0","collectors":{"cpu":"ok"}}' -o /dev/null "$OO_URL/api/agent/v1/heartbeat"
A=$(agent_json scn-a-$RUN)
check S28 "outdated/unsupported version -> attention with a diagnostic ($(echo "$A" | jq -r .status))" bash -c "[ $(echo "$A" | jq -r .status) = attention ] && [[ '$(echo "$A" | jq -r '.problems|join(" ")')' == *'no longer supported'* ]]"
check S27 "version change is reflected (now $(echo "$A" | jq -r .version))" [ "$(echo "$A" | jq -r .version)" = 0.9.0 ]

# ---------------- metrics ----------------
sleep 20
MA=$(promq "node_memory_MemAvailable_bytes{host=\"$HOST\"}"); FA=$(awk '/MemAvailable/ {print $2*1024}' /proc/meminfo)
check S30 "memory available matches /proc/meminfo within 5% ($MA vs $FA)" awk -v a="$MA" -v b="$FA" 'BEGIN{d=(a-b)/b; if(d<0)d=-d; exit !(a>0 && d<0.05)}'
FS=$(promq "node_filesystem_size_bytes{host=\"$HOST\",mountpoint=\"/\"}"); DF=$(df -B1 --output=size / | tail -1 | tr -d ' ')
check S31 "root filesystem size equals df ($FS vs $DF)" awk -v a="$FS" -v b="$DF" 'BEGIN{exit !(a==b)}'
CPU_A=$(promq "observaone_cpu_utilization_ratio{host=\"$HOST\"}")
read -r _ u n s i w q sq st _ < /proc/stat; sleep 5; read -r _ u2 n2 s2 i2 w2 q2 sq2 st2 _ < /proc/stat
T1=$((u+n+s+i+w+q+sq+st)); T2=$((u2+n2+s2+i2+w2+q2+sq2+st2)); B=$(( (T2-T1) - ((i2+w2)-(i+w)) ))
CPU_B=$(awk -v b=$B -v t=$((T2-T1)) 'BEGIN{print b/t}')
check S29 "CPU utilisation plausible vs an independent /proc/stat sample (agent $CPU_A, independent $CPU_B, within 0.15)" \
  awk -v a="$CPU_A" -v b="$CPU_B" 'BEGIN{d=a-b; if(d<0)d=-d; exit !(a!="" && d<0.15)}'
UP=$(promq "observaone_uptime_seconds{host=\"$HOST\"}"); UPR=$(cut -d' ' -f1 /proc/uptime)
check S35 "uptime matches /proc/uptime within 60 s ($UP vs $UPR)" awk -v a="$UP" -v b="$UPR" 'BEGIN{d=a-b; if(d<0)d=-d; exit !(a>0 && d<60)}'
NAN=$(curl -s -G "$OO_PROM/api/v1/query" --data-urlencode "query=count({host=\"$HOST\"} != {host=\"$HOST\"}) or count({host=\"$HOST\"} < 0)" | jq -r '.data.result | length')
check S39 "no NaN or negative values stored for the host" [ "$NAN" = 0 ]
SER=$(promq "count({host=\"$HOST\"})")
check S41 "series per host stays bounded (< 1000): $SER" bash -c "[ ${SER:-99999} -lt 1000 ]"
RSS=$(promq "process_resident_memory_bytes{host=\"$HOST\"}"); CPUS=$(promq "rate(process_cpu_seconds_total{host=\"$HOST\"}[2m])")
check S40 "agent overhead: RSS $(awk -v r="$RSS" 'BEGIN{printf "%.1f MB", r/1048576}'), CPU $(awk -v c="${CPUS:-0}" 'BEGIN{printf "%.2f%%", c*100}') (limits 64 MB, 2%)" \
  awk -v r="$RSS" -v c="${CPUS:-0}" 'BEGIN{exit !(r>0 && r<64*1048576 && c<0.02)}'
LBL=$(curl -s -G "$OO_PROM/api/v1/series" --data-urlencode "match[]={host=\"$HOST\"}" | jq -r '[.data[] | keys[]] | unique | join(",")')
check S42 "no sensitive data in labels (labels used: $LBL)" bash -c "! grep -qiE 'pass|secret|token|key|cmdline|environ' <<<'$LBL'"

# ---------------- Prometheus / network ----------------
check S43 "Prometheus holds the agent's up series" [ "$(promq "up{host=\"$HOST\",agent=\"observaone\"}")" = 1 ]
if [ -n "${OO_PROM_STOP:-}" ]; then
  eval "$OO_PROM_STOP"; sleep 3
  c=$(code "$(printf 'scn_x 1\n' | gzip | "${CURL[@]}" -H "Authorization: Bearer $CA_A" -H 'Content-Encoding: gzip' --data-binary @- -w ' %{http_code}' "$OO_URL/api/agent/v1/metrics")")
  h=$(code "$("${CURL[@]}" -H "Authorization: Bearer $CA_A" -H 'Content-Type: application/json' -d '{"version":"1.1.0"}' -w ' %{http_code}' "$OO_URL/api/agent/v1/heartbeat")")
  check S51 "Prometheus down: upload gets 503 ($c) but heartbeat still works ($h)" bash -c "[ $c = 503 ] && [ $h = 200 ]"
  sleep 25; BUF=$(jq -r .bufferedPayloads /var/lib/observaone-agent/status.json)
  eval "$OO_PROM_START"; sleep 40
  BUF2=$(jq -r .bufferedPayloads /var/lib/observaone-agent/status.json)
  check S22 "agent buffers during the outage ($BUF) and catches up after it ($BUF2)" bash -c "[ $BUF -ge 1 ] && [ $BUF2 -le 1 ]"
else res SKIP S51 "Prometheus outage (set OO_PROM_STOP / OO_PROM_START)"; fi

# ---------------- UI / API ----------------
check S53 "the installed agent is in the Agents list" [ -n "$(agent_json "$HOST")" ]
ROWS=$(api "$OO_UI/api/prom/targets" | jq --arg h "$HOST" '[.[] | select(.host==$h)] | length')
check S54 "the host appears once in Infrastructure ($ROWS row)" [ "$ROWS" = 1 ]
ORIG=$(api "$OO_UI/api/modules" | jq -c .enabled)
api -X PUT -d '{"enabled":["metrics","infrastructure","dashboards"]}' "$OO_UI/api/modules" >/dev/null
c1=$(api -o /dev/null -w '%{http_code}' "$OO_UI/api/agents"); c2=$(api -o /dev/null -w '%{http_code}' "$OO_UI/api/agent-tokens")
h=$(code "$("${CURL[@]}" -H "Authorization: Bearer $CA_A" -H 'Content-Type: application/json' -d '{"version":"1.1.0"}' -w ' %{http_code}' "$OO_URL/api/agent/v1/heartbeat")")
api -X PUT -d "{\"enabled\":$ORIG}" "$OO_UI/api/modules" >/dev/null
check S60 "Agents module off: /agents $c1, /agent-tokens $c2 (404); installed agents keep reporting ($h)" bash -c "[ $c1 = 404 ] && [ $c2 = 404 ] && [ $h = 200 ]"
TID=$(mktoken '{"name":"scn revoke ui"}'); TK=$(echo "$TID" | jq -r .token); TID=$(echo "$TID" | jq -r .id)
api -X DELETE "$OO_UI/api/agent-tokens/$TID" >/dev/null
REV=$(api "$OO_UI/api/agent-tokens" | jq --argjson i "$TID" '.tokens[] | select(.id==$i) | .revoked')
R=$(enroll "$TK" "$(EB scn-rv)")
check S62 "revocation shows in the token list (revoked=$REV) and blocks use ($(code "$R"))" bash -c "[ $REV = true ] && [ $(code "$R") = 401 ]"
api -X POST "$OO_UI/api/agents/$(agent_json scn-a-$RUN | jq -r .id)/block" >/dev/null; sleep 1
c=$(code "$(printf 'scn_x 1\n' | gzip | "${CURL[@]}" -H "Authorization: Bearer $CA_A" -H 'Content-Encoding: gzip' --data-binary @- -w ' %{http_code}' "$OO_URL/api/agent/v1/metrics")")
check S61b "a blocked agent's uploads are refused at once ($c)" [ "$c" = 403 ]

for i in $(seq 1 40); do enroll "oat_00000000_BBBBBBBBBBBBBBBBBBBBBBBBBBBB" "$(EB rl)" > /tmp/rl.out; [[ "$(cat /tmp/rl.out)" == *429 ]] && break; done
check S13 "repeated failed enrollments are rate-limited (429 after $i attempts)" bash -c "[[ \"\$(cat /tmp/rl.out)\" == *429 ]]"

echo; echo "failures: $FAILS"
printf '%s\n' "${RESULTS[@]}" > /tmp/scenario-results.txt
exit "$FAILS"
