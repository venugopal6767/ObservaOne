import { h, api, clear, icon, emptyState, demoBadge, tabs, fmt, dateTime, PALETTE } from '../ui.js';
import { errorState, staleNotice } from '../personas/widgets.js';

const skel = (cls, height) => h('div', { class: `${cls} skeleton`, style: { height } });
import { openLog } from './logs.js';
import { levelPill } from './overview.js';

export function tracesPage(main, ctx) {
  if (ctx.params.get('id')) { ctx.navigate(ctx.link(`/traces/${ctx.params.get('id')}`, { id: '' }), true); return {}; }
  const startQ = ctx.params.get('q') ?? ctx.pref('tracesQuery') ?? '';
  const input = h('input', { value: startQ, spellcheck: 'false', placeholder: 'service.name=payment-service   (empty = all services)', 'aria-label': 'Trace search', onkeydown: (e) => { if (e.key === 'Enter') runQuiet(); } });
  const listBox = h('div');
  const stale = h('div');
  let shown = false, okAt = 0, lastQ = null;
  const titleBadge = h('span');
  main.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Traces', titleBadge), h('p', {}, 'Distributed traces and request flows.'))),
    h('div', { class: 'query-bar' }, h('div', { class: 'query-input' }, input), h('button', { class: 'btn btn-primary', onclick: runQuiet }, 'Search')),
    stale, listBox);

  function runQuiet() { run().catch(() => {}); }
  async function run() {
    const q = input.value.trim();
    if (q !== ctx.pref('tracesQuery')) ctx.savePref('tracesQuery', q);
    // query, env and range live in the URL
    history.replaceState({}, '', ctx.link('/traces', { q }));
    const isNew = q !== lastQ || !shown;
    lastQ = q;
    if (isNew) clear(listBox).append(skel('table-wrap', '420px'));
    try {
      const r = await api('/traces', { query: { query: q, ...ctx.range, limit: 50 } });
      shown = true; okAt = Date.now(); clear(stale);
      ctx.setDsChip(r.demo ? 'OpenTelemetry (demo)' : 'Tempo', r.demo ? '#f59e0b' : '#22c55e');
      clear(titleBadge).append(demoBadge(r.demo) || '');
      clear(listBox);
      if (!r.traces.length) { listBox.append(h('div', { class: 'table-wrap' }, emptyState('No traces found', 'Try another service name or a wider time range.'))); return; }
      listBox.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['Trace ID', 'Start Time', 'Service', 'Operation', 'Spans', 'Duration', 'Status'].map((x, k) => h('th', { class: `${k === 5 ? 'num' : ''} ${[1, 3, 4].includes(k) ? 'col-phone-hide' : ''}` }, x)))),
        h('tbody', {}, r.traces.map((t) => {
          const st = t.error ? ['Error', 'st-err'] : t.durationMs > 1000 ? ['Slow', 'st-slow'] : t.error === null ? ['—', 'st-res'] : ['OK', 'st-ok'];
          return h('tr', { class: 'clickable', onclick: () => ctx.navigate(ctx.link(`/traces/${t.traceId}`)) },
            h('td', { class: 'mono c-link' }, t.traceId.slice(0, 12)),
            h('td', { class: 'dim col-phone-hide' }, dateTime(t.startMs).slice(11)),
            h('td', {}, t.rootService),
            h('td', { class: 'mono dim col-phone-hide', style: { fontSize: '12px' } }, t.rootName || '—'),
            h('td', { class: 'col-phone-hide' }, t.spanCount ?? '—'),
            h('td', { class: `num ${t.durationMs > 2000 ? 'c-red' : t.durationMs > 1000 ? 'c-orange' : ''}` }, fmt(t.durationMs, 'ms')),
            h('td', {}, h('span', { class: `pill ${st[1]}` }, st[0])));
        })))));
    } catch (e) {
      if (shown && !isNew) clear(stale).append(staleNotice({ okAt, message: e.message, retry: () => ctx.refreshNow() }));
      else { shown = false; clear(listBox).append(errorState(e.message, () => ctx.refreshNow(), 'Traces could not load')); }
      throw e;
    }
  }
  const ready = run();
  ready.catch(() => {});
  return { refresh: run, autoRefresh: false, ready };
}

