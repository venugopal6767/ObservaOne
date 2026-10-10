// Building blocks shared by every role dashboard: header with dashboard selector, filter bar,
// clickable KPI cards, chart panels with drill-down, tables, quick actions and the loading / empty / error states.
import { h, clear, icon, sparkline, emptyState, toast, timeChart, baseOptions, hexA, PALETTE, legendRow, doughnut, fmt } from '../ui.js';
import { setLanding, isLanding } from './registry.js';

// ---------- header: title, "updated ... ago", "make this my landing dashboard" ----------
let freshAt = 0;
let freshTimer = null;
function freshText() {
  if (!freshAt) return 'Loading…';
  const s = Math.round((Date.now() - freshAt) / 1000);
  return `Sample data drawn ${s < 5 ? "just now" : s < 60 ? `${s}s ago` : `${Math.floor(s / 60)} min ago`}`;
}
// call after a dashboard has drawn new data
export function stampFresh() {
  freshAt = Date.now();
  document.querySelectorAll('.fresh-text').forEach((el) => { el.textContent = freshText(); });
}

export function personaHead(ctx, persona, { subtitle, actions = [] } = {}) {
  const landing = isLanding(ctx.me, persona.id);
  const pin = h('button', { class: `btn btn-sm ${landing ? 'pinned' : ''}`, title: 'Open this dashboard after sign-in', onclick: () => {
    setLanding(ctx.me.user.username, persona.id);
    pin.classList.add('pinned');
    clear(pin).append(icon('home', 13), 'My landing dashboard');
    toast(`${persona.label} is now your landing dashboard`);
  } }, icon('home', 13), landing ? 'My landing dashboard' : 'Set as landing');
  freshAt = 0;
  clearInterval(freshTimer);
  const fresh = h('span', { class: 'fresh', title: 'This dashboard reloads its data every 30 seconds' }, h('i', { class: 'live-dot' }), h('span', { class: 'fresh-text' }, freshText()));
  freshTimer = setInterval(() => {
    if (!document.body.contains(fresh)) { clearInterval(freshTimer); return; }
    fresh.querySelector('.fresh-text').textContent = freshText();
  }, 5000);
  return h('div', { class: 'page-head persona-head' },
    h('div', {},
      h('div', { class: 'persona-kicker' }, icon(persona.icon, 14), persona.label),
      h('h1', {}, subtitle || persona.title || persona.label),
      h('p', {}, persona.desc, ' ', fresh)),
    h('div', { class: 'actions' }, ...actions, pin));
}

// ---------- "needs your attention": at most 3 things, worst first, each with one action ----------
// items: [{ level: 'critical' | 'warning', text, detail?, action: { label, href } | { label, onclick } }]
export function attentionStrip(items) {
  const order = { critical: 0, warning: 1, info: 2 };
  const list = items.filter(Boolean).sort((a, b) => order[a.level] - order[b.level]);
  if (!list.length) {
    return h('div', { class: 'attn attn-clear', role: 'status' }, icon('check', 15), h('span', {}, h('b', {}, 'All clear.'), ' Nothing here needs your attention right now.'));
  }
  const shown = list.slice(0, 3);
  return h('section', { class: 'attn', 'aria-label': 'Needs your attention' },
    h('div', { class: 'attn-title' }, icon('alert', 14), 'Needs your attention', list.length > 3 ? h('button', { class: 'linkish attn-more', 'aria-expanded': 'false', onclick: (e) => {
      // show the rest in place; nothing is hidden for good
      const box = e.currentTarget.closest('.attn').querySelector('.attn-items');
      clear(box).append(...list.map(attnItem));
      e.currentTarget.remove();
    } }, `Show ${list.length - 3} more`) : null),
    h('div', { class: 'attn-items' }, shown.map(attnItem)));
}
function attnItem(x) {
  return h('div', { class: `attn-item lv-${x.level}` },
      h('div', { class: 'attn-text' }, h('b', {}, x.text), x.detail ? h('span', { class: 'dim' }, x.detail) : null),
      x.action.href
        ? h('a', { class: 'btn btn-sm', href: x.action.href, 'data-link': true }, x.action.label, icon('arrowRight', 12))
        : h('button', { class: 'btn btn-sm', onclick: x.action.onclick }, x.action.label, icon('arrowRight', 12)));
}

