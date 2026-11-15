#!/usr/bin/env bash
# ObservaOne PreToolUse guard — blocks secret exposure and destructive ops.
# Protocol: reads Claude Code hook JSON on stdin, emits a PreToolUse permission
# decision. "deny" blocks; silence/exit 0 = defer to normal permission flow.
# Conservative by design: only blocks clear, high-risk patterns to avoid false stops.
set -euo pipefail

input="$(cat)"

# Minimal field extraction without requiring jq.
get() { printf '%s' "$input" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1; }
tool="$(get tool_name)"
# command (Bash) or file_path (Edit/Write) — grab whichever is present
cmd="$(printf '%s' "$input" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(.*\)/\1/p' | head -1)"
path="$(get file_path)"

deny() {
  reason="$1"
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason"
  exit 0
}

# --- Protect secret/sensitive files from edits/writes ---
case "$path" in
  *".env"|*/.env|*"/nginx/certs/"*|*"/.agent-keys/"*|*".key"|*".pem"|*"id_rsa"*)
    deny "Blocked by ObservaOne guard: refusing to write secret/credential file ($path). Edit secrets manually, outside the agent." ;;
esac

# --- Block clearly destructive shell commands ---
if [ -n "${cmd:-}" ]; then
  # strip trailing JSON noise after the command value is best-effort; match on substrings
  case "$cmd" in
    *"rm -rf /"*|*"rm -rf ~"*|*"rm -rf \$HOME"*|*":(){:|:&};:"*)
      deny "Blocked by ObservaOne guard: catastrophic delete pattern detected." ;;
    *"docker compose down -v"*|*"docker volume rm"*|*"docker volume prune"*|*"docker system prune"*)
      deny "Blocked by ObservaOne guard: this destroys stack data volumes (metrics/alerts/DB). Run manually with explicit intent." ;;
    *"git push --force"*|*"git push -f"*)
      deny "Blocked by ObservaOne guard: force-push disabled. Use a normal push or a feature branch." ;;
    *"DROP TABLE"*|*"DROP DATABASE"*|*"TRUNCATE "*)
      deny "Blocked by ObservaOne guard: destructive SQL. Use a reviewed, numbered migration with explicit approval." ;;
  esac
fi

# Default: allow normal permission flow to proceed.
exit 0
