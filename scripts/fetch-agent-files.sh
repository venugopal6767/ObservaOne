#!/usr/bin/env bash
# Downloads the ObservaOne Agent binaries once into agent/files/, so servers without internet can
# install the agent from https://SERVER/agent/files/. Run on the monitoring server (needs internet once):
#   ./scripts/fetch-agent-files.sh
# Every file is checked against the same SHA-256 the installers use.
set -euo pipefail
cd "$(dirname "$0")/../agent"
mkdir -p files
GH=https://github.com
OTEL=0.162.0 NE=1.12.1 WE=0.31.8
while read -r sha file url; do
  [ -n "$sha" ] || continue
  if [ -s "files/$file" ] && [ "$(sha256sum "files/$file" | cut -d' ' -f1)" = "$sha" ]; then
    echo "ok       $file"; continue
  fi
  echo "download $file"
  curl -fSL --retry 3 -o "files/$file.part" "$url"
  got="$(sha256sum "files/$file.part" | cut -d' ' -f1)"
  if [ "$got" != "$sha" ]; then rm -f "files/$file.part"; echo "CHECKSUM MISMATCH for $file (got $got) - not kept" >&2; exit 1; fi
  mv "files/$file.part" "files/$file"
done <<EOF
fcc063749f730f8c21fe29f2d340ff174f5f1c5885bd3156fb6c985a3036fcc3 otelcol-contrib_${OTEL}_linux_amd64.tar.gz $GH/open-telemetry/opentelemetry-collector-releases/releases/download/v${OTEL}/otelcol-contrib_${OTEL}_linux_amd64.tar.gz
ecf6a917e2b53beb1703b19a84bc4e112a2fcaba549639cf6b0ba58446bfd7d2 otelcol-contrib_${OTEL}_linux_arm64.tar.gz $GH/open-telemetry/opentelemetry-collector-releases/releases/download/v${OTEL}/otelcol-contrib_${OTEL}_linux_arm64.tar.gz
b371829181e89947a1a6570b8b6c38c20d85e2d215b76bf042f89b365b9e5c3d otelcol-contrib_${OTEL}_windows_amd64.tar.gz $GH/open-telemetry/opentelemetry-collector-releases/releases/download/v${OTEL}/otelcol-contrib_${OTEL}_windows_amd64.tar.gz
b51d8a76aa2a9156a55d501aca6276fae09e262259a5e4e831d2c2222f084e63 node_exporter-${NE}.linux-amd64.tar.gz $GH/prometheus/node_exporter/releases/download/v${NE}/node_exporter-${NE}.linux-amd64.tar.gz
ad35b605f9954b9f1ffddf5ba054bdc5a98d790b9eae5291e1eeb83f1ecbd0e7 node_exporter-${NE}.linux-arm64.tar.gz $GH/prometheus/node_exporter/releases/download/v${NE}/node_exporter-${NE}.linux-arm64.tar.gz
0aadce6afb20182b678bfca9e8f2e8464ef48c469b28b4cf02e99d82158f5d40 windows_exporter-${WE}-amd64.msi $GH/prometheus-community/windows_exporter/releases/download/v${WE}/windows_exporter-${WE}-amd64.msi
EOF
echo
echo "Done. Agents now download from https://<server>/agent/files/ (about $(du -sh files | cut -f1))."
echo "Container images (Docker/Kubernetes agents) still come from Docker Hub, quay.io, ghcr.io and registry.k8s.io;"
echo "copy them to your internal registry if those hosts have no internet."
