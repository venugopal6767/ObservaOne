#!/bin/sh
# Creates the logins (bcrypt hashes) that protect /prometheus/, /alertmanager/ and the log/trace ingest paths.
# Runs at every start, so changing WEB_ADMIN_PASSWORD in .env takes effect on
# the next "docker compose up -d".
set -eu
: "${WEB_ADMIN_USER:?WEB_ADMIN_USER is empty}"
: "${WEB_ADMIN_PASSWORD:?WEB_ADMIN_PASSWORD is empty}"

htpasswd -nbB -C 12 "$WEB_ADMIN_USER" "$WEB_ADMIN_PASSWORD" > /auth/htpasswd.tmp
mv /auth/htpasswd.tmp /auth/htpasswd
chmod 644 /auth/htpasswd
echo "auth-init: login for /prometheus and /alertmanager set for user '${WEB_ADMIN_USER}'"

# Login that log/trace shippers (Grafana Alloy, OpenTelemetry Collector) use to push data.
# Low bcrypt cost on purpose: Nginx checks it on every push request (machine password, make it long).
: "${INGEST_USER:?INGEST_USER is empty}"
: "${INGEST_PASSWORD:?INGEST_PASSWORD is empty}"
htpasswd -nbB -C 5 "$INGEST_USER" "$INGEST_PASSWORD" > /auth/ingest.tmp
mv /auth/ingest.tmp /auth/ingest.htpasswd
chmod 644 /auth/ingest.htpasswd
echo "auth-init: login for log/trace ingest set for user '${INGEST_USER}'"
