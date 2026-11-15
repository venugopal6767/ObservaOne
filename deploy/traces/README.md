# ObservaOne traces collector (VM + Kubernetes)

Deploy an OpenTelemetry Collector that receives OTLP from your apps, **selects traces by
namespace or annotation**, and forwards them to ObservaOne's Tempo endpoint — the same
model Datadog and Splunk use (apps are instrumented and **push**; the collector receives,
tags, filters and forwards). Auto-instrumentation is handled by the upstream
**OpenTelemetry Operator** (no custom webhook to maintain).

> Status: these manifests are YAML-validated. **Test on your own cluster/VM** before
> relying on them — the `filter/select` OTTL rule and image tags in particular should be
> confirmed against your environment.

## Credentials (no secrets in these files)
Create a Secret with your Tempo endpoint + ingest auth:
```
kubectl -n observaone create secret generic observaone-traces \
  --from-literal=OBSERVAONE_OTLP_TRACES=https://SERVER/otlp/v1/traces \
  --from-literal=OBSERVAONE_INGEST_AUTH="Basic $(printf 'INGEST_USER:INGEST_PASSWORD' | base64)"
```

## Kubernetes
1. `kubectl apply -f collector-k8s.yaml`  (DaemonSet collector, one per node)
2. Auto-instrumentation (optional but recommended):
   - cert-manager + OTel Operator (see `instrumentation.yaml` header), then `kubectl apply -f instrumentation.yaml`
   - **Select by namespace/annotation** — this is the "based on namespace or annotations" behaviour:
     - whole namespace: `kubectl annotate ns prod instrumentation.opentelemetry.io/inject-java=observaone/observaone`
     - one workload: annotate its pod template with the same key.
3. Apps without auto-instrumentation send OTLP to `NODE_IP:4317` / `:4318`.

### How the namespace/annotation selection works
- `k8sattributes` tags each span with `k8s.namespace.name` and the `observaone.io/traces` pod annotation.
- `filter/select` **keeps** spans whose namespace matches the allowlist (edit `^(prod|staging)$`)
  **or** that carry `observaone.io/traces: "true"`, and drops the rest. Tune to your requirement.

## VM / bare host
1. Install the collector binary (`otelcol-contrib`) and copy `collector-vm.yaml` to
   `/etc/observaone-traces/collector.yaml`.
2. Create `/etc/observaone-traces/collector.env` with `OBSERVAONE_OTLP_TRACES`,
   `OBSERVAONE_INGEST_AUTH`, `OBSERVAONE_ENV`, `OBSERVAONE_ROLE`.
3. Install `observaone-traces-collector.service`, then `systemctl enable --now observaone-traces-collector`.
4. Apps on the host send OTLP to `127.0.0.1:4317` / `:4318`. (No k8s namespace on a VM —
   traces are tagged by `deployment.environment` / `host.role` instead.)

## Files
- `collector-k8s.yaml` — namespace, RBAC, ConfigMap, DaemonSet, Service.
- `instrumentation.yaml` — OTel Operator `Instrumentation` CR + install notes.
- `collector-vm.yaml` + `observaone-traces-collector.service` — VM collector.

## Next (Phase 2)
Traces UI filtering/scoping by namespace/service/annotation (so operators see only what they
need) — built and tested in the app.
