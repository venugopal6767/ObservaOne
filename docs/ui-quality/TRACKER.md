# UI/UX issue tracker

Priority: P1 = misleading or broken, P2 = hurts a common task, P3 = polish, P4 = cosmetic.
Status: Open · Fixed · Deferred (with the gate it waits for).

| ID | P | Page | Issue | Root cause | Fix | Status | Validation |
|---|---|---|---|---|---|---|---|
| UX-001 | P1 | Shell / every page | After a failed refresh the top bar still says "Updated just now" | `refreshNow()` marks fresh whenever the page's refresh resolves; pages swallow their own errors | Pages report failure by rejecting; freshness only moves on success | Fixed (shell + Overview); other pages at their gate | Pass — stamp stays at the last success ("updated 8s ago") |
| UX-002 | P1 | Overview | A failed refresh replaces the KPI row with an error and keeps old panels below — mixed old and missing data | `load()` clears the KPI row on error | Keep the last good data and show a stale notice with Retry | Fixed | Pass — KPIs kept, "Couldn't refresh at … showing data from …" + Try again |
| UX-003 | P1 | Overview | First-load failure shows a red line with no way to retry; the rest of the page is blank | errorBox only, no retry | Shared `errorState(message, retry, title)` | Fixed | Pass — names the cause, Try again recovers, no numbers shown |
| UX-004 | P2 | Overview | "Could not check incidents" was hidden behind "Show N more" | failed checks sorted last as `info` items | Failed checks shown as a notice line under the attention title, always visible | Fixed | Pass |
| UX-005 | P2 | Overview | Loading shows one spinner in the KPI row; the rest of the page is empty and jumps when data arrives | spinner only | Skeleton blocks in the shape of each row | Fixed | Pass — 14 placeholders |
| UX-006 | P2 | Overview | KPI row breaks 3 + 2 with a hole at 1281–1400 px (1366 is a target width) and at tablet | `repeat(3)` below 1400 px | 5 across down to 1180 px; 6-column grid (2-2-2 / 3-3) below that | Fixed | Pass — 5 across at 1366/1920, 3+2 filled at 768, 1 column at 390 |
| UX-007 | P2 | Overview | Drill-down links (KPIs, attention actions, rows) drop environment and time range from the URL | plain paths instead of `ctx.link()` | Use `ctx.link()` | Fixed | Pass — KPI, attention and row links carry range; Back/Forward keep it |
| UX-008 | P2 | Overview | Two demo markers: a solid blue "Demo Data" page button and the amber top-bar chip | page added its own button before the chip existed | Remove the page button; the chip and DEMO badges stay (rule B) | Fixed | Pass |
| UX-009 | P3 | Overview | Empty cells show "-" | ad hoc | "—" for empty cells on this page | Fixed | Pass |
| UX-010 | P2 | List pages at 390 px | Wide tables are cut at the right edge with no sign that they scroll | tables in an overflow wrapper, all columns kept | `col-phone-hide` on minor columns; long text wraps on phones (log messages, rule names, audit actions, mono values but not timestamps); minor role-dashboard columns hidden; a scroll-shadow cue on any table that still scrolls | Fixed on live pages (v1.8.3); role dashboards + Metrics scroll with a cue | Re-check found the v1.8.2 "Fixed" overstated: Logs, Alert Rules › Rules, Settings › Audit log and › API reference still overflowed (the gates only checked other tabs). All now fit. Metrics data table and role-dashboard tables (Deployments, SRE) still scroll sideways, now with a visible edge shadow |
| UX-011 | P3 | Live pages | Two loading styles (spinner vs skeleton) | two component families | Skeleton for page loads (rule B); spinners only inside small boxes | Fixed | Every gate checks its loading placeholders |
| UX-012 | P3 | Incidents, Overview, Service detail, role dashboards | Two `statusPill` helpers with separate label maps (`pages/overview.js` for incident states, `personas/widgets.js` for deploy/health states) | duplicated helper | One helper in `personas/widgets.js`; its map gained the 4 incident states; `overview.js` re-exports it so imports are unchanged | Fixed (v1.8.3) | Pass — all 21 status values render the same label and class before/after; only difference: an unknown incident status would fall back to the grey style instead of the open style, unreachable because the database allows only the 4 states |
| UX-013 | P4 | Detail pages | Page title 21 px vs 22 px on lists | per-page CSS | 22 px token | Fixed | Re-verified v1.8.3: 22 px on 20 pages (lists, details, role dashboards) |
| UX-014 | P4 | Role dashboards | Table pager "Previous" disabled on page 1 without a tooltip | standard pager | "Already on the first page" / "Already on the last page" | Fixed | Re-verified v1.8.3: tooltips present; controls audit (1,293 controls) clean |
| UX-015 | P3 | Services 390 px | "DEMO DATA" badge wraps to two lines next to the title | no `white-space: nowrap` | nowrap on the badge | Fixed (global CSS) | Pass |
| UX-016 | P2 | Shell, tablet (768 px) | Search text ran under the dashboard selector in the top bar | search input kept its intrinsic width | Input shrinks with its box | Fixed | Pass — screenshot 768 |
| UX-017 | P3 | Overview 1181–1500 px | Some KPI titles ("Total Services", "P95 Latency") wrap to two lines next to the DEMO badge | five cards plus badge in a narrow card | Accept: cards stay aligned; revisit if the badge rule changes | Accepted | — |
| UX-018 | P2 | Home | Opening Home (`/views`) left a dead refresh button and no auto-refresh | the redirect to the role dashboard re-ran the router, then the first run overwrote the page it had just opened | router ignores a render that was superseded by a newer route | Fixed | Pass — refresh and timer belong to the role dashboard |
| UX-019 | P2 | Home, role dashboards | Top bar said "Updated … ago" over generated sample data | shell treated sample pages like live ones | sample pages hide the stamp; refresh button says "Redraw the sample data" | Fixed | Pass |
| UX-020 | P2 | Home at 390 px | KPI cards three across with wrapped titles | a later desktop rule overrode the phone rule | two per row up to 760 px | Fixed | Pass — 2 per row at 390 |
| UX-021 | P1 | Services, Service detail | A failed refresh wiped the list / the whole service page, with no retry, and freshness still moved | `load()` caught and replaced content | stale notice keeps data; first-load error with Try again; rejects so freshness stays | Fixed | Pass |
| UX-022 | P2 | Services | Status filter, search and sort were lost on Back and not shareable | kept only in page variables | kept in the URL (`status`, `q`, `sort`, `dir`) | Fixed | Pass — Back returns to the filtered list |
| UX-023 | P2 | Services | Filter cards and sortable headers did not work from the keyboard | `div`/`th` with click handlers | buttons with `aria-pressed` / `aria-sort` | Fixed | Pass — Enter on card and header |
| UX-024 | P2 | Services, Service detail | Links to services, logs, traces, incidents and tabs dropped env/range | plain paths, tab URL rebuilt without filters | `ctx.link()` everywhere on these pages | Fixed | Pass — range kept through list → service → tab → trace and back |
| UX-025 | P3 | Services | A filter with no matches showed an empty table | no empty-result row | "No services match this filter" + Clear filter | Fixed | Pass |
| UX-026 | P3 | Service detail | External dependencies were links to `#` | placeholder href | plain text | Fixed | Pass |
| UX-027 | P3 | Service detail | "Incidents for this service" disappeared silently when the API failed | error swallowed | says it could not be loaded | Fixed | Pass |
| UX-028 | P1 | Infrastructure | A failed CPU, memory or disk query showed blank cells, as if the servers had no data | each metric query's error was swallowed | named notice "Some figures are unavailable…", cells show "—" | Fixed | Pass — failed memory query named |
| UX-029 | P2 | Infrastructure | The environment picked in the top bar had no effect here | page ignored `ctx.env` | servers filtered by env, with "n of m servers" and Show all environments | Fixed | Pass |
| UX-030 | P1 | Infrastructure, Incidents, Incident detail | Failed refresh wiped the page; no retry; freshness moved | same pattern as UX-021 | stale notice / error with Try again / reject on failure | Fixed | Pass |
| UX-031 | P2 | Incidents | Severity and search filters were lost on Back and not shareable | page variables only | kept in the URL; controls show the URL value | Fixed | Pass |
| UX-032 | P2 | Incident detail | Back arrow used browser history (could leave the app); tabs and links dropped env/range | `history.back()`, tab URL rebuilt without filters | back arrow → Incidents list with filters; `ctx.link()` on tabs and links | Fixed | Pass |
| UX-033 | P2 | Incident detail | A failed "Assign to me" gave no feedback; host metric charts failed silently | missing error handling | error toast; failed chart shows its error | Fixed | Pass |
| UX-034 | P3 | Kubernetes | "CPU: used vs requested" chart had no unit | label omitted | "(cores)" in the panel title | Fixed | Pass |
| UX-035 | P3 | Infrastructure | "nullnull" printed above the table when notes were empty | DOM `append(null)` | filter empty parts; sweep now flags stray null text | Fixed | Pass |
| UX-036 | P1 | Logs, Traces | A failed search or refresh emptied the results; freshness still moved | same pattern as UX-021 | stale notice keeps the lines; first failure shows the cause with Try again | Fixed | Pass |
| UX-037 | P2 | Logs | Every 30-second refresh blanked the table to a spinner, so the page flashed | `run()` always cleared the table | placeholders only for a new query; refresh updates in place | Fixed | Pass — row count unchanged during refresh |
| UX-038 | P2 | Logs, Traces | Level, service and namespace filters and the time range were not in the URL | URL rebuilt as `/logs?q=` only | `ctx.link()` with `q`, `level`, `service`, `ns` | Fixed | Pass — restored after reload |
| UX-039 | P2 | Log details, Trace detail | Back arrow used browser history; links dropped env/range | `history.back()`, plain paths | back arrow → list with filters; `ctx.link()` | Fixed | Pass |
| UX-040 | P3 | Log details | "Copy" gave no feedback and failed silently where the clipboard is blocked | no result handling | "Copied" or an explanation | Fixed | Pass |
| UX-041 | P3 | Log details | No "View Trace" button when a line has no trace ID, with no explanation | button omitted | disabled "No trace linked" with the reason | Fixed | Pass |
| UX-042 | P2 | Logs, Traces at 390 px | Tables cut at the edge | all columns kept | minor columns hidden on phones | Fixed | Pass |
| UX-043 | P1 | Metrics, Dashboards, Insights | Failed refresh wiped results; no retry; freshness moved | same pattern as UX-021 | stale notice / error with Try again / reject on failure | Fixed | Pass |
| UX-044 | P2 | Dashboard view | Every refresh replaced every panel with a spinner, and a failed panel lost its chart | panels redrawn from scratch | panels refresh in place; a failed panel keeps its chart with "Couldn't refresh" | Fixed | Pass |
| UX-045 | P2 | Dashboard view | A filter variable with no choices silently showed "(none)" | label-value errors ignored | says "no values found" or why the choices could not load | Fixed | Pass |
| UX-046 | P1 | Insights, menu | "AI" badge on statistics (trend fitting and seasonal bands) | label overstated the feature | badge removed; page says "Plain statistics on your Prometheus history" | Fixed | Pass |
| UX-047 | P2 | Metrics, Insights, Dashboards | View, unit, step, tab and sensitivity not kept in the URL | page variables only | kept in the URL with env and range | Fixed | Pass |
| UX-048 | P2 | Metrics | Example queries were `href="#"` links | anchor used as a button | buttons | Fixed | Pass |
| UX-049 | P2 | Insights | Forecast rows opened only with a mouse | `tr` with click only | focusable rows, Enter/Space, `aria-expanded` | Fixed | Pass |
| UX-050 | P3 | Dashboards | Dashboard list loaded twice on every visit | a duplicate initial call left by an earlier edit in this gate | removed | Fixed | Pass — no duplicate request |
| UX-051 | P2 | Data Sources | The top-bar refresh did nothing on this page; "Test all" could be pressed again while running | page returned no refresh | refresh re-tests every source; button disabled while testing | Fixed | Pass |
| UX-052 | P1 | Data Sources, Agents, Alert Rules | Load failure showed a red line with no retry; refresh failure wiped the page | errorBox only | error with Try again; stale notice; reject on failure | Fixed | Pass |
| UX-053 | P2 | Agents | Fleet filter, platform and tab were not kept in the URL; no way back from an empty filter | page variables only | in the URL with env/range; "Clear filter" | Fixed | Pass |
| UX-054 | P1 | Alert Rules | "New Alert Rule" looked ready but only showed an error toast when rule editing is off | button always enabled | locked with the reason (UI_RULES_FILE) when editing is off | Fixed | Pass |
| UX-055 | P3 | Alert Rules | Page title "Alerting" did not match the menu item "Alert Rules" | renamed menu, old title | title "Alert Rules" | Fixed | Pass |
| UX-056 | P2 | Alert Rules | Notify switches had no accessible name | `toggle()` put the label only on the wrapper | input gets `aria-label` from the title | Fixed | Pass |
| UX-057 | P3 | Agents | Token "Copy" failed silently when the clipboard is blocked | promise not handled | "Copied" or an explanation | Fixed | Pass |
| UX-058 | P2 | Settings | Switching tabs inside Settings left the wrong menu item highlighted (Users & Roles vs Settings) and dropped env/range | tab change only rewrote the URL | a tab change is a route change | Fixed | Pass |
| UX-059 | P2 | Shell (form pages, Log details) | Refresh button looked active but did nothing on pages with nothing to reload | button always enabled | disabled with "Nothing to refresh on this page" | Fixed | Pass |
| UX-060 | P1 | Settings sections | A failed section load showed a red line with no retry | errorBox only | error with Try again | Fixed | Pass |
| UX-061 | P2 | Users, Sessions at 390 px | Tables 80–150 px wider than the phone | all columns kept | minor columns hidden, avatars hidden, narrower role picker | Fixed | Pass |

