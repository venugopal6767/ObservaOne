#!/usr/bin/env bash
# Go agent: static vet + unit tests. Needs the Go toolchain (1.22+).
set -euo pipefail
cd "$(dirname "$0")/../agent/go"
echo "==> go vet ./..."
go vet ./...
echo "==> go test ./..."
go test ./... "$@"