// ---------- breadcrumbs: built from the URL, keep the global filters ----------
const CRUMB_NAMES = {
  deployments: 'Deployments', pipelines: 'Pipelines', clusters: 'Clusters', services: 'Services', endpoints: 'Endpoints', errors: 'Errors', traces: 'Traces',
  incidents: 'Incidents', postmortem: 'Postmortem', slos: 'SLOs', issues: 'Problems', report: 'Monthly report', apps: 'Applications', releases: 'Releases',
  events: 'Detections', hosts: 'Hosts', ips: 'Addresses', agents: 'Agents', components: 'Components', ingestion: 'Data in',
};
const LIST_PAGES = new Set(['devops/deployments', 'sre/incidents', 'security/events', 'itadmin/ingestion']);
let crumbCtx = null;
export function setCrumbContext(ctx, personaLabel) { crumbCtx = { ctx, personaLabel }; }
function breadcrumbs(current) {
  if (!crumbCtx) return null;
  const { ctx, personaLabel } = crumbCtx;
  const parts = location.pathname.split('/').filter(Boolean); // views, persona, section, id, (sub)
  if (parts[0] !== 'views' || parts.length < 3) return null;
  const persona = parts[1];
  const keep = Object.fromEntries([...ctx.params.entries()].filter(([k]) => !['tab', 'mock', 'day', 'status', 'week', 'from', 'to', 'month', 'svc'].includes(k)));
  const items = [[personaLabel, ctx.link(`/views/${persona}`, keep)]];
  // Kubernetes pages: Kubernetes › cluster › namespace › current
  if (persona === 'kubernetes') {
    const [, , section, cluster, ns] = parts;
    const cl = section === 'nodes' ? cluster.replace(/-node-\d+$/, '') : cluster;
    items.push([cl, ctx.link('/views/kubernetes', { ...keep, cluster: cl })]);
    if (section !== 'nodes' && section !== 'namespaces' && ns) items.push([ns, ctx.link(`/views/kubernetes/namespaces/${cl}/${ns}`, keep)]);
    return h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' },
      ...items.flatMap(([label, href]) => [h('a', { href, 'data-link': true }, label), h('i', {}, '›')]),
      h('span', { class: 'cur', 'aria-current': 'page' }, current));
  }
  const section = parts[2];
  if (parts.length > 3 || !LIST_PAGES.has(`${persona}/${section}`)) {
    items.push([CRUMB_NAMES[section] || section, LIST_PAGES.has(`${persona}/${section}`) ? ctx.link(`/views/${persona}/${section}`, keep) : null]);
  }
  if (parts.length > 4) items.push([decodeURIComponent(parts[3]), ctx.link(`/views/${persona}/${section}/${parts[3]}`, keep)]);
  return h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' },
    ...items.flatMap(([label, href]) => [href ? h('a', { href, 'data-link': true }, label) : h('span', {}, label), h('i', {}, '›')]),
    h('span', { class: 'cur', 'aria-current': 'page' }, current));
}

// ---------- filters kept in the URL so links and Back keep them ----------
// defs: [{ key: 'cluster', label: 'All clusters', options: [['prod-eu-1','prod-eu-1'], ...] }]
export function filterBar(ctx, defs, values, onChange) {
  const bar = h('div', { class: 'toolbar persona-filters' }, icon('list', 14, 'dim'));
  for (const d of defs) {
    const s = h('select', { class: 'select select-sm', 'aria-label': d.label, onchange: (e) => {
      values[d.key] = e.target.value;
      const url = ctx.link(location.pathname, values);
      history.replaceState({}, '', url);
      onChange();
    } }, [['', d.label], ...d.options].map(([v, l]) => h('option', { value: v, selected: (values[d.key] || '') === v }, l)));
    bar.append(s);
  }
  const active = defs.some((d) => values[d.key]);
  if (active) {
    bar.append(h('button', { class: 'btn btn-sm', onclick: () => {
      defs.forEach((d) => { values[d.key] = ''; });
      history.replaceState({}, '', ctx.link(location.pathname, values));
      onChange();
    } }, icon('x', 12), 'Clear filters'));
  }
  return bar;
}