## Gate status

| Gate | Status | Evidence |
|---|---|---|
| App shell | Passed | `shell.mjs` 32/32, controls audit clean, no console/API errors on 17 pages × 4 widths |
| Overview | Passed | `ovstates.mjs` 21/21, before/after screenshots at 390/768/1366/1920 in both themes, all regression suites green |
| Home (role landing) | Passed | `home.mjs` 20/20, screenshots at 4 widths, role-dashboard suites green |
| Services → Service detail | Passed | `services.mjs` 26/26, controls 217 clean, screenshots at 4 widths |
| Infrastructure | Passed | `infra.mjs` 14/14 (env filter checked with labelled data), screenshots at 4 widths |
| Kubernetes | Passed | `k8s.mjs` 24/24, `honesty.mjs` 15/15, two KPI cards per row at 390 |
| Incidents → Incident detail | Passed | `incidents.mjs` 19/19, controls 78 clean, screenshots at 4 widths |
| Logs → Log details | Passed | `logs.mjs` 19/19, controls clean, screenshots |
| Traces → Trace detail | Passed | `traces.mjs` 16/16, controls clean, screenshots |
| Metrics | Passed | `metrics.mjs` 11/11, controls clean |
| Dashboards → dashboard view | Passed | `dashboards.mjs` 15/15, controls clean |
| Insights | Passed | `insights.mjs` 13/13, controls clean |
| Data Sources | Passed | `datasources.mjs` 10/10, controls clean |
| Agents | Passed | `agents.mjs` 11/11, controls clean |
| Alert Rules | Passed | `alerting.mjs` 11/11, controls clean |
| Users & Roles, Settings | Passed | `settings.mjs` 14/14, controls clean |

