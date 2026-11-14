#!/usr/bin/env bash
# Validate the Docker Compose stack locally. Non-destructive: no up/build/down.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
if ! command -v docker >/dev/null 2>&1; then
  echo "docker not installed on this machine — cannot validate the stack here."; exit 1
fi
echo "==> docker compose config (syntax + interpolation)"
if docker compose config -q; then echo "   compose config OK"; else echo "   compose config FAILED"; exit 1; fi
echo "==> services defined:"; docker compose config --services | sed 's/^/   - /'
echo "==> current status (docker compose ps):"; docker compose ps || true
echo
echo "Note: service health endpoints depend on your published ports/nginx."
echo "If the stack is up, check readiness via the UI (https://observaone.local) or"
echo "'docker compose ps' health column. This script never starts/stops/destroys anything."
