#!/bin/sh
# Creates the Grafana "operator" (Editor) and "viewer" (Viewer) logins.
# Safe to run again: existing users only get their role re-applied
# (their password is NOT changed - change it in Grafana or with the admin API).
set -eu

URL="${GRAFANA_URL:-http://grafana:3000}"
AUTH="${GRAFANA_ADMIN_USER}:${GRAFANA_ADMIN_PASSWORD}"

api() { # method path [json-body]
  if [ $# -ge 3 ]; then
    curl -sS -u "$AUTH" -H "Content-Type: application/json" -X "$1" "${URL}$2" -d "$3" -w '\n%{http_code}'
  else
    curl -sS -u "$AUTH" -X "$1" "${URL}$2" -w '\n%{http_code}'
  fi
}

# Wait until Grafana accepts the admin login (max ~2 minutes)
i=0
until [ "$(curl -s -o /dev/null -w '%{http_code}' -u "$AUTH" "${URL}/api/org")" = "200" ]; do
  i=$((i+1))
  if [ "$i" -gt 60 ]; then
    echo "grafana-users: cannot log in to Grafana as ${GRAFANA_ADMIN_USER}."
    echo "  If Grafana was started before with another admin password, the .env value is ignored."
    echo "  Fix: use the old password in .env, or reset it (see README, 'Forgot the admin password')."
    exit 1
  fi
  sleep 2
done

ensure_user() { # login password role
  login="$1"; pass="$2"; role="$3"
  body=$(printf '{"name":"%s","login":"%s","email":"%s@localhost","password":"%s","OrgId":1}' "$login" "$login" "$login" "$pass")
  out=$(api POST /api/admin/users "$body")
  code=$(echo "$out" | tail -n1)
  if [ "$code" = "200" ]; then
    id=$(echo "$out" | head -n1 | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
    echo "grafana-users: created '${login}'"
  else
    out=$(api GET "/api/users/lookup?loginOrEmail=${login}")
    code2=$(echo "$out" | tail -n1)
    if [ "$code2" != "200" ]; then
      echo "grafana-users: could not create '${login}' (HTTP ${code}): $(echo "$out" | head -n1)"
      echo "  Hint: Grafana's password policy needs 12+ chars with upper, lower, number and symbol."
      return 1
    fi
    id=$(echo "$out" | head -n1 | sed -n 's/^{"id":\([0-9]*\).*/\1/p')
    echo "grafana-users: '${login}' already exists"
  fi
  out=$(api PATCH "/api/org/users/${id}" "{\"role\":\"${role}\"}")
  echo "grafana-users: '${login}' role = ${role} (HTTP $(echo "$out" | tail -n1))"
}

rc=0
ensure_user "$GRAFANA_OPERATOR_USER" "$GRAFANA_OPERATOR_PASSWORD" "Editor" || rc=1
ensure_user "$GRAFANA_VIEWER_USER"   "$GRAFANA_VIEWER_PASSWORD"   "Viewer" || rc=1
exit $rc