// ---------- KPI card (whole card is a link) ----------
export function kpiCard(setChart, { key, ic, tone = 'blue', title, value, unit, delta, spark, sparkColor = '#3b82f6', bars = false, foot = [], href }) {
  const c = h('canvas');
  // "#section" scrolls to a panel on the same page; anything else is a route
  const local = href && href.startsWith('#');
  const card = h('a', { class: `kpi kpi-${tone}`, href, 'data-link': !local, onclick: local ? (e) => { e.preventDefault(); document.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } : null },
    h('div', { class: 'kpi-top' }, h('span', { class: 'kpi-ic' }, icon(ic, 18)), h('span', { class: 'kpi-title' }, title)),
    h('div', { class: 'kpi-mid' },
      h('div', { class: 'kpi-val' }, delta ? h('span', { class: `kpi-delta ${delta.cls}` }, delta.text) : null, h('b', {}, value), unit ? h('small', {}, unit) : null),
      h('div', { class: 'kpi-spark' }, spark && spark.length > 1 ? c : null)),
    h('div', { class: 'kpi-foot' }, foot));
  if (spark && spark.length > 1) setTimeout(() => setChart(`kpi-${key || title}`, sparkline(c, spark, sparkColor, bars)));
  return card;
}

export function delta(now, before, { goodWhenUp = true, pct = false, unit = '' } = {}) {
  if (before === null || before === undefined || !Number.isFinite(now)) return null;
  const v = pct ? (before ? ((now - before) / before) * 100 : 0) : now - before;
  if (Math.abs(v) < 0.05) return null;
  const text = `${v > 0 ? '↑' : '↓'} ${pct ? `${Math.abs(v).toFixed(0)}%` : `${Number.isInteger(v) ? Math.abs(v) : Math.abs(v).toFixed(1)}${unit}`}`;
  return { text, cls: (v > 0) === goodWhenUp ? 'good' : 'bad' };
}

// ---------- panel ----------
export function panel(title, ic, body, { link, linkLabel = 'View all', extra, cls = '' } = {}) {
  return h('section', { class: `panel ov-panel ${cls}` },
    h('div', { class: 'panel-head' }, ic ? icon(ic, 16, 'ov-ic') : null, h('h3', {}, title),
      h('div', { class: 'right' }, extra || null, link ? h('a', { class: 'ov-link', href: link, 'data-link': true }, linkLabel, icon('arrowRight', 13)) : null)),
    body);
}

export function chartBox(height = 220) {
  const canvas = h('canvas');
  return { canvas, el: h('div', { class: 'chart-box', style: { height: `${height}px` } }, canvas) };
}

// clicking a point / bar calls onPick(index, datasetIndex)
function clickable(chart, onPick) {
  chart.options.onClick = (evt, els) => { if (els.length) onPick(els[0].index, els[0].datasetIndex); };
  chart.options.onHover = (evt, els) => { evt.native.target.style.cursor = els.length ? 'pointer' : 'default'; };
  chart.update('none');
  return chart;
}

export function lineDrill(canvas, seriesList, { unit = 'none', area = false, legend = true, onPick, min, max } = {}) {
  const ch = timeChart(canvas, seriesList, { unit, area, legend, min, max });
  // more than 2 days on the axis: label with dates, not clock times
  const ts = seriesList.flatMap((s) => s.points.map((p) => p[0]));
  if (ts.length && Math.max(...ts) - Math.min(...ts) > 2 * 86400) {
    ch.options.scales.x.ticks.callback = (v) => new Date(v).toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
    ch.update('none');
  }
  return onPick ? clickable(ch, (i, ds) => onPick(seriesList[ds].points[i], ds)) : ch;
}