// ---------------- trace detail ----------------
export function traceDetailPage(main, ctx) {
  const id = location.pathname.split('/')[2];
  let tab = ctx.params.get('tab') || 'timeline', trace = null;
  const head = h('div', { class: 'detail-head' });
  const cards = h('div', { class: 'grid cards-4', style: { marginBottom: '14px' } });
  const tabsEl = h('div', { class: 'tabs-line' });
  const body = h('section', { class: 'panel' }, skel('chart-box', '300px'));
  const back = () => h('a', { class: 'back', href: ctx.link('/traces'), 'data-link': true, 'aria-label': 'Back to Traces', title: 'Back to Traces' }, icon('back', 16));
  clear(head).append(back(), h('h1', {}, `Trace ${id.slice(0, 12)}…`));
  main.append(head, tabsEl, cards, body);

  async function load() {
    try {
      trace = await api(`/traces/${id}`);
      draw();
    } catch (e) {
      clear(body).append(errorState(e.message, () => { clear(body).append(skel('chart-box', '300px')); load().catch(() => {}); }, 'This trace could not load'));
      throw e;
    }
  }

  function draw() {
    const services = [...new Set(trace.spans.map((x) => x.service))];
    const color = (svc) => PALETTE[services.indexOf(svc) % PALETTE.length];
    clear(head).append(
      back(),
      h('div', {}, h('h1', {}, `Trace ${trace.traceId.slice(0, 12)}…`, ' ', h('span', { class: `pill ${trace.error ? 'st-err' : 'st-ok'}` }, trace.error ? 'Error' : 'OK'), ' ', demoBadge(trace.demo, true)),
        h('div', { class: 'detail-meta' }, h('span', { class: 'mono dim' }, trace.traceId), h('span', {}, dateTime(trace.startMs)),
          trace.spans[0]?.service ? h('a', { href: ctx.link(`/services/${encodeURIComponent(trace.spans[0].service)}`), 'data-link': true }, trace.spans[0].service) : null)));
    const card = (label, value, tone) => h('div', { class: 'kpi kpi-small' }, h('div', { class: 'kpi-top' }, h('span', { class: 'kpi-title' }, label)), h('div', { class: 'kpi-val' }, h('b', { class: tone || '' }, value)));
    clear(cards).append(card('Duration', fmt(trace.durationMs, 'ms')), card('Services', String(services.length)), card('Spans', String(trace.spans.length)),
      card('Status', trace.error ? 'Error' : 'OK', trace.error ? 'c-red' : 'c-green'));
    clear(tabsEl).append(tabs([['timeline', 'Timeline'], ['spans', 'Spans'], ['logs', 'Logs'], ['metrics', 'Metrics'], ['map', 'Service Map']], tab, (k) => {
      tab = k; history.replaceState({}, '', ctx.link(`/traces/${id}`, { tab: k === 'timeline' ? '' : k })); draw();
    }));
    clear(body);
    if (tab === 'timeline') {
      const depth = depthMap(trace.spans);
      const total = trace.durationMs || 1;
      body.append(h('div', { class: 'wf' }, orderTree(trace.spans).map((x) => {
        const left = ((x.startMs - trace.startMs) / total) * 100;
        const width = Math.max(0.6, (x.durationMs / total) * 100);
        return h('div', { class: 'wf-row', title: `${x.service}: ${x.name} (${fmt(x.durationMs, 'ms')})${x.statusMessage ? ` - ${x.statusMessage}` : ''}` },
          h('div', { class: 'wf-name', style: { paddingLeft: `${depth.get(x.spanId) * 14}px` } }, h('i', { class: 'dot', style: { background: color(x.service) } }), h('span', {}, x.service), h('span', { class: 'dim' }, x.name)),
          h('div', { class: 'wf-track' }, h('div', { class: `wf-bar ${x.error ? 'err' : ''}`, style: { left: `${left}%`, width: `${width}%`, background: x.error ? '#ef4444' : color(x.service) } }, width > 12 ? fmt(x.durationMs, 'ms') : '')));
      })), h('div', { class: 'wf-axis' }, h('span'), h('div', { class: 'ticks' }, [0, 0.25, 0.5, 0.75, 1].map((f) => h('span', {}, fmt(total * f, 'ms'))))));
    } else if (tab === 'spans') {
      body.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Service'), h('th', {}, 'Operation'), h('th', { class: 'num' }, 'Start'), h('th', { class: 'num' }, 'Duration'), h('th', {}, 'Status'))),
        h('tbody', {}, orderTree(trace.spans).map((x) => h('tr', {},
          h('td', {}, h('i', { class: 'dot', style: { background: color(x.service), marginRight: '6px' } }), h('a', { href: ctx.link(`/services/${encodeURIComponent(x.service)}`), 'data-link': true }, x.service)),
          h('td', { class: 'mono', style: { fontSize: '12px' } }, x.name),
          h('td', { class: 'num' }, `+${fmt(x.startMs - trace.startMs, 'ms')}`),
          h('td', { class: 'num' }, fmt(x.durationMs, 'ms')),
          h('td', {}, x.error ? h('span', { class: 'pill st-err', title: x.statusMessage || '' }, 'Error') : h('span', { class: 'pill st-ok' }, 'OK'))))))));
    } else if (tab === 'logs') {
      body.append(skel('table-wrap', '240px'));
      const s = Math.floor(trace.startMs / 1000) - 60, e = Math.ceil((trace.startMs + trace.durationMs) / 1000) + 60;
      const sel = services.length === 1 ? `{service_name="${services[0]}"}` : `{service_name=~"${services.map((x) => x.replace(/[^\w.-]/g, '')).join('|')}"}`;
      api('/logs', { query: { query: sel, start: s, end: e, limit: 200 } }).then((r) => {
        const mine = r.entries.filter((x) => x.traceId === trace.traceId || (x.message || '').includes(trace.traceId));
        const rows = mine.length ? mine : r.entries.slice(0, 50);
        clear(body).append(h('p', { class: 'muted', style: { marginTop: 0 } }, mine.length ? `${mine.length} line(s) carry this trace ID.` : 'No line carries this trace ID; showing logs from these services around the time of the trace.'),
          rows.length ? h('table', { class: 'tbl' }, h('tbody', {}, rows.map((x) => h('tr', { class: 'clickable', onclick: () => openLog(ctx, x) },
            h('td', { class: 'mono dim', style: { whiteSpace: 'nowrap' } }, dateTime(x.ts).slice(11)), h('td', {}, levelPill(x.level)), h('td', {}, x.service), h('td', { class: 'msg' }, x.message)))))
            : emptyState('No logs around this trace'));
      }).catch((err) => clear(body).append(errorState(err.message, () => draw(), 'Logs for this trace could not load')));
    } else if (tab === 'metrics') {
      body.append(h('p', { class: 'muted', style: { marginTop: 0 } }, 'Health of each service in this trace right now:'),
        h('div', { class: 'dep-list' }, services.map((svc) => h('a', { class: 'dep', href: ctx.link(`/services/${encodeURIComponent(svc)}`, { tab: 'metrics' }), 'data-link': true },
          h('i', { class: 'dot', style: { background: color(svc) } }), h('b', {}, svc),
          h('span', { class: 'dim' }, `${trace.spans.filter((x) => x.service === svc).length} span(s), ${fmt(trace.spans.filter((x) => x.service === svc).reduce((a, x) => a + x.durationMs, 0), 'ms')} total`),
          icon('arrowRight', 13)))));
    } else {
      body.append(serviceMap(trace.spans, color));
    }
  }
  const ready = load();
  ready.catch(() => {});
  return { ready };
}

