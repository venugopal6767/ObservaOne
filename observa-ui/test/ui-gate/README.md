# UI quality-gate checks

Browser checks used by the UI/UX quality gate (see `docs/ui-quality/`). They run against a running ObservaOne.

```bash
npm i --no-save playwright && npx playwright install chromium
export BASE=https://observa.example.local ADMIN_USER=admin ADMIN_PASS='…'   # defaults: http://127.0.0.1:8088, admin
node test/ui-gate/shell.mjs       # menu, collapse, phone drawer, auto-refresh, freshness, help, search, focus ring
node test/ui-gate/ovstates.mjs    # Overview: loading, live, stale, error + retry, partial failures, context, Back/Forward
node test/ui-gate/honesty.mjs     # sample-data banners and locked actions on role dashboards
node test/ui-gate/controls.mjs    # every visible control has a handler, a link, or a reason it is disabled
node test/ui-gate/signals.mjs     # idle service = No traffic, exporter failure = Not reporting, no Grafana links, no top-bar selector
OUT=after node test/ui-gate/gateshots.mjs   # screenshots at 390 / 768 / 1024 / 1280 / 1366 / 1440 / 1920 + scroll, clipping, Grafana links, console and API errors (WIDTHS=1024,1440 to limit)
```

Screenshots go to `OUT_DIR` (default `./ui-gate-out`). `ovstates.mjs` fakes failures in the browser only; nothing on the server changes.