// stacked bars with category labels: datasets [{label, data, color}]
export function stackedBars(canvas, labels, datasets, { unit = 'none', onPick } = {}) {
  const opts = baseOptions(unit, { stacked: true, showLegend: true });
  opts.scales.x.stacked = true;
  opts.interaction = { mode: 'index', intersect: false };
  const ch = new window.Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: datasets.map((d, i) => ({ label: d.label, data: d.data, backgroundColor: d.color || PALETTE[i], borderRadius: 3, maxBarThickness: 26, stack: 's' })) },
    options: opts,
  });
  return onPick ? clickable(ch, onPick) : ch;
}

export function donut(canvas, labels, values, colors, onPick) {
  const ch = doughnut(canvas, labels, values, colors);
  return onPick ? clickable(ch, (i) => onPick(i)) : ch;
}

// "2h ago" -> 7200 (so newer sorts first when descending is reversed), "14m 12s" / "2.7 h" / "45 min" -> seconds
const UNIT_S = { s: 1, sec: 1, m: 60, min: 60, h: 3600, d: 86400 };
function toSeconds(text) {
  const t = text.toLowerCase().trim();
  if (t === 'just now') return 0;
  const parts = [...t.matchAll(/(\d+(?:\.\d+)?)\s*(min|sec|ms|s|m|h|d)\b/g)];
  if (!parts.length || !/^[\d.\s]+(min|sec|ms|s|m|h|d)\b/.test(t)) return null;
  if (!/^(\d+(?:\.\d+)?\s*(min|sec|ms|s|m|h|d)\s*)+(ago)?$/.test(t)) return null;
  return parts.reduce((a, [, n, u]) => a + Number(n) * (u === 'ms' ? 0.001 : UNIT_S[u]), 0);
}

