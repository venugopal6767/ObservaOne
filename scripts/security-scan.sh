#!/usr/bin/env bash
# Local application security scan for ObservaOne. No CI, no deploy, read-only.
# Degrades gracefully: optional tools that are absent are skipped, not failed.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
rc=0
section(){ echo; echo "===== $* ====="; }

section "npm audit — server (observa-ui)"
( cd observa-ui && npm audit --audit-level=high ) || rc=1
section "npm audit — web (observa-ui/web)"
( cd observa-ui/web && npm audit --audit-level=high ) || rc=1

section "govulncheck — Go agent"
if command -v govulncheck >/dev/null 2>&1; then
  ( cd agent/go && govulncheck ./... ) || rc=1
else
  echo "skip: govulncheck not installed  (go install golang.org/x/vuln/cmd/govulncheck@latest)"
fi

section "semgrep — static analysis (JS/TS/Node/Go)"
if command -v semgrep >/dev/null 2>&1; then
  semgrep scan --error \
    --config p/javascript --config p/typescript --config p/nodejs --config p/golang \
    --exclude node_modules --exclude dist --exclude web/dist . || rc=1
else
  echo "skip: semgrep not installed  (pipx install semgrep)"
fi

echo; echo "===== security-scan complete (rc=$rc) ====="
echo "Tip: the Trail of Bits skills (.claude/skills) guide deeper review with these tools."
exit $rc
