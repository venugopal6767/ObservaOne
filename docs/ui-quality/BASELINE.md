# UI/UX quality gate — baseline and rules

Baseline code: git tag `ui-baseline-1.8` (v1.8.0, commit be20779).
Baseline screenshots: 390 × 844, 768 × 1024 (tablet), 1366 × 768, 1920 × 1080; dark theme for 17 pages, light theme for Overview, Service and Incident.
Automated checks at baseline: no horizontal page scroll, no clipped text, no console errors, no failed API calls (80 page loads).

## A. Component inventory

Two component families exist. Live pages use `ui.js`; role dashboards use `personas/widgets.js`. New work reuses these; nothing new is added unless both lack it.

| Component | Where it lives | Used by | Notes |
|---|---|---|---|
| App shell, menu, top bar, search, help | `app.js`, `pages/registry.js` | every page | grouped menu, collapse, phone drawer, auto-refresh, freshness |
| Page header | `.page-head` markup | 13 live pages | Overview, list pages; detail pages add a back button |
| Role dashboard header + freshness | `personaHead()` (widgets) | 8 role dashboards | "Sample data drawn … ago" |
| Breadcrumbs | `breadcrumbs()` (widgets) | role dashboard detail pages | keeps env and range |
| KPI card | Overview's own `kpi()`; `kpiCard()` (widgets); service `card()` | Overview; role dashboards; Service, Insights | three variants, same `.kpi` base class |
| Chart container | `.panel` + `timeChart` / `sparkline` / `doughnut` (ui.js); `lineDrill`, `stackedBars`, `barCats`, `donut` (widgets) | all chart pages | Chart.js 4.5.1 |
| Table | hand-built `table.tbl` (live pages); `table()` with sort, search, pages (widgets) | 15 live pages; 8 role dashboards | live tables have no shared sort/paging helper |
| Filters | `select()` (ui.js), `.persona-filters` | most pages | |
| Tabs | `tabs()` (ui.js) | Services, Incidents, Logs, Traces, Metrics, Insights, Agents, Settings | |
| Status badges | `statusPill`, `sevPill`, `levelPill` (overview.js); `statusPill` (widgets) | 10 files | two `statusPill` functions with different maps |
| Attention strip | `attentionStrip()` (widgets) | Overview + 8 role dashboards | |
| Notifications | bell menu, `toast()` | shell; 17 files | |
| Dialogs | `modal()`, `confirmBox()` (ui.js) | 12 files | Escape closes, focus moves to the first input |
| Forms | `field()` (ui.js, label wraps the input) | Settings, dialogs | |
| Loading | `spinner()` (live pages); `loadingSkeleton()` (widgets) | live pages; role dashboards | two loading styles |
| Empty | `emptyState()` (ui.js); `.state-box` (widgets) | most pages | |
| Error | `errorBox()` (ui.js); `errorState(retry)` (widgets) | most pages | only the widgets version offers a retry |
| Demo / sample marker | `demoBadge()` (DEMO), `.demo-btn` (Overview "Demo Data" button), `.live-chip.demo` (top bar), `.sample-banner` (role dashboards) | 6 files | four different markers |
| Stale data | — | — | **missing**: a failed refresh is not distinguished from fresh data |
| Locked action | `notConnected()`, `quickActions({unavailable})` (widgets) | 8 role dashboards | |

## B. Visual consistency (measured at 1366 px)

| Property | Values found | Rule from now on |
|---|---|---|
| Page title (h1) | 22 px lists, 21 px detail pages | 22 px everywhere (`--fs-title`) |
| Panel title (h3) | 13.5 px | keep |
| KPI value | 28 px Overview, 24 px role dashboards, 22 px Service/Insights stat cards | 28 px hero KPIs on Overview, 24 px KPI cards, 22 px compact stat cards — three named sizes, not ad hoc |
| Panel radius / padding | 10 px / 14 px | keep (`--radius`) |
| Table header / cell | 12 px / 12–13 px | header 12 px, cell 13 px, monospace cells 12 px |
| Status pill | 11 px (one 10.5 px on Users) | 11 px |
| Button height | 28 px inline, 34 px page actions, 40 px query-bar submit | keep these three: inline 28, page action 34, matches an input 40 |
| Demo marker | four styles | one rule: top-bar chip = some source is in demo mode; DEMO badge = this number/panel is sample data; Sample-data banner = the whole page is sample data. No other marker. |
| Loading | spinner or skeleton | skeleton for page loads, spinner only inside buttons/small panels |
| Missing value | `-`, `N/A`, `No data`, `—` | KPI: "N/A" + reason in the foot; table cell: "—"; chart: "No data" |

Semantic tokens added in v1.8: `--success --warning --danger --info --focus-ring --space-1…5`.

## C. Interaction audit

1,284 visible controls on 24 pages were checked automatically (`test/controls.mjs`): each must have a handler, a real link, be a form field, or be disabled/locked with a reason.

- Result at baseline: no dead controls. Profile inputs are read by their Save buttons (expected). The table pager's "Previous" is disabled on page 1 without a tooltip (minor).
- Locked actions on role dashboards explain what is missing and change nothing (`test/honesty.mjs`).

## D. Data states

| State | Rule |
|---|---|
| Loading | skeleton in the shape of the content |
| Live | plain numbers, freshness in the top bar |
| Demo / sample | marker per the rule above |
| No data | "No data" / empty state that says why when known |
| Stale | last good data stays, with "Couldn't refresh at HH:MM — showing data from HH:MM" and a retry; freshness is not reset |
| Source unavailable | names the source; "Could not check …" in attention lists |
| Query / API error | error message with Retry; never sample data in its place |

Server side: sample data is used only when a source is not configured (`mode: demo`), and every response carries `demo: true`, which the UI turns into a DEMO badge.

## E. Investigation context

Environment and time range live in the session and in the URL (`link()`); Back and Forward replay the URL. Pages that build links without `link()` keep the context in the session but not in a shared URL.

## Gate order

Follows the left menu, top to bottom: Home, Overview, Services (+ Service detail), Infrastructure, Kubernetes, Incidents (+ detail), Logs, Traces, Metrics, Dashboards, Insights, Data Sources, Agents, Alert Rules, Users & Roles, Settings. The app shell is gated first because every page depends on it.

A page is done when its hierarchy, responsive layout (390 / 768 / 1366 / 1920), interactions, data states, context and existing tests pass. The next page does not start until then.