// ---------- table: click a header to sort; long tables get a search box and pages ----------
// cols: [{ label, value: (row) => node|string, num?: true, cls?, sort?: (row) => number|string, minor?: true (hidden when the panel is narrow) }]
// opts: max (preview: first N rows, no search/pages), pageSize (default 10), search (force on/off)
export function table(cols, rows, { onRow, empty = ['Nothing to show', ''], max, pageSize = 10, search } = {}) {
  if (!rows.length) return emptyState(...empty);
  const state = { col: -1, dir: 1, q: '', page: 0 };
  const textOf = (v) => (v instanceof Node ? v.textContent : String(v ?? ''));
  const keyCache = new Map();
  const key = (r, i) => {
    const c = cols[i];
    const id = `${rows.indexOf(r)}:${i}`;
    if (!keyCache.has(id)) {
      let k = c.sort ? c.sort(r) : textOf(c.value(r)).trim();
      const t = typeof k === 'string' ? toSeconds(k) : null;
      if (t !== null) k = t;
      else if (typeof k === 'string') { const n = parseFloat(k.replace(/[,$%]/g, '').replace(/^[^\d-]+/, '')); if (c.num && Number.isFinite(n)) k = n * (/K\b/.test(k) ? 1e3 : /M\b/.test(k) ? 1e6 : /TB\b/.test(k) ? 1e3 : 1); }
      keyCache.set(id, k);
    }
    return keyCache.get(id);
  };
  const rowText = new Map();
  const textRow = (r) => { if (!rowText.has(r)) rowText.set(r, cols.map((c) => textOf(c.value(r))).join(' ').toLowerCase()); return rowText.get(r); };
  const paged = !max && rows.length > pageSize;
  const searchable = search ?? (!max && rows.length > 8);
  const wrap = h('div', { class: 'table-wrap' });
  const tools = h('div', { class: 'tbl-tools' });
  const out = h('div', { class: 'tbl-box' }, searchable ? tools : null, wrap); // h() skips null children
  let input = null;
  if (searchable) {
    input = h('input', { class: 'input input-sm', type: 'search', placeholder: 'Filter rows…', 'aria-label': 'Filter rows', oninput: (e) => { state.q = e.target.value.toLowerCase(); state.page = 0; draw(); } });
    tools.append(icon('search', 13, 'dim'), input, h('span', { class: 'dim tbl-count' }));
  }
  function draw() {
    let list = state.q ? rows.filter((r) => textRow(r).includes(state.q)) : [...rows];
    if (state.col >= 0) list.sort((a, b) => { const x = key(a, state.col), y = key(b, state.col); return (x > y ? 1 : x < y ? -1 : 0) * state.dir; });
    const total = list.length;
    const pages = paged ? Math.max(1, Math.ceil(total / pageSize)) : 1;
    state.page = Math.min(state.page, pages - 1);
    if (max) list = list.slice(0, max);
    else if (paged) list = list.slice(state.page * pageSize, (state.page + 1) * pageSize);
    if (searchable) tools.querySelector('.tbl-count').textContent = state.q ? `${total} of ${rows.length}` : `${rows.length} rows`;
    clear(wrap).append(
      h('table', { class: 'tbl ov-tbl' },
        h('thead', {}, h('tr', {}, cols.map((c, i) => (c.label
          ? h('th', { class: `${c.num ? 'num' : ''} ${c.minor ? 'col-minor' : ''} sortable ${state.col === i ? 'sorted' : ''}`, 'aria-sort': state.col === i ? (state.dir > 0 ? 'ascending' : 'descending') : 'none' },
            h('button', { class: 'th-btn', onclick: () => { if (state.col === i) state.dir = -state.dir; else { state.col = i; state.dir = c.num ? -1 : 1; } draw(); } },
              c.label, h('span', { class: 'sort-ic' }, state.col === i ? (state.dir > 0 ? '▲' : '▼') : '↕')))
          : h('th', {}))))),
        h('tbody', {}, list.length ? list.map((r) => h('tr', {
          class: onRow ? 'clickable' : '', tabindex: onRow ? 0 : null,
          onclick: onRow ? () => onRow(r) : null, onkeydown: onRow ? (e) => e.key === 'Enter' && onRow(r) : null,
        }, cols.map((c) => h('td', { class: `${c.num ? 'num' : ''} ${c.minor ? 'col-minor' : ''} ${c.cls || ''}` }, c.value(r)))))
          : h('tr', {}, h('td', { colspan: cols.length, class: 'dim', style: { textAlign: 'center', padding: '18px' } }, 'No rows match the filter')))),
      ...(paged && pages > 1 ? [h('div', { class: 'pager' },
        h('button', { class: 'btn btn-sm', disabled: state.page === 0, title: state.page === 0 ? 'Already on the first page' : 'Previous page', onclick: () => { state.page--; draw(); } }, icon('arrowLeft', 12), 'Previous'),
        h('span', { class: 'dim' }, `Page ${state.page + 1} of ${pages}`),
        h('button', { class: 'btn btn-sm', disabled: state.page >= pages - 1, title: state.page >= pages - 1 ? 'Already on the last page' : 'Next page', onclick: () => { state.page++; draw(); } }, 'Next', icon('arrowRight', 12)))] : []));
  }
  draw();
  return out;
}

// ---------- actions that need an integration that is not built yet ----------
// They stay visible (so people know the feature is planned) but cannot run, and say why when clicked.
export const NEEDS = {
  k8s: 'it needs the Kubernetes API integration with permission checks, which is not built yet',
  cicd: 'it needs the CI/CD integration, which is not built yet',
  agents: 'it needs remote agent management, which is not built yet',
  paging: 'it needs a paging integration (for example PagerDuty or Opsgenie), which is not connected',
  tickets: 'it needs a ticketing integration (for example Jira or ServiceNow), which is not connected',
  firewall: 'it needs a firewall integration, which is not connected',
  scanner: 'it needs a vulnerability scanner integration, which is not connected',
  email: 'it needs an e-mail delivery service, which is not configured',
  cost: 'it needs a cost data source, which is not connected',
  backup: 'database backups are run from the server (see the README), not from this page',
};
export function notConnected(ic, label, why) {
  return h('button', {
    class: 'btn btn-sm btn-unavail', 'aria-disabled': 'true', title: `Not available yet: ${why}`,
    onclick: () => toast(`${label} is not available yet: ${why}. Nothing was changed.`, 'err'),
  }, icon('lock', 12), label);
}

