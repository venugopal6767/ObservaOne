#!/bin/sh
# Builds the ObservaOne Go agent for Linux amd64 + arm64 into agent/files/, with SHA256SUMS.
# Nginx serves agent/files/ at https://SERVER/agent/files/ for the installer.
#   Run directly (needs Go 1.22+):   ./scripts/build-agent.sh
#   Or let Docker Compose do it:     the agent-build service runs this on "docker compose up"
set -eu
cd "$(dirname "$0")/../agent/go"
OUT=../files
VERSION="${AGENT_VERSION:-$(sed -n 's/^var version = "\(.*\)"/\1/p' cmd/observaone-agent/main.go)}"
mkdir -p "$OUT"
for arch in amd64 arm64; do
  echo "building observaone-agent $VERSION linux/$arch"
  CGO_ENABLED=0 GOOS=linux GOARCH=$arch GOFLAGS=-mod=mod go build -trimpath \
    -ldflags "-s -w -X main.version=$VERSION" -o "$OUT/observaone-agent-linux-$arch.tmp" ./cmd/observaone-agent
  mv -f "$OUT/observaone-agent-linux-$arch.tmp" "$OUT/observaone-agent-linux-$arch"
done
cd "$OUT"
sha256sum observaone-agent-linux-amd64 observaone-agent-linux-arm64 > SHA256SUMS
cat SHA256SUMS
# sign SHA256SUMS with the release key (created on first build, never served): installers pin the
# public key on first install, and the updater refuses any later download whose signature does not match it
cd ../go   # (we are in agent/files)
# the key is OUTSIDE agent/ (Nginx serves that folder): a Docker volume in compose, .agent-keys/ for manual builds
GOFLAGS=-mod=mod go run ./cmd/release-sign -key "${RELEASE_KEY:-../../.agent-keys/release-signing.key}" -pub ../files/release.pub -sign ../files/SHA256SUMS
