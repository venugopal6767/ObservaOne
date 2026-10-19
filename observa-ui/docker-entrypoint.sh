#!/bin/sh
# Make sure the app user can write its data and the UI alert-rules file, then run as that user.
set -e
chown -R node:node /data 2>/dev/null || true
if [ -n "${UI_RULES_FILE:-}" ]; then
  dir=$(dirname "$UI_RULES_FILE")
  mkdir -p "$dir"
  [ -f "$UI_RULES_FILE" ] || printf 'groups: []\n' > "$UI_RULES_FILE"
  chown node:node "$dir" "$UI_RULES_FILE"
  chmod 755 "$dir"
  chmod 644 "$UI_RULES_FILE"   # Prometheus (another user) must be able to read it
fi
# Notification channels: Alertmanager's config, written by the app. Folder group 65534 (Alertmanager's user "nobody"),
# setgid: every file written there is readable by Alertmanager and nobody else (it holds channel secrets).
# First start: a copy of the base file, so Alertmanager can start before the app.
if [ -n "${AM_CONFIG_FILE:-}" ]; then
  dir=$(dirname "$AM_CONFIG_FILE")
  mkdir -p "$dir"
  chown node:65534 "$dir"
  chmod 2750 "$dir"
  if [ ! -s "$AM_CONFIG_FILE" ] && [ -f "${AM_BASE_CONFIG:-}" ]; then cp "$AM_BASE_CONFIG" "$AM_CONFIG_FILE"; fi
  [ -f "$AM_CONFIG_FILE" ] && chown node:65534 "$AM_CONFIG_FILE" && chmod 640 "$AM_CONFIG_FILE"
fi
# Pull mode: the folder shared with Prometheus (user nobody, 65534). setgid group 65534: every file the app writes
# there later (renewals) can be read by Prometheus without being world-readable.
if [ -n "${AGENT_PROMETHEUS_DIR:-}" ]; then
  mkdir -p "$AGENT_PROMETHEUS_DIR"
  chown node:65534 "$AGENT_PROMETHEUS_DIR"
  chmod 2750 "$AGENT_PROMETHEUS_DIR"
  find "$AGENT_PROMETHEUS_DIR" -type f -exec chown node:65534 {} + 2>/dev/null || true
fi
# "pki-init": create the agent CA + Prometheus files and exit (runs before Prometheus starts, which needs them)
if [ "${1:-}" = "pki-init" ]; then
  exec su-exec node node /app/src/agentpki.js
fi
exec su-exec node node /app/src/server.js