// ---------- quick actions ----------
// items: [{ ic, label, sub, href } | { ic, label, sub, onclick }]
export function quickActions(items) {
  return h('div', { class: 'qa-grid' }, items.map((a) => (a.unavailable
    ? h('button', { class: 'qa qa-unavail', 'aria-disabled': 'true', title: `Not available yet: ${a.unavailable}`, onclick: () => toast(`${a.label} is not available yet: ${a.unavailable}.`, 'err') },
      h('span', { class: 'qa-ic' }, icon('lock', 16)), h('span', {}, h('b', {}, a.label), h('small', {}, 'Not available yet')))
    : a.href
    ? h('a', { class: 'qa', href: a.href, 'data-link': true }, h('span', { class: 'qa-ic' }, icon(a.ic, 16)), h('span', {}, h('b', {}, a.label), h('small', {}, a.sub || '')))
    : h('button', { class: 'qa', onclick: a.onclick }, h('span', { class: 'qa-ic' }, icon(a.ic, 16)), h('span', {}, h('b', {}, a.label), h('small', {}, a.sub || ''))))));
}

// ---------- states ----------
export function loadingSkeleton(kpis = 5) {
  return h('div', { class: 'skeleton-wrap', 'aria-busy': 'true', 'aria-label': 'Loading' },
    h('div', { class: 'ov-kpis' }, Array.from({ length: kpis }, () => h('div', { class: 'kpi skeleton', style: { height: '118px' } }))),
    h('div', { class: 'ov-row persona-row-2' }, h('div', { class: 'panel skeleton', style: { height: '280px' } }), h('div', { class: 'panel skeleton', style: { height: '280px' } })),
    h('div', { class: 'panel skeleton', style: { height: '220px', marginTop: '14px' } }));
}

export function errorState(message, retry, title = 'This dashboard could not load') {
  return h('div', { class: 'state-box', role: 'alert' },
    h('div', { class: 'state-ic err' }, icon('alert', 22)),
    h('div', { class: 'empty-title' }, title),
    h('div', { class: 'muted' }, message),
    retry ? h('button', { class: 'btn btn-primary', style: { marginTop: '10px' }, onclick: retry }, icon('refresh', 14), 'Try again') : null);
}

// Stale data: the last good data stays on screen, this says how old it is and why it did not update.
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export function staleNotice({ okAt, failedAt = Date.now(), message, retry }) {
  return h('div', { class: 'stale-notice', role: 'status' },
    icon('clock', 15),
    h('span', {}, h('b', {}, `Couldn't refresh at ${clock(failedAt)}`), ` — showing data from ${clock(okAt)}.`, message ? h('span', { class: 'dim' }, ` ${message}`) : null),
    retry ? h('button', { class: 'btn btn-sm', onclick: retry }, icon('refresh', 12), 'Try again') : null);
}

export const statusPill = (s) => {
  const map = {
    succeeded: ['Succeeded', 'st-ok'], passed: ['Passed', 'st-ok'], healthy: ['Healthy', 'st-ok'],
    failed: ['Failed', 'st-err'], rolled_back: ['Rolled back', 'st-slow'], degraded: ['Degraded', 'st-slow'],
    in_progress: ['In progress', 'st-inv'], running: ['Running', 'st-inv'], pending: ['Pending', 'st-res'], skipped: ['Skipped', 'st-res'],
    critical: ['Critical', 'sev-critical'], warning: ['Warning', 'sev-warning'],
    // incident workflow (Incidents, Overview, Service detail)
    open: ['Open', 'st-open'], acknowledged: ['Acknowledged', 'st-ack'], investigating: ['Investigating', 'st-inv'], resolved: ['Resolved', 'st-res'],
  };
  const [l, c] = map[s] || [s, 'st-res'];
  return h('span', { class: `pill ${c}` }, l);
};

