# Custom auto-instrumentation operator (Phase 3) — SCAFFOLD

An ObservaOne-branded alternative to the upstream OpenTelemetry Operator: a
`ObservaInstrumentation` CRD + a mutating admission webhook that injects OTel env
into pods annotated `observaone.io/traces: "true"`.

## ⚠️ Status — read this
- The manifests (`crd.yaml`, `webhook.yaml`) are **YAML-validated**.
- `main.go` is a **scaffold that has NOT been compiled or tested** (no Go toolchain or
  cluster in the build environment). Treat it as a starting point, not a finished operator.
- **Recommendation stands:** unless you specifically need a branded CRD / full control,
  use the upstream **OpenTelemetry Operator** (`../instrumentation.yaml`) — it's mature,
  maintained, and does exactly this. This folder exists because all phases were requested.

## Build & deploy (on a machine with Go + Docker + a cluster)
1. `cd deploy/traces/operator && go mod tidy && CGO_ENABLED=0 go build -o webhook .`
2. Build/push an image (add a Dockerfile), set it in `webhook.yaml` (`REGISTRY/...`).
3. `kubectl apply -f https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml`
4. `kubectl apply -f crd.yaml -f webhook.yaml`
5. Annotate workloads: `observaone.io/traces: "true"` on the pod template.

## Before production (TODOs in main.go)
- Resolve the matching `ObservaInstrumentation` CR (language/endpoint/sampler) instead of
  hardcoded env; add initContainer-based SDK injection per language.
- Idempotency (don't double-inject), healthz/metrics, cert reload, unit + e2e tests on a cluster.
