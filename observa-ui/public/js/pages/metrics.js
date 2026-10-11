import { h, api, clear, icon, fmt, timeChart, legendName, select, tabs, modal, field, toast, dateTime, palette, timeHM, stateView, stateFromError, timeEl, timeHeader, color } from '../ui.js';
import { chartSlots } from './common.js';
import { CATALOG, GROUPS, byId, rawQuery, unitFor, INTERNAL } from './metrics-catalog.js';

// Metrics: pick a metric and compare servers (no query language), or write PromQL in Advanced.
// Everything shown comes from Prometheus; a metric no server sends shows an empty state saying why.

const SHOW = [['host', 'Per server'], ['avg', 'Average of all'], ['max', 'Highest of all'], ['worst', 'Worst 5']];
const EMPTY_HINT = {
  windows: 'No Windows server sends this yet. Install the ObservaOne Agent on a Windows server (Agents > Windows).',
  linux: 'No Linux server sends this yet. Install the ObservaOne Agent on a Linux server (Agents > Linux).',
  containers: 'No container data yet. It comes from the Docker agent (Agents > Docker) or the Kubernetes agent (Agents > Kubernetes).',
  kubernetes: 'No Kubernetes cluster data yet, or nothing is wrong right now (this metric only lists problems). Install the Kubernetes agent (Agents > Kubernetes).',
  agent: 'No agent reports this yet, or none matches the filters.',
  common: 'No server matches the filters, or none sends this metric yet.',
};

