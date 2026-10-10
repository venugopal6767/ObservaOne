import { errorState, staleNotice } from '../personas/widgets.js';
import { h, api, clear, icon, fmt, timeChart, legendName, emptyState, select, tabs, modal, field, toast, dateTime, PALETTE, timeHM } from '../ui.js';
import { chartSlots } from './common.js';

const EXAMPLES = [
  ['up', 'Which targets are up (1) or down (0)'],
  ['100 - avg by (host) (rate(windows_cpu_time_total{mode="idle"}[5m])) * 100', 'Windows CPU % per server'],
  ['100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)', 'Linux memory used %'],
  ['rate(prometheus_http_requests_total[5m])', 'Prometheus API requests per second'],
];

export function metricsPage(main, ctx) {
  const setChart = chartSlots(ctx);
  ctx.setDsChip('Prometheus', '#22c55e');
  const P = ctx.params;
  let view = P.get('view') === 'table' ? 'table' : 'graph', unit = P.get('unit') || 'none', stepSel = P.get('step') || 'auto', last = null, okAt = 0;
  const startQuery = ctx.params.get('q') || ctx.pref('metricsQuery') || 'rate(prometheus_http_requests_total[5m])';
  const input = h('input', { value: startQuery, list: 'metric-names', spellcheck: 'false', 'aria-label': 'PromQL query', onkeydown: (e) => { if (e.key === 'Enter') runQuiet(); } });
  const stale = h('div');
  const datalist = h('datalist', { id: 'metric-names' });
  const out = h('div');
  const legendBox = h('div', { class: 'legend-col' });
  const tableBox = h('div', { style: { marginTop: '14px' } });
  const viewTabs = h('span');

  main.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Metrics Explorer'), h('p', {}, 'Query and visualize metrics from Prometheus'))),
    h('div', { class: 'query-bar' }, h('div', { class: 'query-input' }, input, datalist), h('button', { class: 'btn btn-primary', onclick: runQuiet }, 'Run Query')),
    h('div', { class: 'toolbar' }, viewTabs, h('div', { class: 'grow' }),
      h('span', { class: 'muted', 'aria-hidden': 'true' }, 'Unit'), select([['none', 'Auto'], ['percent', 'Percent'], ['bytes', 'Bytes'], ['bps', 'bits/s'], ['Bps', 'Bytes/s'], ['s', 'Seconds'], ['ms', 'Milliseconds'], ['reqps', 'Requests/s']], unit, (v) => { unit = v; syncUrl(); draw(); }, { class: 'select select-sm', 'aria-label': 'Unit' }),
      h('span', { class: 'muted', 'aria-hidden': 'true' }, 'Step'), select([['auto', 'Auto'], ['15', '15s'], ['60', '1m'], ['300', '5m'], ['900', '15m']], stepSel, (v) => { stepSel = v; lastKey = null; runQuiet(); }, { class: 'select select-sm', 'aria-label': 'Step' }),
      ctx.can('dashboards.edit') ? h('button', { class: 'btn btn-sm', onclick: addToDashboard }, icon('plus', 13), 'Add to Dashboard') : null),
    stale,
    h('section', { class: 'panel' }, out),
    tableBox,
    h('details', { class: 'panel', style: { marginTop: '14px' } }, h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, 'Example queries'),
      h('div', { style: { marginTop: '10px', display: 'grid', gap: '6px' } }, EXAMPLES.map(([q, t]) =>
        h('div', {}, h('button', { class: 'linkish', title: 'Run this query', onclick: () => { input.value = q; runQuiet(); } }, h('code', {}, q)), h('span', { class: 'muted' }, `  ${t}`))))));

  function drawTabs() {
    clear(viewTabs).append(tabs([['table', 'Table'], ['graph', 'Graph']], view, (k) => { view = k; syncUrl(); drawTabs(); draw(); }));
  }
  drawTabs();

  api('/prom/metric-names').then((names) => datalist.append(...names.map((n) => h('option', { value: n })))).catch(() => {});

  // query, view, unit, step, env and range live in the URL
  function syncUrl() {
    history.replaceState({}, '', ctx.link('/metrics', { q: input.value.trim(), view: view === 'graph' ? '' : view, unit: unit === 'none' ? '' : unit, step: stepSel === 'auto' ? '' : stepSel }));
  }
  let lastKey = null;
  function runQuiet() { run().catch(() => {}); }
  async function run() {
    const query = input.value.trim();
    if (!query) { clear(out).append(emptyState('Type a PromQL query', 'Or pick one of the example queries below.')); return; }
    if (query !== ctx.pref('metricsQuery')) ctx.savePref('metricsQuery', query);
    syncUrl();
    // a new query shows a placeholder; a refresh of the same query updates in place
    const isNew = query !== lastKey || !last;
    lastKey = query;
    if (isNew) { clear(out).append(h('div', { class: 'chart-box lg skeleton' })); clear(tableBox); }
    try {
      const { start, end } = ctx.range;
      const r = await api('/prom/query_range', { query: { query, start, end, step: stepSel === 'auto' ? undefined : stepSel } });
      last = { query, result: r.result || [], resultType: r.resultType };
      okAt = Date.now(); clear(stale);
      draw();
    } catch (e) {
      if (last && !isNew) clear(stale).append(staleNotice({ okAt, message: e.message, retry: () => ctx.refreshNow() }));
      else { last = null; clear(tableBox); clear(out).append(errorState(e.message, () => ctx.refreshNow(), 'The query failed')); }
      throw e;
    }
  }

  function draw() {
    if (!last) return;
    clear(out);
    clear(tableBox);
    const res = last.result;
    if (!res.length) { out.append(emptyState('No data', 'The query returned no series for this time range.')); return; }
    const series = res.slice(0, 20).map((r) => ({ label: legendName(r.metric), points: r.values }));
    if (view === 'graph') {
      const c = h('canvas');
      clear(legendBox).append(...series.map((s, i) => h('div', { class: 'legend-item', title: s.label }, h('i', { style: { background: PALETTE[i % PALETTE.length] } }), h('span', { class: 'ell' }, s.label))));
      out.append(h('div', { class: 'metrics-graph' }, h('div', { class: 'chart-box lg' }, c), legendBox));
      setChart('main', timeChart(c, series, { unit }));
      if (res.length > 20) out.append(h('div', { class: 'muted', style: { marginTop: '6px' } }, `Showing 20 of ${res.length} series. Narrow the query to see the rest.`));
    }
    // table: rows = time (newest first), columns = series
    const cols = series.slice(0, 8);
    const times = [...new Set(cols.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => b - a).slice(0, view === 'table' ? 200 : 12);
    const maps = cols.map((s) => new Map(s.points.map(([t, v]) => [t, v])));
    const short = (l) => { const m = /\{(.*)\}/.exec(l); return m ? m[1].split(', ').map((x) => x.split('=')[1]?.replace(/"/g, '')).join(' / ') : l; };
    const target = view === 'table' ? out : tableBox;
    target.append(h('div', { class: 'table-wrap', style: { maxHeight: view === 'table' ? '560px' : '320px' } }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Time'), cols.map((s) => h('th', { class: 'num', title: s.label }, short(s.label))))),
      h('tbody', {}, times.map((t) => h('tr', {}, h('td', { class: 'mono ts' }, view === 'table' ? dateTime(t * 1000) : timeHM(t * 1000)), maps.map((m) => h('td', { class: 'num' }, m.has(t) ? fmt(Number(m.get(t)), unit) : h('span', { class: 'dim' }, '—')))))))));
    if (series.length > 8) target.append(h('div', { class: 'muted', style: { marginTop: '6px' } }, 'Table shows the first 8 series.'));
  }

  async function addToDashboard() {
    if (!last) return toast('Run a query first', 'err');
    let dashes = [];
    try { dashes = (await api('/dashboards')).filter((d) => d.editable); } catch (e) { return toast(e.message, 'err'); }
    if (!dashes.length) return toast('Create a custom dashboard first (Dashboards > New Dashboard).', 'err');
    let dashId = dashes[0].id, type = 'line', w = '6';
    const title = h('input', { class: 'input', value: last.query.slice(0, 60) });
    const legend = h('input', { class: 'input', placeholder: 'e.g. {{host}}' });
    modal('Add to dashboard', h('div', {},
      field('Dashboard', select(dashes.map((d) => [d.id, d.title]), dashId, (v) => { dashId = v; })),
      field('Panel title', title),
      h('div', { class: 'form-row' },
        field('Panel type', select([['line', 'Line'], ['area', 'Area'], ['bar', 'Bar (current values)'], ['stat', 'Single number'], ['table', 'Table']], type, (v) => { type = v; })),
        field('Width', select([['4', 'Small (1/3)'], ['6', 'Half'], ['12', 'Full width']], w, (v) => { w = v; }))),
      field('Legend', legend, 'Use {{label}} to show a label value, e.g. {{host}} or {{volume}}.')), [
      { label: 'Cancel' },
      { label: 'Add panel', primary: true, onclick: async () => {
        await api(`/dashboards/${dashId}/panels`, { method: 'POST', body: { title: title.value, type, query: last.query, legend: legend.value, unit: unit === 'none' ? 'none' : unit, w: Number(w) } });
        toast(`Panel added to "${dashes.find((d) => d.id === dashId)?.title || 'the dashboard'}"`);
      } },
    ]);
  }

  const ready = run();
  ready.catch(() => {});
  return { refresh: run, ready };
}
