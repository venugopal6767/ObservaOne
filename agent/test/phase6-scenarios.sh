#!/usr/bin/env bash
# ObservaOne Agent 1.3, Phase 6: credential rotation, signed releases, disk buffer, tenants, site gateway.
# Runs against a REAL stack with an agent >= 1.3 installed on THIS machine, like scenarios.sh.
#
#   OO_URL=https://observaone.example.com OO_UI=http://127.0.0.1:8083 OO_ADMIN_PW=... OO_PROM=http://127.0.0.1:9090/prometheus \
#   [OO_PSQL="psql -h ... -U ... -d observa"]  [OO_FILES=<folder served as /agent/files>]  [OO_GATEWAY_URL=http://127.0.0.1:8090] \
#   sudo -E bash agent/test/phase6-scenarios.sh
#
# OO_PSQL lets the rotation checks move clocks (credential age, end of the overlap); OO_FILES lets the signature
# checks tamper with the published files (restored afterwards); OO_GATEWAY_URL points at a running gateway
# (gateway/README.md) and OO_GATEWAY_BLOCK / OO_GATEWAY_UNBLOCK cut and restore its link to the centre.
set -uo pipefail
: "${OO_URL:?}" "${OO_UI:?}" "${OO_ADMIN_PW:?}" "${OO_PROM:?}"
CA=${OO_CA:-/etc/observaone-agent/ca.crt}
CURL=(curl -s --cacert "$CA" --max-time 20)
J=$(mktemp); JT=$(mktemp); FAILS=0
res() { printf '%-4s %-5s %s\n' "$1" "$2" "$3"; [ "$1" = FAIL ] && FAILS=$((FAILS+1)); return 0; }
check() { local id=$1 msg=$2; shift 2; if "$@"; then res PASS "$id" "$msg"; else res FAIL "$id" "$msg"; fi; }
api() { curl -s -b "$J" -H 'X-Requested-With: observa' -H 'Content-Type: application/json' "$@"; }
tapi() { curl -s -b "$JT" -H 'X-Requested-With: observa' -H 'Content-Type: application/json' "$@"; }
login() { curl -s -c "$1" -H 'X-Requested-With: observa' -H 'Content-Type: application/json' -d "{\"username\":\"$2\",\"password\":\"$3\"}" "$OO_UI/api/login" -o /dev/null -w '%{http_code}'; }
waitfor() { local t=$1; shift; for _ in $(seq 1 "$t"); do "$@" && return 0; sleep 1; done; return 1; }
code() { echo "${1##* }"; }
promq() { curl -s -G "$OO_PROM/api/v1/query" --data-urlencode "query=$1" | jq -r '.data.result[0].value[1] // empty'; }
NONCE() { head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
NOW() { echo $(( $(date +%s%N) / 1000000 )); }
[ "$(login "$J" admin "$OO_ADMIN_PW")" = 200 ] || { echo "admin login failed"; exit 99; }
AID=$(sed -n 's/.*"agentId": *"\([^"]*\)".*/\1/p' /var/lib/observaone-agent/identity.json)
HOST=$(sed -n 's/.*"host": *"\([^"]*\)".*/\1/p' /var/lib/observaone-agent/identity.json)
RUN=${RUN:-q$RANDOM}
echo "installed agent: $AID ($HOST, $(observaone-agent version))"

# ---------------- credential rotation ----------------
C0=$(cat /var/lib/observaone-agent/credential)
api -X POST -o /dev/null "$OO_UI/api/agents/$AID/rotate-credential"
waitfor 40 bash -c "[ \"\$(cat /var/lib/observaone-agent/credential)\" != '$C0' ]"
C1=$(cat /var/lib/observaone-agent/credential)
sleep 12
ST=$(api "$OO_UI/api/agents/$AID" | jq -r .agent.status)
check R01 "rotation requested on the Agents page: the agent took a new credential and stays $ST" bash -c "[ '$C1' != '$C0' ] && [[ '$C1' == oac_* ]] && [ '$ST' = online ]"
hb() { "${CURL[@]}" -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -d '{"version":"1.3.0"}' "$OO_URL/api/v1/agents/$AID/heartbeat"; }
c=$(hb "$C0")
check R02 "the old credential still works during the 10-minute overlap ($c)" [ "$c" = 200 ]
RT=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $C0" -H 'Content-Type: application/json' -d '{}' "$OO_URL/api/v1/agents/$AID/credential/rotate")
check R03 "the old credential cannot rotate again ($RT)" [ "$RT" = 409 ]
if [ -n "${OO_PSQL:-}" ]; then
  $OO_PSQL -qc "UPDATE agents SET credential_prev_until = now() - interval '1 second' WHERE id = '$AID'" >/dev/null
  sleep 31   # credential cache
  check R04 "after the overlap the old credential is refused ($(hb "$C0")), the new one works ($(hb "$C1"))" bash -c "[ $(hb "$C0") = 401 ] && [ $(hb "$C1") = 200 ]"
  $OO_PSQL -qc "UPDATE agents SET credential_issued_at = now() - interval '400 days' WHERE id = '$AID'" >/dev/null
  sleep 31
  waitfor 40 bash -c "[ \"\$(cat /var/lib/observaone-agent/credential)\" != '$C1' ]"
  check R05 "a credential older than AGENT_CREDENTIAL_DAYS is rotated by itself" bash -c "[ \"\$(cat /var/lib/observaone-agent/credential)\" != '$C1' ]"
else res SKIP R04 "overlap end and age-based rotation (set OO_PSQL)"; fi

# ---------------- signed releases ----------------
check S01 "the installer pinned the release signing key (/etc/observaone-agent/release.pub)" test -s /etc/observaone-agent/release.pub
if [ -n "${OO_FILES:-}" ] && [ -s "$OO_FILES/SHA256SUMS.sig" ]; then
  observaone-agent verify-release --key /etc/observaone-agent/release.pub --sums "$OO_FILES/SHA256SUMS" --sig "$OO_FILES/SHA256SUMS.sig" >/dev/null
  check S02 "the published build verifies against the pinned key" [ $? = 0 ]
  cp "$OO_FILES/SHA256SUMS.sig" /tmp/scn6.sig; cp "$OO_FILES/SHA256SUMS" /tmp/scn6.sums
  printf '%064d  observaone-agent-linux-arm64\n' 1 >> "$OO_FILES/SHA256SUMS"   # a tampered list, old signature
  LATEST=$(api "$OO_UI/api/agents/$AID/manage" | jq -r .latest); CUR=$(observaone-agent version | awk '{print $2}')
  if [ "$LATEST" != "$CUR" ]; then
    A=$(api -d '{"action":"upgrade"}' "$OO_UI/api/agents/$AID/actions" | jq -r .action.id)
    waitfor 120 bash -c "S=\$(curl -s -b $J -H 'X-Requested-With: observa' $OO_UI/api/agents/$AID/manage | jq -r '.actions[] | select(.id==$A) | .state'); [ \"\$S\" = failed ] || [ \"\$S\" = done ]"
    R=$(api "$OO_UI/api/agents/$AID/manage" | jq -r ".actions[] | select(.id==$A) | .result.message")
    check S03 "the updater refuses a SHA256SUMS that the pinned key did not sign: $R" bash -c "[[ '$R' == *'not signed'* ]] && [ '$(observaone-agent version | awk '{print $2}')' = '$CUR' ]"
  else res SKIP S03 "updater signature check (publish a newer version than $CUR)"; fi
  cp /tmp/scn6.sig "$OO_FILES/SHA256SUMS.sig"; cp /tmp/scn6.sums "$OO_FILES/SHA256SUMS"
  # a different release key on the server: the installer stops unless told to trust it
  cp "$OO_FILES/release.pub" /tmp/scn6.pub
  openssl genpkey -algorithm ed25519 2>/dev/null | openssl pkey -pubout > "$OO_FILES/release.pub" 2>/dev/null
  OUT=$(bash "$(dirname "$0")/../install.sh" --server "$OO_URL" --files-dir "$OO_FILES" 2>&1 < /dev/null || true)
  cp /tmp/scn6.pub "$OO_FILES/release.pub"
  check S04 "the installer refuses a release key that differs from the pinned one" bash -c 'grep -q "release signing key differs" <<<"$1"' _ "$OUT"
else res SKIP S02 "signature checks (set OO_FILES; the server must publish SHA256SUMS.sig)"; fi

# ---------------- disk buffer ----------------
if command -v iptables >/dev/null && [ -n "${OO_IPTABLES:-}" ]; then
  printf 'disk_buffer:\n  enabled: true\nbuffer_payloads: 2\ncollect_interval: 5s\n' > /etc/observaone-agent/conf.d/95-scn-disk.yaml; chmod 0644 /etc/observaone-agent/conf.d/95-scn-disk.yaml
  systemctl restart observaone-agent; sleep 15
  PORT=${OO_URL##*:}; case "$PORT" in https*) PORT=443;; esac
  T0=$(date +%s)
  iptables -I OUTPUT -p tcp --dport "$PORT" -j DROP
  sleep 70
  N=$(observaone-agent status | awk '/^Disk buffer/{print $3}')
  iptables -D OUTPUT -p tcp --dport "$PORT" -j DROP
  check D01 "server unreachable 70 s with a 2-collection memory buffer: ${N:-0} collections went to disk instead of being dropped" bash -c "[ ${N:-0} -ge 5 ]"
  waitfor 120 bash -c "[ -z \"\$(observaone-agent status | awk '/^Disk buffer/{print \$3}')\" ]"
  sleep 20
  GOT=$(promq "count_over_time(node_load1{agent_id=\"$AID\"}[$(( $(date +%s) - T0 + 5 ))s] @ $(date +%s))")
  check D02 "after the outage the disk buffer drained and Prometheus has the outage's samples ($GOT samples of node_load1 since the cut, ~$(( ($(date +%s) - T0) / 5 )) expected)" \
    bash -c "[ -z \"\$(observaone-agent status | awk '/^Disk buffer/{print \$3}')\" ] && [ ${GOT:-0} -ge 12 ]"
  rm -f /etc/observaone-agent/conf.d/95-scn-disk.yaml; systemctl restart observaone-agent; sleep 10
else res SKIP D01 "disk buffer outage (set OO_IPTABLES=1; needs iptables)"; fi

# ---------------- tenants ----------------
TID=$(api -d "{\"name\":\"Scn Bank $RUN\"}" "$OO_UI/api/tenants" | jq -r .id)
PW="Tenant#Pass-$RUN-12345"
api -o /dev/null -d "{\"username\":\"tuser$RUN\",\"password\":\"$PW\",\"role\":\"admin\"}" "$OO_UI/api/users"
api -o /dev/null -X PUT -d "{\"tenant\":\"$TID\"}" "$OO_UI/api/users/tuser$RUN/tenant"
[ "$(login "$JT" "tuser$RUN" "$PW")" = 200 ] || res FAIL T00 "tenant user login"
N=$(tapi "$OO_UI/api/agents" | jq '.agents | length')
c=$(tapi -o /dev/null -w '%{http_code}' "$OO_UI/api/agents/$AID")
check T01 "a new tenant's admin sees none of the platform's agents (list $N) and another tenant's agent is 'not found' ($c)" bash -c "[ '$N' = 0 ] && [ '$c' = 404 ]"
TOK=$(tapi -d '{"name":"tenant token","maxUses":2}' "$OO_UI/api/agent-tokens" | jq -r .token)
E=$("${CURL[@]}" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "{\"hostname\":\"tnt-$RUN\",\"platform\":\"linux\",\"arch\":\"amd64\",\"version\":\"1.3.0\",\"os\":\"Test OS\",\"nonce\":\"$(NONCE)\",\"timestamp\":$(NOW)}" "$OO_URL/api/v1/agents/register")
TA=$(echo "$E" | jq -r .agentId); TC=$(echo "$E" | jq -r .credential)
"${CURL[@]}" -o /dev/null -H "Authorization: Bearer $TC" -H 'Content-Type: application/json' -d '{"version":"1.3.0"}' "$OO_URL/api/v1/agents/$TA/heartbeat"
printf 'node_load1 0.42\nevil{tenant="t_default"} 1\n' | gzip | "${CURL[@]}" -o /dev/null -H "Authorization: Bearer $TC" -H 'Content-Encoding: gzip' -H 'Content-Type: text/plain' --data-binary @- "$OO_URL/api/v1/agents/$TA/metrics"
sleep 3
N=$(tapi "$OO_UI/api/agents" | jq -r '[.agents[].id] | join(",")')
NA=$(api "$OO_UI/api/agents" | jq --arg a "$TA" '[.agents[] | select(.id==$a)] | length')
check T02 "an agent enrolled with the tenant's token belongs to it: the tenant sees only it ($N), the platform admin sees it too ($NA)" bash -c "[ '$N' = '$TA' ] && [ '$NA' = 1 ]"
TL=$(promq "count(node_load1{agent_id=\"$TA\",tenant=\"$TID\"})"); EV=$(promq "count(evil{agent_id=\"$TA\",tenant=\"t_default\"})")
check T03 "its series carry tenant=$TID set by the server; a tenant label sent by the agent is ignored" bash -c "[ '$TL' = 1 ] && [ -z '$EV' ]"
QT=$(tapi -G "$OO_UI/api/prom/query" --data-urlencode 'query=count by (agent_id) (node_load1)' | jq -r '[.result[].metric.agent_id] | join(",")')
QA=$(api -G "$OO_UI/api/prom/query" --data-urlencode 'query=count(count by (agent_id) (node_load1))' | jq -r '.result[0].value[1]')
check T04 "a PromQL query by the tenant only sees its own series ($QT); the platform admin sees all ($QA agents)" bash -c "[ '$QT' = '$TA' ] && [ ${QA:-0} -ge 2 ]"
QX=$(tapi -G "$OO_UI/api/prom/query" --data-urlencode 'query=sum(rate(node_cpu_seconds_total{tenant="t_default"}[5m]))' | jq -r '.result | length')
check T05 "asking for another tenant's series explicitly returns nothing ($QX)" [ "$QX" = 0 ]
LV=$(tapi -G "$OO_UI/api/prom/label-values" --data-urlencode 'label=host' | jq -r 'if type=="array" then join(",") else (.values // [] | join(",")) end')
check T06 "label values (host pickers) only list the tenant's hosts ($LV)" bash -c "[ '$LV' = 'tnt-$RUN' ]"
c=$(tapi -o /dev/null -w '%{http_code}' -X POST "$OO_UI/api/agents/$AID/block"); c2=$(tapi -o /dev/null -w '%{http_code}' "$OO_UI/api/tenants")
check T07 "the tenant cannot act on another tenant's agent ($c) or see the tenant list ($c2)" bash -c "[ $c = 404 ] && [ $c2 = 404 ]"
api -o /dev/null -X DELETE "$OO_UI/api/agents/$TA"

# ---------------- site gateway ----------------
if [ -n "${OO_GATEWAY_URL:-}" ]; then
  GW=${OO_GATEWAY_URL%/}
  G=(curl -s --max-time 20)
  H=$("${G[@]}" "$GW/healthz" | jq -r .upstream)
  T=$(api -d '{"name":"via gateway","maxUses":2}' "$OO_UI/api/agent-tokens" | jq -r .token)
  E=$("${G[@]}" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d "{\"hostname\":\"gw-$RUN\",\"platform\":\"linux\",\"arch\":\"amd64\",\"version\":\"1.3.0\",\"os\":\"Test OS\",\"nonce\":\"$(NONCE)\",\"timestamp\":$(NOW)}" "$GW/api/v1/agents/register")
  GA=$(echo "$E" | jq -r .agentId); GC=$(echo "$E" | jq -r .credential)
  ghb() { "${G[@]}" -H "Authorization: Bearer $GC" -H 'Content-Type: application/json' -d '{"version":"1.3.0"}' "$GW/api/v1/agents/$GA/heartbeat"; }
  R=$(ghb)
  GID=$(api "$OO_UI/api/agents/$GA" | jq -r .agent.gatewayId)
  check G01 "enrollment and heartbeat through the gateway (link $H): the centre shows the agent via gateway $GID" bash -c "[[ '$GA' == agt_* ]] && [ '$(echo "$R" | jq -r .status)' != null ] && [[ '$GID' == gw_* ]]"
  eval "${OO_GATEWAY_BLOCK:?set OO_GATEWAY_BLOCK to a command that cuts the gateway from the centre}"
  sleep 2
  R=$(ghb); TS=$(( $(date +%s) - 5 ))
  M=$(printf 'node_load1 0.77 %s000\n' "$TS" | gzip | "${G[@]}" -w ' %{http_code}' -H "Authorization: Bearer $GC" -H 'Content-Encoding: gzip' -H 'Content-Type: text/plain' -H "X-Agent-Time: $(NOW)" --data-binary @- "$GW/api/v1/agents/$GA/metrics")
  SP=$("${G[@]}" "$GW/healthz" | jq -r '.files')
  check G02 "centre unreachable: the gateway answers the heartbeat itself ($(echo "$R" | jq -r .upstream)) and spools the upload ($(code "$M"), $SP spooled)" \
    bash -c "[ '$(echo "$R" | jq -r .viaGateway)' = true ] && [ '$(code "$M")' = 202 ] && [ ${SP:-0} -ge 1 ]"
  U=$("${G[@]}" -o /dev/null -w '%{http_code}' -H "Authorization: Bearer oac_00000000000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" -H 'Content-Type: text/plain' --data-binary 'x 1' "$GW/api/v1/agents/agt_00000000000000000000/metrics")
  check G03 "an unknown credential is not spooled while the centre is down ($U)" [ "$U" = 503 ]
  eval "${OO_GATEWAY_UNBLOCK:?}"
  waitfor 60 bash -c "[ \"\$(curl -s $GW/healthz | jq -r .files)\" = 0 ] && [ \"\$(curl -s $GW/healthz | jq -r .pending)\" = 0 ]"
  sleep 3
  V=$(promq "node_load1{agent_id=\"$GA\"} @ $TS")
  check G04 "link back: the spooled upload and the heartbeat were replayed (sample at the outage time: $V)" bash -c "[ '$V' = 0.77 ] && [ \"\$(curl -s $GW/healthz | jq -r .files)\" = 0 ]"
  GS=$(api "$OO_UI/api/gateways" | jq -c --arg g "$GID" '.gateways[] | select(.id==$g) | {online, agents, spooled: .stats.spooledFiles}')
  check G05 "the gateway reports its state to the centre (Agents > Gateways shows $GS)" bash -c "[[ '$GS' == *'\"online\":true'* ]] && [[ '$GS' == *'\"agents\":1'* ]]"
  api -o /dev/null -X DELETE "$OO_UI/api/agents/$GA"
else res SKIP G01 "site gateway (set OO_GATEWAY_URL, OO_GATEWAY_BLOCK, OO_GATEWAY_UNBLOCK)"; fi

echo "failures: $FAILS"
exit $FAILS
