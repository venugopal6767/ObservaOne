#!/usr/bin/env bash
# ObservaOne Agent 1.3 management: settings layers, actions (diagnostics, restart, upgrade + rollback), Add Target.
# Runs against a REAL stack with an agent >= 1.3 installed on THIS machine (install.sh), like scenarios.sh.
#
#   OO_URL=https://observaone.example.com OO_UI=http://127.0.0.1:8083 OO_ADMIN_PW=... OO_PROM=http://127.0.0.1:9090/prometheus \
#   sudo -E bash agent/test/manage-scenarios.sh
#
# Upgrade checks (M30-M33) need the server to publish a NEWER version than the installed one (agent/files), and
# OO_FILES=<the folder the server serves as /agent/files> so the rollback check can publish a broken build there
# for a minute (the original files are put back). Without OO_FILES they are skipped.
set -uo pipefail
: "${OO_URL:?}" "${OO_UI:?}" "${OO_ADMIN_PW:?}" "${OO_PROM:?}"
CA=${OO_CA:-/etc/observaone-agent/ca.crt}
CURL=(curl -s --cacert "$CA" --max-time 20)
J=$(mktemp); FAILS=0
res() { printf '%-4s %-5s %s\n' "$1" "$2" "$3"; [ "$1" = FAIL ] && FAILS=$((FAILS+1)); return 0; }
check() { local id=$1 msg=$2; shift 2; if "$@"; then res PASS "$id" "$msg"; else res FAIL "$id" "$msg"; fi; }
api() { curl -s -b "$J" -H 'X-Requested-With: observa' -H 'Content-Type: application/json' "$@"; }
code() { echo "${1##* }"; }
waitfor() { # waitfor SECONDS CMD...: until CMD succeeds
  local t=$1; shift; for _ in $(seq 1 "$t"); do "$@" && return 0; sleep 1; done; return 1; }
