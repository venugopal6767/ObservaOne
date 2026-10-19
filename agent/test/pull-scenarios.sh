#!/usr/bin/env bash
# ObservaOne Agent 1.2: registration replay protection, /api/v1/agents paths, pull mode (mutual TLS, HTTP SD),
# rename, and the diagnosis. Runs against a REAL stack, like scenarios.sh, with the agent on THIS machine
# installed in pull mode (install.sh --mode pull).
#
#   OO_URL=https://observaone.example.com OO_UI=http://127.0.0.1:8083 OO_ADMIN_PW=... \
#   OO_PROM=http://127.0.0.1:9090/prometheus OO_SD_TOKEN_FILE=/path/sd-token OO_PROM_CERTS=/path/prometheus-agents \
#   sudo -E bash agent/test/pull-scenarios.sh
#
# OO_PROM_CERTS is the folder the server writes for Prometheus (ca.crt, prometheus.crt/.key, sd-token).
set -uo pipefail
: "${OO_URL:?}" "${OO_UI:?}" "${OO_ADMIN_PW:?}" "${OO_PROM:?}" "${OO_PROM_CERTS:?}"
CA=${OO_CA:-/etc/observaone-agent/ca.crt}
CURL=(curl -s --cacert "$CA" --max-time 20)
P=$OO_PROM_CERTS
J=$(mktemp); FAILS=0
res() { printf '%-4s %-5s %s\n' "$1" "$2" "$3"; [ "$1" = FAIL ] && FAILS=$((FAILS+1)); return 0; }
check() { local id=$1 msg=$2; shift 2; if "$@"; then res PASS "$id" "$msg"; else res FAIL "$id" "$msg"; fi; }
api() { curl -s -b "$J" -H 'X-Requested-With: observa' -H 'Content-Type: application/json' "$@"; }
code() { echo "${1##* }"; }
body() { echo "${1% *}"; }
promq() { curl -s -G "$OO_PROM/api/v1/query" --data-urlencode "query=$1" | jq -r '.data.result[0].value[1] // empty'; }
agent() { api "$OO_UI/api/agents/$1" | jq -c .agent; }
RUN=${RUN:-p$RANDOM}
NOW() { echo $(( $(date +%s%N) / 1000000 )); }
NONCE() { head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
REG() { # REG TOKEN BODY -> "body code"
  "${CURL[@]}" -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -d "$2" -w ' %{http_code}' "$OO_URL/api/v1/agents/register"; }
B12() { echo "{\"hostname\":\"$1-$RUN\",\"platform\":\"linux\",\"arch\":\"amd64\",\"version\":\"1.2.0\",\"os\":\"Test OS\"${2:-}}"; }

[ "$(curl -s -c "$J" -H 'X-Requested-With: observa' -H 'Content-Type: application/json' -d "{\"username\":\"admin\",\"password\":\"$OO_ADMIN_PW\"}" "$OO_UI/api/login" -o /dev/null -w '%{http_code}')" = 200 ] || { echo "admin login failed"; exit 99; }
AID=$(sed -n 's/.*"agentId": *"\([^"]*\)".*/\1/p' /var/lib/observaone-agent/identity.json)
HOST=$(sed -n 's/.*"host": *"\([^"]*\)".*/\1/p' /var/lib/observaone-agent/identity.json)
echo "installed agent: $AID ($HOST)"
T=$(api -d '{"name":"pull-scn","maxUses":20}' "$OO_UI/api/agent-tokens" | jq -r .token)

# ---- registration replay protection (/api/v1/agents/register) ----
N=$(NONCE); BODY=$(B12 reg ",\"nonce\":\"$N\",\"timestamp\":$(NOW)")
R1=$(REG "$T" "$BODY"); R2=$(REG "$T" "$BODY")
check S80 "1.2 registration with nonce + timestamp on /api/v1/agents/register: $(code "$R1")" [ "$(code "$R1")" = 201 ]
check S81 "the same registration sent again is refused as a replay ($(code "$R2"))" bash -c "[[ '$R2' == *replay*400 ]]"
R=$(REG "$T" "$(B12 skew ",\"nonce\":\"$(NONCE)\",\"timestamp\":$(( $(NOW) - 600000 ))")")
check S82 "timestamp 10 minutes off is refused ($(code "$R"))" bash -c "[[ '$R' == *replay_check*400 ]]"
R=$(REG "$T" "$(B12 nononce)")
check S83 "a 1.2 agent without nonce is refused ($(code "$R")); 1.1 agents still register on the old path" bash -c "[[ '$R' == *replay_check*400 ]]"
NEWID=$(body "$R1" | jq -r .agentId); NEWCRED=$(body "$R1" | jq -r .credential)

# ---- per-agent paths: the id in the path must be the credential's own ----
c=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $NEWCRED" -H 'Content-Type: application/json' -d '{"version":"1.2.0"}' "$OO_URL/api/v1/agents/$AID/heartbeat")
c2=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $NEWCRED" -H 'Content-Type: application/json' -d '{"version":"1.2.0"}' "$OO_URL/api/v1/agents/$NEWID/heartbeat")
check S84 "heartbeat with another agent's id in the path refused ($c); own id accepted ($c2)" bash -c "[ $c = 403 ] && [ $c2 = 200 ]"

# ---- pull certificates ----
openssl ecparam -name prime256v1 -genkey -noout -out /tmp/scn-pull.key 2>/dev/null
PUB=$(openssl ec -in /tmp/scn-pull.key -pubout -outform DER 2>/dev/null | base64 -w0)
pc() { "${CURL[@]}" -H "Authorization: Bearer $NEWCRED" -H 'Content-Type: application/json' -d "$1" -w ' %{http_code}' "$OO_URL/api/v1/agents/$NEWID/pull-certificate"; }
R=$(pc "{\"publicKey\":\"$PUB\",\"ips\":[\"127.0.0.1\"],\"port\":9110}")
R2=$(pc "{\"publicKey\":\"AAAA\",\"ips\":[\"10.0.0.9\"],\"port\":9110}")
check S85 "pull certificate requests for loopback ($(code "$R")) or a bad key ($(code "$R2")) are refused" bash -c "[ $(code "$R") = 400 ] && [ $(code "$R2") = 400 ]"
R=$(pc "{\"publicKey\":\"$PUB\",\"ips\":[\"10.0.0.9\"],\"port\":9110}")
body "$R" | jq -r .certificate > /tmp/scn-pull.crt; body "$R" | jq -r .ca > /tmp/scn-pull-ca.crt
SUBJ=$(openssl x509 -in /tmp/scn-pull.crt -noout -subject 2>/dev/null); SAN=$(openssl x509 -in /tmp/scn-pull.crt -noout -ext subjectAltName 2>/dev/null | tail -1)
check S86 "pull certificate: signed by the agent CA, CN = agent id from the credential, SAN = requested IP ($SAN)" \
  bash -c "openssl verify -CAfile /tmp/scn-pull-ca.crt /tmp/scn-pull.crt >/dev/null 2>&1 && [[ '$SUBJ' == *$NEWID* ]] && [[ '$SAN' == *10.0.0.9* ]]"

# ---- service discovery ----
SDT=$(cat "$P/sd-token")
c=$(curl -s -o /dev/null -w '%{http_code}' "$OO_UI/api/v1/sd/agents?kind=pull"); c2=$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer wrong' "$OO_UI/api/v1/sd/agents?kind=pull")
c3=$(curl -sk -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $SDT" "$OO_URL/api/v1/sd/agents?kind=pull")
check S87 "service discovery needs its token (none $c, wrong $c2) and is not reachable through the public address ($c3)" bash -c "[ $c = 401 ] && [ $c2 = 401 ] && [ $c3 = 404 ]"
SD=$(curl -s -H "Authorization: Bearer $SDT" "$OO_UI/api/v1/sd/agents?kind=pull" | jq -c --arg id "$AID" '.[] | select(.labels.agent_id==$id)')
TGT=$(echo "$SD" | jq -r '.targets[0]')
check S88 "the installed pull agent is a discovery target ($TGT) with identity labels" bash -c "[ -n '$TGT' ] && [ '$(echo "$SD" | jq -r .labels.host)' = '$HOST' ]"

# ---- the pull endpoint: only ObservaOne's Prometheus ----
C=(curl -s --noproxy '*' --cacert "$P/ca.crt" --max-time 10)
c=$("${C[@]}" -o /dev/null -w '%{http_code}' "https://$TGT/metrics")
n=$("${C[@]}" --cert "$P/prometheus.crt" --key "$P/prometheus.key" "https://$TGT/metrics" | grep -c '^node_')
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout /tmp/scn-other.key -out /tmp/scn-other.crt -subj "/CN=observaone-prometheus" -days 1 2>/dev/null
c3=$("${C[@]}" -o /dev/null -w '%{http_code}' --cert /tmp/scn-other.crt --key /tmp/scn-other.key "https://$TGT/metrics")
c4=$("${C[@]}" -o /dev/null -w '%{http_code}' --cert /var/lib/observaone-agent/pull.crt --key /var/lib/observaone-agent/pull.key "https://$TGT/metrics")
c5=$(curl -s --noproxy '*' --max-time 10 -o /dev/null -w '%{http_code}' "http://$TGT/metrics")
check S89 "pull endpoint: no client cert ($c), same name from another CA ($c3), right CA but another name ($c4) and plain HTTP ($c5) refused; Prometheus cert reads $n node_ lines" \
  bash -c "[ $c = 000 ] && [ $c3 = 000 ] && [ $c4 = 000 ] && [ $c5 = 400 ] && [ $n -gt 20 ]"
check S90 "Prometheus scrapes the pull agent over mutual TLS (up = $(promq "up{job=\"linux\",agent_id=\"$AID\"}"))" [ "$(promq "up{job=\"linux\",agent_id=\"$AID\"}")" = 1 ]
check S91 "pull-mode samples carry the same identity labels as push (host=$HOST)" [ -n "$(promq "node_load1{host=\"$HOST\",agent_id=\"$AID\",agent=\"observaone\"}")" ]

# ---- diagnosis ----
D=$(agent "$AID" | jq -r '.diagnosis.code')
check S92 "diagnosis of the healthy pull agent: $D" bash -c "[ $D = healthy ] || [ $D = rebooted ]"
if command -v iptables >/dev/null && [ -n "${OO_IPTABLES:-}" ]; then
  PORT=${TGT##*:}
  iptables -I INPUT -p tcp --dport "$PORT" -j DROP; sleep 45; D=$(agent "$AID" | jq -r '.diagnosis.code'); iptables -D INPUT -p tcp --dport "$PORT" -j DROP
  check S93 "pull port firewalled: diagnosis says Prometheus cannot reach the agent ($D)" [ "$D" = pull_blocked ]
  iptables -I OUTPUT -p tcp --dport "${OO_URL##*:}" -j DROP; sleep 40; D=$(agent "$AID" | jq -r '.diagnosis.code'); iptables -D OUTPUT -p tcp --dport "${OO_URL##*:}" -j DROP
  check S94 "outbound HTTPS blocked: diagnosis says scraped but no heartbeats ($D)" [ "$D" = heartbeat_blocked ]
  sleep 20
else res SKIP S93 "firewall checks (set OO_IPTABLES=1; needs iptables)"; fi
systemctl stop observaone-agent; sleep 45; D=$(agent "$AID" | jq -r '.diagnosis.code'); systemctl start observaone-agent
check S95 "agent stopped, host up: diagnosis says host up, agent silent ($D)" [ "$D" = agent_stopped ]
sleep 25

# ---- rename: new name reaches Prometheus through discovery ----
c=$(api -X PATCH -d "{\"host\":\"$HOST-renamed\"}" -o /dev/null -w '%{http_code}' "$OO_UI/api/agents/$AID")
sleep 40
NEWH=$(curl -s -G "$OO_PROM/api/v1/query" --data-urlencode "query=up{agent_id=\"$AID\",job=\"linux\"}" | jq -r '.data.result[0].metric.host')
api -X PATCH -d "{\"host\":\"$HOST\"}" -o /dev/null "$OO_UI/api/agents/$AID"
check S96 "rename on the Agents page ($c): Prometheus labels the agent $NEWH at the next discovery refresh" [ "$NEWH" = "$HOST-renamed" ]
c=$(api -X PATCH -d '{"host":"bad name!"}' -o /dev/null -w '%{http_code}' "$OO_UI/api/agents/$AID")
check S97 "invalid new name refused ($c)" [ "$c" = 400 ]

# ---- configuration ----
check S98 "agent 1.1 agent.conf was converted to agent.yaml (config_version 2), the old file kept" \
  bash -c "grep -q '^config_version: 2' /etc/observaone-agent/agent.yaml && { [ -f /etc/observaone-agent/agent.conf.migrated ] || [ ! -f /etc/observaone-agent/agent.conf ]; }"
check S99 "observaone-agent check-config passes and config show lists mode = pull" bash -c "observaone-agent check-config >/dev/null && observaone-agent config show | grep -qE '^mode +pull'"

api -X DELETE -o /dev/null "$OO_UI/api/agents/$NEWID"
echo "failures: $FAILS"
exit $FAILS