export function metricsPage(main, ctx) {
  const setChart = chartSlots(ctx);
  ctx.setDsChip('Prometheus', color('ok'));
  const P = ctx.params;
  let mode = P.get('q') ? 'advanced' : (P.get('mode') === 'advanced' ? 'advanced' : 'explore');

  const head = h('div', { class: 'page-head' },
    h('div', {}, h('h1', {}, 'Metrics'), h('p', {}, 'Pick a metric to compare your servers over time. No query language needed.')),
    h('div', { class: 'actions' }, h('span', { id: 'metrics-mode' })));
  const body = h('div');
  main.append(head, body);

  function drawMode() {
    clear(head.querySelector('#metrics-mode')).append(tabs([['explore', 'Explore'], ['advanced', 'Advanced (PromQL)']], mode, (k) => { mode = k; drawMode(); start(); }));
  }
  drawMode();

  let current = null; // { refresh }
  function start() {
    setChart('main', null);
    clear(body);
    current = mode === 'explore' ? explore(body) : advanced(body, advancedStart);
  }
  let advancedStart = P.get('q') || null;

  // ---------------------------------------------------------------- explore
  function explore(root) {
    const F = { host: P.get('host') || '', env: P.get('env') || '', role: P.get('role') || '', platform: P.get('platform') || '' };
    let show = SHOW.some(([k]) => k === P.get('show')) ? P.get('show') : 'host';
    let metric = byId(P.get('m')) || (P.get('m')?.startsWith('raw:') ? { raw: P.get('m').slice(4) } : null) || byId(sessionStorage.getItem('oo.metric')) || byId('cpu');
    let search = '', showInternal = false, rawList = null, last = null;
    const openGroups = new Set([metric.group || (metric.raw ? 'all' : 'common')]); // several groups can be open
    const toggle = (g) => (openGroups.has(g) ? openGroups.delete(g) : openGroups.add(g));

    const listBox = h('nav', { class: 'mx-list', 'aria-label': 'Metrics' });
    const searchIn = h('input', { class: 'input', type: 'search', id: 'metric-search', placeholder: 'Search metrics...', 'aria-label': 'Search metrics',
      oninput: (e) => { search = e.target.value.trim().toLowerCase(); if (search && !rawList) loadRaw(); drawList(); } });
    const mobilePick = h('div', { class: 'mx-mobile-pick' });
    const titleBox = h('div', { class: 'mx-title' });
    const filterBar = h('div', { class: 'toolbar mx-filters' });
    const chartBox = h('div');
    const tableBox = h('div', { style: { marginTop: '14px' } });

    root.append(h('div', { class: 'mx-layout' },
      h('aside', { class: 'mx-side panel' }, searchIn, listBox),
      h('div', { class: 'mx-main' }, mobilePick, titleBox, filterBar, h('section', { class: 'panel' }, chartBox), tableBox)));

    // ---- metric list ----
    const label = (m) => m.label || m.raw;
    function drawList() {
      const match = (m) => !search || `${m.label} ${m.desc} ${m.id}`.toLowerCase().includes(search);
      const item = (m, key) => {
        const on = key === (metric.id || `raw:${metric.raw}`);
        return h('button', { class: `mx-item ${on ? 'active' : ''}`, 'aria-current': on ? 'true' : null, title: m.desc || m.help || m.name,
          onclick: () => { metric = m.name ? { raw: m.name, type: m.type, help: m.help } : m; openGroups.add(m.group || 'all'); pickChanged(); } },
        h('span', { class: m.name ? 'mono ell' : 'ell' }, m.label || m.name));
      };
      const blocks = GROUPS.map(([g, gl]) => {
        const items = CATALOG.filter((m) => m.group === g && match(m));
        if (!items.length) return null;
        const open = search || openGroups.has(g);
        return h('div', { class: 'mx-group' },
          h('button', { class: 'mx-group-title', 'aria-expanded': String(!!open), onclick: () => { toggle(g); drawList(); } },
            icon('chevron', 12), gl, h('span', { class: 'dim' }, String(items.length))),
          open ? h('div', {}, items.map((m) => item(m, m.id))) : null);
      }).filter(Boolean);
      // every metric that exists, with its description
      const raws = (rawList || []).filter((m) => (showInternal || !INTERNAL.test(m.name)) && (!search || `${m.name} ${m.help}`.toLowerCase().includes(search)));
      const allOpen = search || openGroups.has('all');
      blocks.push(h('div', { class: 'mx-group' },
        h('button', { class: 'mx-group-title', 'aria-expanded': String(!!allOpen), onclick: () => { toggle('all'); if (!rawList) loadRaw(); drawList(); } },
          icon('chevron', 12), 'All metrics', h('span', { class: 'dim' }, rawList ? String(raws.length) : '')),
        allOpen ? h('div', {},
          h('label', { class: 'dim mx-internal' }, h('input', { type: 'checkbox', id: 'mx-internal', checked: showInternal, onchange: (e) => { showInternal = e.target.checked; drawList(); } }), 'Include monitoring-system metrics'),
          !rawList ? h('div', { class: 'dim', style: { padding: '6px 10px', fontSize: '12px' } }, 'Loading...')
            : raws.length ? raws.slice(0, 300).map((m) => item(m, `raw:${m.name}`)) : h('div', { class: 'dim', style: { padding: '6px 10px', fontSize: '12px' } }, 'No metric matches.'),
          raws.length > 300 ? h('div', { class: 'dim', style: { padding: '6px 10px', fontSize: '12px' } }, `First 300 of ${raws.length}. Type to narrow down.`) : null) : null));
      clear(listBox).append(...blocks);
      // phones: one dropdown instead of the side list
      clear(mobilePick).append(select([...CATALOG.map((m) => [m.id, `${GROUPS.find(([g]) => g === m.group)[1]}: ${m.label}`]), ...(metric.raw ? [[`raw:${metric.raw}`, metric.raw]] : [])],
        metric.id || `raw:${metric.raw}`, (v) => { metric = byId(v) || metric; openGroups.add(metric.group); pickChanged(); }, { class: 'select', 'aria-label': 'Metric' }));
    }
    async function loadRaw() {
      try { rawList = await api('/prom/metric-catalog'); } catch (e) { rawList = []; toast(`Metric list unavailable: ${e.message}`, 'err'); }
      if (metric.raw && !metric.type) { const m = rawList.find((x) => x.name === metric.raw); if (m) Object.assign(metric, { type: m.type, help: m.help }); }
      drawList();
    }
    if (metric.raw) loadRaw();

    // ---- filters ----
    const opts = { host: [], env: [], role: [], platform: [] };
    async function loadFilters() {
      const lv = (label) => api('/prom/label-values', { query: { label, match: 'up{job=~"linux|windows"}' } }).catch(() => []);
      const [hosts, envs, roles, plats, scraped] = await Promise.all([lv('host'), lv('env'), lv('role'), lv('platform'),
        api('/prom/query', { query: { query: 'count(up{job=~"linux|windows",agent!="observaone"})' } }).then((r) => Number(r.result?.[0]?.value?.[1] || 0)).catch(() => 0)]);
      const PL = { linux: 'Linux', windows: 'Windows', docker: 'Docker', kubernetes: 'Kubernetes' };
      Object.assign(opts, { host: hosts, env: envs, role: roles, platform: [...plats.map((p) => [p, PL[p] || p]), ...(scraped ? [['__none', 'Scraped (no agent)']] : [])] });
      drawFilters();
    }
    function drawFilters() {
      const sel = (key, labelText, list) => {
        const items = [['', `All`], ...list.map((v) => (Array.isArray(v) ? v : [v, v]))];
        if (F[key] && !items.some(([v]) => v === F[key])) items.push([F[key], F[key]]);
        return h('label', { class: 'mx-filter' }, h('span', { class: 'muted' }, labelText),
          select(items, F[key], (v) => { F[key] = v; pickChanged(false); }, { class: 'select select-sm', 'aria-label': labelText, id: `mx-${key}` }));
      };
      const active = Object.values(F).some(Boolean);
      clear(filterBar).append(...[
        sel('host', 'Server', opts.host), sel('env', 'Env', opts.env), sel('role', 'Role', opts.role), sel('platform', 'Platform', opts.platform),
        h('label', { class: 'mx-filter' }, h('span', { class: 'muted' }, 'Show'),
          select(SHOW, show, (v) => { show = v; pickChanged(false); }, { class: 'select select-sm', 'aria-label': 'Show', id: 'mx-show' })),
        active ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { Object.keys(F).forEach((k) => { F[k] = ''; }); pickChanged(false); } }, 'Clear filters') : null,
        h('div', { class: 'grow' }),
        h('button', { class: 'btn btn-sm', title: 'See and edit this as a PromQL query', onclick: () => { advancedStart = query(); mode = 'advanced'; drawMode(); start(); } }, 'Open in Advanced'),
        ctx.can('dashboards.edit') && ctx.canOpen('/dashboards') ? h('button', { class: 'btn btn-sm', onclick: () => addToDashboard(query(), unit(), label(metric), legendTpl()) }, icon('plus', 13), 'Add to dashboard') : null,
      ].filter(Boolean));
    }

    // ---- query ----
    const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const filters = () => [
      F.host && `host="${esc(F.host)}"`, F.env && `env="${esc(F.env)}"`, F.role && `role="${esc(F.role)}"`,
      F.platform && (F.platform === '__none' ? 'platform=""' : `platform="${esc(F.platform)}"`),
    ].filter(Boolean).join(',');
    const f = (name, base = '') => { const m = [base, filters()].filter(Boolean).join(','); return m ? `${name}{${m}}` : name; };
    const unit = () => (metric.raw ? unitFor(metric.raw, metric.type) : metric.unit);
    const baseQuery = () => (metric.raw ? rawQuery(metric.raw, metric.type, f) : metric.q(f));
    const query = () => { const b = baseQuery(); return show === 'avg' ? `avg(${b})` : show === 'max' ? `max(${b})` : b; };
    const byLabels = () => (metric.by || 'host').split(',').map((x) => x.trim());
    const legendTpl = () => (show === 'avg' || show === 'max' ? '' : byLabels().map((l) => `{{${l}}}`).join(' '));
    const seriesName = (m) => {
      if (show === 'avg') return 'Average';
      if (show === 'max') return 'Highest';
      const parts = byLabels().flatMap((l) => (l === 'container' ? [m.name, m.namespace && m.pod ? `${m.namespace}/${m.pod}` : '', m.container] : [m[l]])).filter(Boolean);
      return parts.length ? [...new Set(parts)].join(' · ') : legendName(m);
    };

    function pickChanged(redrawList = true) {
      if (metric.id) sessionStorage.setItem('oo.metric', metric.id);
      const u = new URLSearchParams({ m: metric.id || `raw:${metric.raw}` });
      Object.entries(F).forEach(([k, v]) => v && u.set(k, v));
      if (show !== 'host') u.set('show', show);
      history.replaceState({}, '', `/metrics?${u}`);
      if (redrawList) drawList();
      drawTitle();
      drawFilters();
      run();
    }
    function drawTitle() {
      const desc = metric.raw ? (metric.help || 'No description from the source. Counters are shown per second.') : metric.desc;
      clear(titleBox).append(h('h2', {}, label(metric), metric.raw ? h('span', { class: 'pill pill-muted' }, metric.type || 'metric') : null), h('p', { class: 'muted' }, desc));
    }

    async function run() {
      clear(chartBox).append(stateView('loading', { skeleton: 'chart' }));
      clear(tableBox);
      try {
        const { start, end } = ctx.range;
        const r = await api('/prom/query_range', { query: { query: query(), start, end } });
        last = { result: r.result || [], start, end };
        draw();
      } catch (e) {
        last = null;
        clear(chartBox).append(stateFromError(e, 'Metrics'));
      }
    }

    function stats(points, end) {
      const vals = points.map(([, v]) => Number(v)).filter(Number.isFinite);
      if (!vals.length) return { now: null, avg: null, min: null, max: null };
      const [t, v] = points[points.length - 1];
      const step = points.length > 1 ? points[1][0] - points[0][0] : 60;
      const fresh = end - t <= Math.max(2 * step, 150); // older than that: the server stopped sending
      return { now: fresh ? Number(v) : null, avg: vals.reduce((a, b) => a + b, 0) / vals.length, min: Math.min(...vals), max: Math.max(...vals) };
    }

    function draw() {
      clear(chartBox); clear(tableBox);
      let rows = last.result.map((r) => ({ metric: r.metric, name: seriesName(r.metric), points: r.values, ...stats(r.values, last.end) }));
      if (!rows.length) {
        const filtered = Object.values(F).some(Boolean);
        chartBox.append(stateView('empty', {
          title: `No data for ${label(metric)}`,
          text: filtered ? 'No server matches the filters for this metric in the selected time range. Clear filters or widen the time range.'
            : (metric.empty || EMPTY_HINT[metric.group] || 'Nothing reports this metric in the selected time range.'),
          action: filtered ? h('button', { class: 'btn btn-sm', onclick: () => { Object.keys(F).forEach((k) => { F[k] = ''; }); pickChanged(false); } }, 'Clear filters')
            : (metric.group && metric.group !== 'agent' && ctx.canOpen('/agents') ? h('a', { href: `/agents/${metric.group === 'containers' ? 'docker' : metric.group === 'common' ? '' : metric.group}`.replace(/\/$/, ''), 'data-link': true, class: 'btn btn-sm' }, 'Install an agent') : null),
        }));
        return;
      }
      const worse = metric.worse === 'low' ? 1 : -1; // sort worst first
      const rank = (x) => (x.now ?? x.avg ?? 0);
      rows.sort((a, b) => (rank(a) - rank(b)) * worse || a.name.localeCompare(b.name));
      if (show === 'worst') rows = rows.slice(0, 5);
      const chartRows = rows.slice(0, 20);
      const pal = palette();
      const c = h('canvas');
      chartBox.append(h('div', { class: 'metrics-graph' }, h('div', { class: 'chart-box lg' }, c),
        h('div', { class: 'legend-col', tabindex: 0, 'aria-label': 'Chart legend' }, chartRows.map((s, i) => h('div', { class: 'legend-item', title: s.name }, h('i', { style: { background: pal[i % pal.length] } }), h('span', { class: 'ell' }, s.name))))));
      setChart('main', timeChart(c, chartRows.map((s) => ({ label: s.name, points: s.points })), { unit: unit(), min: 0, max: metric.max }));
      if (rows.length > 20) chartBox.append(h('div', { class: 'muted', style: { marginTop: '6px' } }, `Chart shows the 20 worst of ${rows.length}; the table lists all.`));

      // per-series table: what users scan first
      const hostCol = byLabels().includes('host') && show !== 'avg' && show !== 'max';
      const dashFor = (m) => (m.os === 'windows' || m.platform === 'windows' ? 'windows-servers' : 'linux-servers');
      tableBox.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, h('th', {}, show === 'avg' || show === 'max' ? 'Series' : byLabels().map((l) => (l === 'host' ? 'Server' : l[0].toUpperCase() + l.slice(1))).join(' · ')),
          h('th', { class: 'num', title: 'Latest value; "-" when nothing arrived in the last few minutes' }, 'Now'), h('th', { class: 'num' }, 'Average'), h('th', { class: 'num' }, 'Min'), h('th', { class: 'num' }, 'Max'), h('th', {}, ''))),
        h('tbody', {}, rows.map((r) => h('tr', hostCol && r.metric.host ? { class: 'clickable', tabindex: 0, title: `Show only ${r.metric.host}`,
          onclick: () => { F.host = F.host === r.metric.host ? '' : r.metric.host; pickChanged(false); },
          onkeydown: (e) => { if (e.key === 'Enter') { F.host = F.host === r.metric.host ? '' : r.metric.host; pickChanged(false); } } } : {},
        h('td', {}, h('b', { style: { fontWeight: 600 } }, r.name)),
        ...['now', 'avg', 'min', 'max'].map((k) => h('td', { class: `num ${k === 'now' && r.now === null ? 'dim' : ''}`, title: k === 'now' && r.now === null ? 'No recent data' : '' }, fmt(r[k], unit()))),
        h('td', { class: 'num' }, hostCol && r.metric.host && ctx.canOpen(`/dashboards/${dashFor(r.metric)}`)
          ? h('a', { href: `/dashboards/${dashFor(r.metric)}`, 'data-link': true, title: `Open the dashboard for ${r.metric.host}`, 'aria-label': `Open the dashboard for ${r.metric.host}`,
            onclick: (e) => { e.stopPropagation(); sessionStorage.setItem(`oo.var.${dashFor(r.metric)}.host`, r.metric.host); } }, icon('dashboards', 15)) : null)))))));
    }

    drawList(); drawTitle(); drawFilters(); loadFilters(); run();
    return { refresh: run };
  }

  // ---------------------------------------------------------------- advanced (PromQL)
  function advanced(root, initial) {
    let view = 'graph', unit = 'none', stepSel = 'auto', last = null;
    const startQuery = initial || ctx.pref('metricsQuery') || byId('cpu').q((n, b = '') => (b ? `${n}{${b}}` : n));
    const input = h('textarea', { class: 'mx-promql mono', rows: 3, spellcheck: 'false', 'aria-label': 'PromQL query', id: 'promql',
      onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); } } }, startQuery);
    const datalistHint = h('div', { class: 'dim', style: { fontSize: '12px', marginTop: '4px' } }, 'Ctrl + Enter to run. Tip: pick a metric in Explore and press "Open in Advanced" to start from a working query.');
    const out = h('div');
    const legendBox = h('div', { class: 'legend-col', tabindex: 0, 'aria-label': 'Chart legend' });
    const tableBox = h('div', { style: { marginTop: '14px' } });
    const viewTabs = h('span');
    root.append(
      h('div', { class: 'query-bar', style: { alignItems: 'flex-start' } }, h('div', { style: { flex: 1, minWidth: 0 } }, input, datalistHint), h('button', { class: 'btn btn-primary', onclick: run }, 'Run query')),
      h('div', { class: 'toolbar' }, viewTabs, h('div', { class: 'grow' }),
        h('span', { class: 'muted' }, 'Unit'), select([['none', 'Auto'], ['percent', 'Percent'], ['bytes', 'Bytes'], ['bps', 'bits/s'], ['Bps', 'Bytes/s'], ['s', 'Seconds'], ['ms', 'Milliseconds'], ['iops', 'Operations/s'], ['reqps', 'Requests/s']], unit, (v) => { unit = v; draw(); }, { class: 'select select-sm', 'aria-label': 'Unit' }),
        h('span', { class: 'muted' }, 'Step'), select([['auto', 'Auto'], ['15', '15s'], ['60', '1m'], ['300', '5m'], ['900', '15m']], stepSel, (v) => { stepSel = v; run(); }, { class: 'select select-sm', 'aria-label': 'Step' }),
        ctx.can('dashboards.edit') && ctx.canOpen('/dashboards') ? h('button', { class: 'btn btn-sm', onclick: () => (last ? addToDashboard(last.query, unit, last.query.slice(0, 60), '') : toast('Run a query first', 'err')) }, icon('plus', 13), 'Add to dashboard') : null),
      h('section', { class: 'panel' }, out),
      tableBox);

    function drawTabs() { clear(viewTabs).append(tabs([['graph', 'Graph'], ['table', 'Table']], view, (k) => { view = k; drawTabs(); draw(); })); }
    drawTabs();

    async function run() {
      const q = input.value.trim();
      if (!q) return;
      if (q !== ctx.pref('metricsQuery')) ctx.savePref('metricsQuery', q);
      history.replaceState({}, '', `/metrics?q=${encodeURIComponent(q)}`);
      clear(out).append(stateView('loading', { skeleton: 'chart' }));
      clear(tableBox);
      try {
        const { start, end } = ctx.range;
        const r = await api('/prom/query_range', { query: { query: q, start, end, step: stepSel === 'auto' ? undefined : stepSel } });
        last = { query: q, result: r.result || [] };
        draw();
      } catch (e) {
        last = null;
        clear(out).append(stateFromError(e, 'Metrics'));
      }
    }

    function draw() {
      if (!last) return;
      clear(out); clear(tableBox);
      const res = last.result;
      if (!res.length) { out.append(stateView('empty', { title: 'No data for this query in the selected time range', text: 'Prometheus answered, but the query returned no series. Check the metric name and labels, or widen the time range.' })); return; }
      const series = res.slice(0, 20).map((r) => ({ label: legendName(r.metric), points: r.values }));
      if (view === 'graph') {
        const c = h('canvas');
        const pal = palette();
        clear(legendBox).append(...series.map((s, i) => h('div', { class: 'legend-item', title: s.label }, h('i', { style: { background: pal[i % pal.length] } }), h('span', { class: 'ell' }, s.label))));
        out.append(h('div', { class: 'metrics-graph' }, h('div', { class: 'chart-box lg' }, c), legendBox));
        setChart('main', timeChart(c, series, { unit }));
        if (res.length > 20) out.append(h('div', { class: 'muted', style: { marginTop: '6px' } }, `Showing 20 of ${res.length} series. Narrow the query to see the rest.`));
      }
      const cols = series.slice(0, 8);
      const times = [...new Set(cols.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => b - a).slice(0, view === 'table' ? 200 : 12);
      const maps = cols.map((s) => new Map(s.points.map(([t, v]) => [t, v])));
      const shortName = (l) => { const m = /\{(.*)\}/.exec(l); return m ? m[1].split(', ').map((x) => x.split('=')[1]?.replace(/"/g, '')).join(' / ') : l; };
      const target = view === 'table' ? out : tableBox;
      target.append(h('div', { class: 'table-wrap', style: { maxHeight: view === 'table' ? '560px' : '320px' } }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, h('th', {}, timeHeader()), cols.map((s) => h('th', { class: 'num', title: s.label }, shortName(s.label))))),
        h('tbody', {}, times.map((t) => h('tr', {}, h('td', { class: 'mono' }, timeEl(t * 1000, view === 'table' ? dateTime(t * 1000) : timeHM(t * 1000))), maps.map((m) => h('td', { class: 'num' }, m.has(t) ? fmt(Number(m.get(t)), unit) : '-'))))))));
      if (series.length > 8) target.append(h('div', { class: 'muted', style: { marginTop: '6px' } }, 'Table shows the first 8 series.'));
    }

    run();
    return { refresh: run };
  }

  // ---------------------------------------------------------------- add to dashboard (both modes)
  async function addToDashboard(q, unit, titleText, legendText) {
    let dashes = [];
    try { dashes = (await api('/dashboards')).filter((d) => d.kind === 'custom'); } catch (e) { return toast(e.message, 'err'); }
    if (!dashes.length) return toast('Create a custom dashboard first (Dashboards > New Dashboard).', 'err');
    let dashId = dashes[0].id, type = 'line', w = '6';
    const title = h('input', { class: 'input', value: titleText.slice(0, 60) });
    const legend = h('input', { class: 'input', placeholder: 'e.g. {{host}}', value: legendText });
    modal('Add to dashboard', h('div', {},
      field('Dashboard', select(dashes.map((d) => [d.id, d.title]), dashId, (v) => { dashId = v; })),
      field('Panel title', title),
      h('div', { class: 'form-row' },
        field('Panel type', select([['line', 'Line'], ['area', 'Area'], ['bar', 'Bar (current values)'], ['stat', 'Single number'], ['table', 'Table']], type, (v) => { type = v; })),
        field('Width', select([['4', 'Small (1/3)'], ['6', 'Half'], ['12', 'Full width']], w, (v) => { w = v; }))),
      field('Legend', legend, 'Use {{label}} to show a label value, e.g. {{host}} or {{disk}}.')), [
      { label: 'Cancel' },
      { label: 'Add panel', primary: true, onclick: async () => {
        await api(`/dashboards/${dashId}/panels`, { method: 'POST', body: { title: title.value, type, query: q, legend: legend.value, unit: unit || 'none', w: Number(w) } });
        toast('Panel added');
      } },
    ]);
  }

  start();
  return { refresh: () => current?.refresh?.() };
}