[ "$(curl -s -c "$J" -H 'X-Requested-With: observa' -H 'Content-Type: application/json' -d "{\"username\":\"admin\",\"password\":\"$OO_ADMIN_PW\"}" "$OO_UI/api/login" -o /dev/null -w '%{http_code}')" = 200 ] || { echo "admin login failed"; exit 99; }
AID=$(sed -n 's/.*"agentId": *"\([^"]*\)".*/\1/p' /var/lib/observaone-agent/identity.json)
HOST=$(sed -n 's/.*"host": *"\([^"]*\)".*/\1/p' /var/lib/observaone-agent/identity.json)
ENV=$(api "$OO_UI/api/agents/$AID" | jq -r .agent.env)
echo "installed agent: $AID ($HOST, env=$ENV, $(observaone-agent version))"
M() { api "$OO_UI/api/agents/$AID/manage"; }
src() { observaone-agent config show | awk -v k="$1" '$1==k {print $2" "$3}'; }

# ---------------- settings layers ----------------
c=$(api -X PUT -d '{"settings":{"server":"https://evil.example.com"}}' -o /dev/null -w '%{http_code}' "$OO_UI/api/agents/$AID/config")
c2=$(api -X PUT -d '{"settings":{"collect_interval":"1s"}}' -o /dev/null -w '%{http_code}' "$OO_UI/api/agents/$AID/config")
c3=$(api -X PUT -d '{"settings":{"nginx.status_url":"http://169.254.169.254/"}}' -o /dev/null -w '%{http_code}' "$OO_UI/api/agents/$AID/config")
check M01 "the server address ($c), an out-of-range interval ($c2) and any URL ($c3) cannot be set from the UI" bash -c "[ $c = 400 ] && [ $c2 = 400 ] && [ $c3 = 400 ]"
api -X PUT -d '{"settings":{"buffer_payloads":55,"collect_interval":"60s"}}' -o /dev/null "$OO_UI/api/agent-config/env/$ENV"
api -X PUT -d '{"settings":{"collect_interval":"20s","disable":["network"]}}' -o /dev/null "$OO_UI/api/agents/$AID/config"
V=$(M | jq -r .config.version)
waitfor 30 bash -c "[ \"\$(curl -s -b $J -H 'X-Requested-With: observa' $OO_UI/api/agents/$AID/manage | jq -r .config.state)\" = applied ]"
check M02 "layered settings (env + agent) reach the agent and it confirms version $V: $(M | jq -r '.config.state + " (agent has " + (.config.applied|tostring) + ")"')" [ "$(M | jq -r .config.state)" = applied ]
check M03 "agent layer wins over environment (collect_interval: $(src collect_interval)); environment value used where the agent sets none (buffer_payloads: $(src buffer_payloads))" \
  bash -c "[[ '$(src collect_interval)' == '20s server' ]] && [[ '$(src buffer_payloads)' == '55 server' ]] && [[ '$(src disable)' == 'network server' ]]"
sleep 25
NET=$(curl -s -G "$OO_PROM/api/v1/query" --data-urlencode "query=count(node_network_receive_bytes_total{agent_id=\"$AID\"})" | jq -r '.data.result[0].value[1] // 0')
COLL=$(api "$OO_UI/api/agents/$AID" | jq -r '.agent.diag.collectors.network // empty')
check M04 "a collector turned off from the UI stops (heartbeat says $COLL)" [ "$COLL" = disabled ]
# host file wins
printf 'collect_interval: 45s\n' > /etc/observaone-agent/conf.d/90-scn.yaml; chmod 0644 /etc/observaone-agent/conf.d/90-scn.yaml; systemctl reload observaone-agent; sleep 3
check M05 "a host file wins over the UI ($(src collect_interval)); the UI shows it as locked: $(M | jq -c .config.hostLocked)" bash -c "[[ '$(src collect_interval)' == 45s* ]]"
rm -f /etc/observaone-agent/conf.d/90-scn.yaml; systemctl reload observaone-agent
# the agent survives a restart with the settings it was given (saved locally)
api -X PUT -d '{"settings":{}}' -o /dev/null "$OO_UI/api/agents/$AID/config"; api -X PUT -d '{"settings":{}}' -o /dev/null "$OO_UI/api/agent-config/env/$ENV"
waitfor 30 bash -c "[ \"\$(curl -s -b $J -H 'X-Requested-With: observa' $OO_UI/api/agents/$AID/manage | jq -r .config.state)\" = applied ]"
check M06 "clearing the layers returns the agent to its defaults ($(src collect_interval))" bash -c "[[ '$(src collect_interval)' == '15s default' ]]"

# ---------------- actions ----------------
c=$(api -o /dev/null -w '%{http_code}' -d '{"action":"shell","args":{"cmd":"id"}}' "$OO_UI/api/agents/$AID/actions")
check M10 "only the fixed actions exist: a 'shell' action is refused ($c)" [ "$c" = 400 ]
A=$(api -d '{"action":"diagnostics"}' "$OO_UI/api/agents/$AID/actions" | jq -r .action.id)
c=$(api -o /dev/null -w '%{http_code}' -d '{"action":"diagnostics"}' "$OO_UI/api/agents/$AID/actions")
check M11 "a second request while one is waiting is refused ($c)" [ "$c" = 409 ]
waitfor 40 bash -c "[ \"\$(curl -s -b $J -H 'X-Requested-With: observa' $OO_UI/api/agents/$AID/manage | jq -r '.actions[] | select(.id==$A) | .state')\" = done ]"
DID=$(M | jq -r '.diagnostics[0].id')
B=$(api "$OO_UI/api/agents/$AID/diagnostics/$DID")
CRED=$(cat /var/lib/observaone-agent/credential)
check M12 "diagnostics bundle uploaded (#$DID, $(echo "$B" | jq -r .size) bytes) with status, settings, system, checks and log lines" \
  bash -c "[ '$(echo "$B" | jq -r '[.bundle.status, .bundle.settings, .bundle.system, .bundle.checks, .bundle.logs] | map(. != null) | all')' = true ]"
check M13 "the bundle holds no credential, token or key (and TLS to the server checks out: $(echo "$B" | jq -r .bundle.checks.tls))" \
  bash -c "! grep -qE '$CRED|oac_[0-9a-f]{20}_|oat_|PRIVATE KEY' <<<'$(echo "$B" | jq -c .bundle)' && [[ '$(echo "$B" | jq -r .bundle.checks.tls)' == ok* ]]"
P1=$(pgrep -u observaone-agent -f "observaone-agent run" | head -1)
A=$(api -d '{"action":"restart"}' "$OO_UI/api/agents/$AID/actions" | jq -r .action.id)
waitfor 60 bash -c "P=\$(pgrep -u observaone-agent -f 'observaone-agent run' | head -1); [ -n \"\$P\" ] && [ \"\$P\" != '$P1' ]"
P2=$(pgrep -u observaone-agent -f "observaone-agent run" | head -1)
sleep 20
P3=$(pgrep -u observaone-agent -f "observaone-agent run" | head -1)
ST=$(M | jq -r ".actions[] | select(.id==$A) | .state")
check M14 "restart: the agent exits and systemd starts it again (pid $P1 -> $P2), action $ST, and it does not restart again ($P3)" \
  bash -c "[ -n '$P2' ] && [ '$P1' != '$P2' ] && [ '$P2' = '$P3' ] && [ '$ST' = done ]"
A=$(api -d '{"action":"diagnostics"}' "$OO_UI/api/agents/$AID/actions" | jq -r .action.id)
api -X POST -o /dev/null "$OO_UI/api/agents/$AID/block"
c=$(api -o /dev/null -w '%{http_code}' -d '{"action":"restart"}' "$OO_UI/api/agents/$AID/actions")
api -X POST -o /dev/null "$OO_UI/api/agents/$AID/unblock"
check M15 "a blocked agent gets no actions ($c)" [ "$c" = 409 ]
waitfor 40 bash -c "[ \"\$(curl -s -b $J -H 'X-Requested-With: observa' $OO_UI/api/agents/$AID/manage | jq -r '.actions[] | select(.id==$A) | .state')\" = done ]"

# ---------------- upgrade (needs a newer published version) ----------------
LATEST=$(M | jq -r .latest); CUR=$(observaone-agent version | awk '{print $2}')
if [ -n "${OO_FILES:-}" ] && [ "$LATEST" != "$CUR" ]; then
  # 1. a broken build first: the updater must roll back
  BIN="observaone-agent-linux-$(case $(uname -m) in aarch64|arm64) echo arm64;; *) echo amd64;; esac)"
  mkdir -p /tmp/scn-files-orig && cp -p "$OO_FILES/$BIN" "$OO_FILES/SHA256SUMS" /tmp/scn-files-orig/
  printf '#!/bin/sh\ncase "$1" in version) echo "observaone-agent %s";; check-config) echo ok;; *) echo "broken build" >&2; exit 1;; esac\n' "$LATEST" > "$OO_FILES/$BIN"
  chmod 0755 "$OO_FILES/$BIN"; (cd "$OO_FILES" && sha256sum "$BIN" > SHA256SUMS)
  A=$(api -d '{"action":"upgrade"}' "$OO_UI/api/agents/$AID/actions" | jq -r .action.id)
  waitfor 150 bash -c "S=\$(curl -s -b $J -H 'X-Requested-With: observa' $OO_UI/api/agents/$AID/manage | jq -r '.actions[] | select(.id==$A) | .state'); [ \"\$S\" = failed ] || [ \"\$S\" = done ]"
  R=$(M | jq -c ".actions[] | select(.id==$A) | .result")
  cp -p /tmp/scn-files-orig/* "$OO_FILES/"
  sleep 15
  check M30 "upgrade to a build that does not start is rolled back: $(echo "$R" | jq -r .message)" \
    bash -c "[ '$(echo "$R" | jq -r .ok)' = false ] && [ '$(observaone-agent version | awk '{print $2}')' = '$CUR' ] && [ -x /opt/observaone-agent/bin/observaone-agent.failed ]"
  check M31 "after the rollback the old version reports again ($(observaone-agent status | awk '/^Version/{print $2}'), heartbeat $(observaone-agent status | awk '/^Heartbeat/{print $2" "$3}'))" \
    bash -c "observaone-agent status | grep -q '^Heartbeat .*[0-9]s ago'"
  # 2. a tampered binary: checksum mismatch, nothing changes
  cp "$OO_FILES/SHA256SUMS" /tmp/scn-sums; printf '%064d  %s\n' 0 "$BIN" > "$OO_FILES/SHA256SUMS"
  A=$(api -d '{"action":"upgrade"}' "$OO_UI/api/agents/$AID/actions" | jq -r .action.id)
  waitfor 90 bash -c "S=\$(curl -s -b $J -H 'X-Requested-With: observa' $OO_UI/api/agents/$AID/manage | jq -r '.actions[] | select(.id==$A) | .state'); [ \"\$S\" = failed ] || [ \"\$S\" = done ]"
  R=$(M | jq -r ".actions[] | select(.id==$A) | .result.message"); cp /tmp/scn-sums "$OO_FILES/SHA256SUMS"
  check M32 "a binary that does not match SHA256SUMS is not installed: $R" bash -c "[[ '$R' == *mismatch* ]] && [ '$(observaone-agent version | awk '{print $2}')' = '$CUR' ]"
  # 3. the real one
  A=$(api -d '{"action":"upgrade"}' "$OO_UI/api/agents/$AID/actions" | jq -r .action.id)
  waitfor 150 bash -c "S=\$(curl -s -b $J -H 'X-Requested-With: observa' $OO_UI/api/agents/$AID/manage | jq -r '.actions[] | select(.id==$A) | .state'); [ \"\$S\" = failed ] || [ \"\$S\" = done ]"
  R=$(M | jq -c ".actions[] | select(.id==$A) | .result")
  check M33 "upgrade from the Agents page: $(echo "$R" | jq -r .message); identity kept ($(sed -n 's/.*"agentId": *"\([^"]*\)".*/\1/p' /var/lib/observaone-agent/identity.json))" \
    bash -c "[ '$(echo "$R" | jq -r .ok)' = true ] && [ '$(observaone-agent version | awk '{print $2}')' = '$LATEST' ] && grep -q '$AID' /var/lib/observaone-agent/identity.json"
else res SKIP M30 "upgrade checks (set OO_FILES and publish a newer version than $CUR)"; fi

# ---------------- Add Target ----------------
R=$(api -d "{\"name\":\"scn target $RANDOM\",\"env\":\"lab\",\"role\":\"web\",\"labels\":{\"team\":\"scn\"},\"validHours\":1}" "$OO_UI/api/targets")
TID=$(echo "$R" | jq -r .target.id); TOK=$(echo "$R" | jq -r .token)
c=$(api -o /dev/null -w '%{http_code}' -d '{"name":"x","labels":{"host":"evil"}}' "$OO_UI/api/targets")
check M40 "Add Target returns a one-use token once ($(echo "$TOK" | cut -c1-12)...); a reserved label is refused ($c)" bash -c "[[ '$TOK' == oat_* ]] && [ $c = 400 ]"
P=$(api "$OO_UI/api/targets/$TID/progress")
check M41 "progress before install: nothing done, first step says what to do" bash -c "[ '$(echo "$P" | jq -r '[.steps[]|.done]|any')' = false ] && [ -n '$(echo "$P" | jq -r .steps[0].hint)' ]"
NONCE=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'); NOW=$(( $(date +%s%N) / 1000000 ))
E=$("${CURL[@]}" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "{\"hostname\":\"scn-tgt-$RANDOM\",\"platform\":\"linux\",\"arch\":\"amd64\",\"version\":\"1.3.0\",\"os\":\"Test OS\",\"nonce\":\"$NONCE\",\"timestamp\":$NOW}" "$OO_URL/api/v1/agents/register")
NID=$(echo "$E" | jq -r .agentId); NC=$(echo "$E" | jq -r .credential)
"${CURL[@]}" -o /dev/null -H "Authorization: Bearer $NC" -H 'Content-Type: application/json' -d '{"version":"1.3.0"}' "$OO_URL/api/v1/agents/$NID/heartbeat"
P=$(api "$OO_UI/api/targets/$TID/progress")
A=$(api "$OO_UI/api/agents/$NID" | jq -c '.agent | {env,role,labels}')
check M42 "an agent enrolled with the target's token is bound to it and takes its env/role/labels ($A); checklist: $(echo "$P" | jq -r '[.steps[] | .key + "=" + (.done|tostring)] | join(" ")')" \
  bash -c "[ '$(echo "$P" | jq -r .agent.id)' = '$NID' ] && [ '$(echo "$P" | jq -r '.steps[1].done')' = true ] && [[ '$A' == *'\"env\":\"lab\"'*'\"team\":\"scn\"'* ]]"
E2=$("${CURL[@]}" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "{\"hostname\":\"scn-tgt2\",\"platform\":\"linux\",\"arch\":\"amd64\",\"version\":\"1.3.0\",\"nonce\":\"$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')\",\"timestamp\":$NOW}" -w ' %{http_code}' "$OO_URL/api/v1/agents/register")
check M43 "the target's one-use token cannot enroll a second server ($(code "$E2"))" bash -c "[[ '$E2' == *token_used_up*401 ]]"
api -X DELETE -o /dev/null "$OO_UI/api/agents/$NID"

echo "failures: $FAILS"
exit $FAILS
