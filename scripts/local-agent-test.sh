#!/usr/bin/env bash
# Local end-to-end test of the ObservaOne Linux agent on ONE machine (WSL Ubuntu or a Linux PC with Docker).
# It: points observaone.local at this machine, makes a certificate for that name, starts the stack (which
# builds the agent), creates a one-time token through the API, installs the agent on THIS machine with it,
# and runs the checks. Run from the monitoring-stack folder:
#
#   sudo bash scripts/local-agent-test.sh
#
# Needs: Docker with compose, systemd (WSL: [boot] systemd=true in /etc/wsl.conf), curl, jq.
# Re-running is safe. Remove the agent afterwards with: sudo observaone-agent ... see the last lines.
set -euo pipefail
cd "$(dirname "$0")/.."
NAME="${OO_NAME:-observaone.local}"
NEWCERT=0
say() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run with sudo."
for c in docker curl jq openssl; do command -v $c >/dev/null || die "'$c' is needed (sudo apt-get install -y $c)."; done
docker compose version >/dev/null 2>&1 || die "Docker compose plugin is needed."
[ -d /run/systemd/system ] || die "systemd is not running. WSL: add '[boot]\nsystemd=true' to /etc/wsl.conf, run 'wsl --shutdown' in Windows, reopen Ubuntu."
[ -f .env ] || die ".env not found in $(pwd). Copy .env.example to .env and set the passwords first."

say "1/6  $NAME -> this machine"
grep -qE "^[0-9.]+[[:space:]]+$NAME\$" /etc/hosts || echo "127.0.0.1 $NAME" >> /etc/hosts
getent hosts "$NAME"

say "2/6  SERVER_NAME=$NAME in .env (+ certificate for that name)"
if grep -q '^SERVER_NAME=' .env; then sed -i "s/^SERVER_NAME=.*/SERVER_NAME=$NAME/" .env; else echo "SERVER_NAME=$NAME" >> .env; fi
# remove a PUBLIC_URL that points elsewhere (the agent install command uses it)
sed -i 's|^PUBLIC_URL=.*|# &  (disabled by local-agent-test.sh)|' .env
if [ -s nginx/certs/server.crt ] && ! openssl x509 -in nginx/certs/server.crt -noout -ext subjectAltName 2>/dev/null | grep -q "DNS:$NAME"; then
  echo "existing certificate is not for $NAME: making a new one"
  rm -f nginx/certs/server.crt nginx/certs/server.key
  NEWCERT=1
fi

say "3/6  starting the stack (first time: builds the agent, ~1-3 min)"
docker compose up -d --build
# The UI container mounts the certificate as a single file: after the file is replaced it still sees the OLD one
# (and shows an old fingerprint in the install command). Recreate it so it reads the new certificate.
docker compose up -d --force-recreate observa nginx
for i in $(seq 1 90); do
  curl -fsS --cacert nginx/certs/server.crt "https://$NAME/api/health" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS --cacert nginx/certs/server.crt "https://$NAME/api/health" >/dev/null || die "ObservaOne is not answering on https://$NAME (docker compose ps; docker compose logs nginx observa)"
curl -fsS --cacert nginx/certs/server.crt "https://$NAME/agent/files/SHA256SUMS" || die "Agent binaries missing: docker compose logs agent-build"

say "4/6  one-time enrollment token (via the API, as the admin user)"
ADMIN_USER=$(sed -n 's/^UI_ADMIN_USER=//p' .env); ADMIN_USER=${ADMIN_USER:-admin}
ADMIN_PW=$(sed -n 's/^UI_ADMIN_PASSWORD=//p' .env | sed "s/^['\"]//; s/['\"]$//")
[ -n "$ADMIN_PW" ] || die "UI_ADMIN_PASSWORD not found in .env"
JAR=$(mktemp); TOK=$(mktemp); chmod 600 "$TOK"; trap 'rm -f "$JAR" "$TOK"' EXIT
CODE=$(jq -n --arg u "$ADMIN_USER" --arg p "$ADMIN_PW" '{username:$u,password:$p}' | curl -s --cacert nginx/certs/server.crt -c "$JAR" \
  -H 'X-Requested-With: observa' -H 'Content-Type: application/json' -d @- -o /dev/null -w '%{http_code}' "https://$NAME/api/login")
[ "$CODE" = 200 ] || die "Admin sign-in failed (HTTP $CODE). Was the admin password changed in the UI? Create a token on the Agents page and run: sudo bash observaone-install.sh --server https://$NAME --token-file FILE"
curl -s --cacert nginx/certs/server.crt -b "$JAR" -H 'X-Requested-With: observa' -H 'Content-Type: application/json' \
  -d '{"name":"local test","maxUses":1,"expiresDays":1}' "https://$NAME/api/agent-tokens" | jq -r .token > "$TOK"
grep -q '^oat_' "$TOK" || die "Could not create a token (is the Agents module on? Settings > Modules)"
echo "token created (one-time, valid 1 day)"

say "5/6  installing the agent on this machine"
FP=$(openssl x509 -in nginx/certs/server.crt -outform DER | sha256sum | cut -d' ' -f1)
curl -fsSL --cacert nginx/certs/server.crt "https://$NAME/agent/install.sh" -o /tmp/observaone-install.sh
bash /tmp/observaone-install.sh --server "https://$NAME" --ca-sha256 "$FP" --env local --role test --token-file "$TOK"

say "6/6  checks"
bash agent/test/vm-check.sh || true
echo
echo "Open https://$NAME (accept the self-signed certificate) -> Agents -> Linux: $(hostname -s) should be Online."
echo "Infrastructure shows it once, with CPU / memory / disk."
echo "Remove the agent later:  sudo bash /tmp/observaone-install.sh --uninstall"