function depthMap(spans) {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const d = new Map();
  const depth = (s) => {
    if (d.has(s.spanId)) return d.get(s.spanId);
    const p = s.parentId && byId.get(s.parentId);
    const v = p ? depth(p) + 1 : 0;
    d.set(s.spanId, v);
    return v;
  };
  spans.forEach(depth);
  return d;
}

function orderTree(spans) {
  const kids = new Map();
  const ids = new Set(spans.map((s) => s.spanId));
  for (const s of spans) {
    const p = s.parentId && ids.has(s.parentId) ? s.parentId : null;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(s);
  }
  const out = [];
  const walk = (p) => (kids.get(p) || []).sort((a, b) => a.startMs - b.startMs).forEach((s) => { out.push(s); walk(s.spanId); });
  walk(null);
  return out;
}

// Simple left-to-right service call graph drawn as SVG.
function serviceMap(spans, color) {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const edges = new Map();
  const level = new Map();
  const roots = spans.filter((s) => !s.parentId || !byId.has(s.parentId));
  roots.forEach((r) => level.set(r.service, 0));
  for (const s of spans) {
    const p = s.parentId && byId.get(s.parentId);
    if (p && p.service !== s.service) {
      const k = `${p.service}>${s.service}`;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const k of edges.keys()) {
      const [a, b] = k.split('>');
      const want = (level.get(a) ?? 0) + 1;
      if ((level.get(b) ?? -1) < want && want < 10) { level.set(b, want); changed = true; }
    }
  }
  [...new Set(spans.map((s) => s.service))].forEach((s) => !level.has(s) && level.set(s, 0));
  const cols = new Map();
  for (const [svc, l] of level) { if (!cols.has(l)) cols.set(l, []); cols.get(l).push(svc); }
  const W = 640, colW = 170, rowH = 70, nodeW = 140, nodeH = 36;
  const maxRows = Math.max(...[...cols.values()].map((c) => c.length));
  const H = Math.max(140, maxRows * rowH + 30);
  const pos = new Map();
  for (const [l, list] of cols) list.forEach((svc, i) => pos.set(svc, { x: 20 + l * colW, y: (H - list.length * rowH) / 2 + i * rowH + 15 }));
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${Math.max(W, (cols.size) * colW + 40)} ${H}`);
  svg.setAttribute('width', '100%');
  svg.style.maxHeight = '360px';
  const mk = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text) e.textContent = text; svg.append(e); return e; };
  mk('defs', {}).innerHTML = '<marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#5c6a86"/></marker>';
  for (const [k, n] of edges) {
    const [a, b] = k.split('>');
    const p1 = pos.get(a), p2 = pos.get(b);
    const x1 = p1.x + nodeW, y1 = p1.y + nodeH / 2, x2 = p2.x, y2 = p2.y + nodeH / 2;
    mk('path', { d: `M${x1} ${y1} C${x1 + 30} ${y1}, ${x2 - 30} ${y2}, ${x2 - 2} ${y2}`, stroke: '#5c6a86', 'stroke-width': 1.5, fill: 'none', 'marker-end': 'url(#arr)' });
    mk('text', { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 6, fill: '#8291ad', 'font-size': 10, 'text-anchor': 'middle' }, `${n} call${n > 1 ? 's' : ''}`);
  }
  for (const [svc, p] of pos) {
    const err = spans.some((s) => s.service === svc && s.error);
    mk('rect', { x: p.x, y: p.y, width: nodeW, height: nodeH, rx: 8, fill: 'var(--panel-2)', stroke: err ? '#ef4444' : color(svc), 'stroke-width': 1.6 });
    mk('circle', { cx: p.x + 14, cy: p.y + nodeH / 2, r: 5, fill: color(svc) });
    mk('text', { x: p.x + 26, y: p.y + nodeH / 2 + 4, fill: 'var(--text)', 'font-size': 12 }, svc.length > 16 ? `${svc.slice(0, 15)}…` : svc);
  }
  return h('div', {}, svg, h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } }, 'Arrows show which service called which in this trace. Red border = errors in that service.'));
}
