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
exec su-exec node node /app/src/server.js