All 19 gates pass. Final run: 16 gate scripts (267 checks), the earlier suites (230 browser + 40 API checks), controls audit 1,280+ controls with no unexplained dead control, 4-width sweep of 18 pages × 2 themes with no sideways scroll, clipped text, stray null text, console or API errors.

## Post-gate cleanup (v1.8.3)

- UX-012 fixed (one status-label helper). UX-010 corrected and fixed on all live pages. UX-013 and UX-014 re-verified. UX-017 stays accepted (no new evidence).
- Proposed for review (not done): mark the least important columns in the role-dashboard tables (Deployments, SRE SLOs, incidents, on-call) as `minor` so they fit at 390 px instead of scrolling. Touches 8 sample-data dashboards.

## Audit batch 1 (v1.8.4)

From the UI/UX audit (report: "ObservaOne UI/UX Audit and Improvement Plan (v1.8.3)"). UI-only; no server, config or Grafana infrastructure changed.

| ID | Pri | Change | Status | Evidence |
|---|---|---|---|---|
| AUD-01 | P1 | A service with 0 requests/s shows "No traffic" (neutral) instead of Down/Unhealthy on Services, Service detail, Overview and incident Related services; it is left out of Down counts and its uptime shows "No data" instead of 0%. The tooltip says idle and stopped cannot be told apart. Server status value unchanged. | Fixed (UI part) | `signals.mjs` |
| AUD-03 | P1 | An exporter that stops answering shows "NOT REPORTING" (amber) with "the host's own state is unknown" on Infrastructure; Overview says "hosts not reporting (exporter not answering)". Alert-rule wording in `host-alerts.yml` unchanged (separate approval). | Fixed (UI part) | `signals.mjs` |
| AUD-04 | P1 | Grafana button removed from built-in dashboards. | Fixed | `signals.mjs`, sweep link check |
| AUD-05 | P2 | "Open Grafana" removed from Settings › About. | Fixed | `signals.mjs` |
| AUD-06 | P2 | Top-bar dashboard selector removed. Role dashboards are listed on the Dashboards page (landing marked) and in search; Home still opens the role landing. | Fixed | `signals.mjs`, `shell.mjs`, `home.mjs` |
| AUD-13 | P2 | `gateshots.mjs` covers 390, 768, 1024, 1280, 1366, 1440 and 1920 px and fails on any link to Grafana. | Fixed | sweep: no problems at 7 widths, both themes |

Regression: 17 gate scripts all green (incl. new `signals.mjs` 20/20), controls audit 1,278 controls (15 fewer: the removed selector), 7-width sweep with no sideways scroll, clipped text, stray null text, Grafana link, console or API error.

Still open from the audit: AUD-02 (server swallows failed queries), AUD-07 (landing source), AUD-08, AUD-09 (demo incidents), AUD-10, AUD-11, AUD-12, AUD-14–18.
