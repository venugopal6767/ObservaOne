#!/usr/bin/env bash
# Remove leftover agents and tokens so ObservaOne shows only what you have installed and running now.
# Run from the monitoring-stack folder:
#   bash scripts/cleanup-agents.sh            # show what would be removed (changes nothing)
#   bash scripts/cleanup-agents.sh --apply    # remove it
# Removes: every agent that is NOT online right now (not reporting, offline, waiting, blocked, previous-generation
# agents that stopped). Revokes: tokens that are expired, used up, or never used.
# Keeps: agents online now, and tokens that are still valid and were used.
set -euo pipefail
cd "$(dirname "$0")/.."
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
for c in curl jq; do command -v $c >/dev/null || { echo "'$c' is needed (sudo apt-get install -y $c)"; exit 1; }; done
NAME=$(sed -n 's/^SERVER_NAME=//p' .env); NAME=${NAME:-localhost}
URL="https://$NAME"
ADMIN_USER=$(sed -n 's/^UI_ADMIN_USER=//p' .env); ADMIN_USER=${ADMIN_USER:-admin}
ADMIN_PW=$(sed -n 's/^UI_ADMIN_PASSWORD=//p' .env | sed "s/^['\"]//; s/['\"]$//")
if [ -z "$ADMIN_PW" ]; then read -rsp "ObservaOne admin password: " ADMIN_PW; echo; fi
JAR=$(mktemp); trap 'rm -f "$JAR"' EXIT
C=(curl -s --cacert nginx/certs/server.crt -b "$JAR" -c "$JAR" -H 'X-Requested-With: observa')
code=$(jq -n --arg u "$ADMIN_USER" --arg p "$ADMIN_PW" '{username:$u,password:$p}' | "${C[@]}" -H 'Content-Type: application/json' -d @- -o /dev/null -w '%{http_code}' "$URL/api/login")
[ "$code" = 200 ] || { echo "Sign-in to $URL failed (HTTP $code). If you changed the admin password in the UI, run again and type it when asked (remove UI_ADMIN_PASSWORD from the command environment)."; exit 1; }

echo "== Agents ($URL)"
AG=$("${C[@]}" "$URL/api/agents")
echo "$AG" | jq -r '.agents[] | "  \(if (.status=="online" or .status=="attention") then "keep  " else "REMOVE" end)  \(.host)  [\(.platform), \(.status)]  last seen: \(.lastSeen // "never")"'
DEL=$(echo "$AG" | jq -r '.agents[] | select(.status!="online" and .status!="attention") | .id')

echo "== Enrollment tokens"
TK=$("${C[@]}" "$URL/api/agent-tokens")
echo "$TK" | jq -r '.tokens[] | select(.revoked|not) | "  \(if (.expired or .usedUp or .uses==0 and .agents==0) then "REVOKE" else "keep  " end)  \(.name)  oat_\(.prefix)_…  used \(.uses)\(if .maxUses then "/\(.maxUses)" else "" end)\(if .expired then ", expired" else "" end)"'
REV=$(echo "$TK" | jq -r '.tokens[] | select((.revoked|not) and (.expired or .usedUp or (.uses==0 and .agents==0))) | .id')

if [ "$APPLY" -ne 1 ]; then
  echo; echo "Nothing changed. Run again with --apply to remove/revoke the lines marked above."
  exit 0
fi
for id in $DEL; do "${C[@]}" -X DELETE -o /dev/null -w "  removed agent $id (%{http_code})\n" "$URL/api/agents/$id"; done
for id in $REV; do "${C[@]}" -X DELETE -o /dev/null -w "  revoked token $id (%{http_code})\n" "$URL/api/agent-tokens/$id"; done
echo; echo "Done. Agents and Infrastructure now show only the agents online now."
echo "(Old metric history stays in Prometheus until its retention ends; it is not shown as current data.)"