export const dur = (sec) => (sec < 60 ? `${Math.round(sec)}s` : sec < 3600 ? `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s` : `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`);
export const since = (ms) => {
  const s = (Date.now() - ms) / 1000;
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
// higher is better (scores): green when high
export const scoreBar = (v) => h('div', { class: 'meter', style: { width: '100%' } }, h('i', { style: { width: `${Math.max(0, Math.min(100, v))}%`, background: v >= 85 ? '#22c55e' : v >= 70 ? '#f59e0b' : '#ef4444' } }));
export const meter = (pct, warn = 75, crit = 90) => h('div', { class: 'meter', title: fmt(pct, 'percent') },
  h('i', { class: pct >= crit ? 'm-crit' : pct >= warn ? 'm-warn' : 'm-ok', style: { width: `${Math.min(100, pct)}%` } }), h('span', {}, `${pct.toFixed(0)}%`));
export { legendRow, hexA };

// ---------- detail page header (with breadcrumbs) ----------
export function detailHead(ic, kicker, title, sub, actions = []) {
  const titleParts = [].concat(title);
  // breadcrumb label = the name only, not status pills next to it
  const plain = titleParts.map((t) => (typeof t === 'string' ? t : t?.classList?.contains('pill') ? '' : t?.textContent || '')).join('').trim();
  return h('div', {},
    breadcrumbs(plain.length > 48 ? `${plain.slice(0, 46)}…` : plain),
    h('div', { class: 'page-head' },
      h('div', { style: { minWidth: 0 } }, h('div', { class: 'persona-kicker' }, icon(ic, 14), kicker), h('h1', {}, ...titleParts), sub ? h('p', {}, sub) : null),
      h('div', { class: 'actions' }, ...actions.filter(Boolean))));
}

export function miniStat(label, value, sub, tone = '') {
  return h('div', { class: 'kpi kpi-small' }, h('div', { class: 'kpi-top' }, h('span', { class: 'kpi-title' }, label)),
    h('div', { class: 'kpi-val' }, h('b', { style: { fontSize: '19px' }, class: tone }, value)), sub ? h('div', { class: 'kpi-foot' }, h('span', { class: 'dim' }, sub)) : null);
}

export function linkBtn(href, ic, label, cls = 'btn btn-sm') {
  return h('a', { class: cls, href, 'data-link': true }, icon(ic, 13), label);
}

// a page that loads data once (with loading / error / not-found states)
export function detailPage(main, { load, render, notFound }) {
  const body = h('div', {}, loadingSkeleton(0));
  // optional sections are passed as null: skip them instead of printing "null"
  const append = body.append.bind(body);
  body.append = (...xs) => append(...xs.flat().filter((x) => x !== null && x !== undefined && x !== false));
  main.append(body);
  async function refresh() {
    let d;
    try { d = await load(); } catch (e) { clear(body).append(errorState(e.message, refresh)); return; }
    clear(body);
    if (!d) { body.append(h('div', { class: 'state-box' }, emptyState(...notFound))); return; }
    render(body, d);
  }
  refresh();
  return { refresh, autoRefresh: false };
}

export function barCats(canvas, labels, values, { unit = 'none', colors, onPick, horizontal = false } = {}) {
  const opts = baseOptions(unit, {});
  if (horizontal) {
    opts.indexAxis = 'y';
    [opts.scales.x, opts.scales.y] = [opts.scales.y, opts.scales.x];
    opts.scales.x.ticks.callback = (v) => fmt(v, unit, 0);
    opts.scales.y.ticks.callback = function (v) { return this.getLabelForValue(v); };
    opts.scales.y.ticks.autoSkip = false;
  }
  const ch = new window.Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label: unit === 'none' ? 'value' : unit, data: values, backgroundColor: colors || labels.map(() => '#3b82f6'), borderRadius: 3, maxBarThickness: 28 }] },
    options: { ...opts, plugins: { ...opts.plugins, legend: { display: false } } },
  });
  return onPick ? clickable(ch, (i) => onPick(i)) : ch;
}
