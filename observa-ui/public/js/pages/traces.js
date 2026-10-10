import { h, api, clear, icon, tabs, fmt, dateTime, palette, color, readableOn, stateView, stateFromError, timeEl, timeHeader } from '../ui.js';

export function tracesPage(main, ctx) {
  const startQ = ctx.params.get('q') ?? ctx.pref('tracesQuery') ?? '';
  const input = h('input', { value: startQ, spellcheck: 'false', placeholder: 'All services, or e.g. service.name=checkout', 'aria-label': 'Trace search', onkeydown: (e) => { if (e.key === 'Enter') run(); } });
  const listBox = h('div');
  const detailBox = h('section', { class: 'panel' });
  let traces = [], selected = null, detailTab = 'timeline', trace = null;

  main.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Traces Explorer'), h('p', {}, 'Search and analyze distributed traces'))),
    h('div', { class: 'query-bar' }, h('div', { class: 'query-input' }, input), h('button', { class: 'btn btn-primary', onclick: run }, 'Search')),
    h('div', { class: 'split' }, listBox, detailBox));

  async function run() {
    const q = input.value.trim();
    if (q !== ctx.pref('tracesQuery')) ctx.savePref('tracesQuery', q);
    history.replaceState({}, '', `/traces?q=${encodeURIComponent(q)}`);
    clear(listBox).append(stateView('loading'));
    try {
      const r = await api('/traces', { query: { query: q, ...ctx.range, limit: 25 } });
      ctx.setDsChip('Tempo', color('ok'));
      traces = r.traces;
      drawList();
      if (traces.length && (!selected || !traces.some((t) => t.traceId === selected))) openTrace(traces[0].traceId);
      if (!traces.length) clear(detailBox).append(stateView('empty', { title: 'No trace selected' }));
    } catch (e) {
      traces = [];
      if (e.state === 'unavailable' || e.status === 502) ctx.setDsChip('Tempo unavailable', color('crit')); else ctx.setDsChip(null);
      clear(listBox).append(h('div', { class: 'table-wrap' }, stateFromError(e, 'Traces')));
      clear(detailBox).append(stateView('empty', { title: 'No trace selected' }));
    }
  }

  function drawList() {
    clear(listBox);
    if (!traces.length) { listBox.append(h('div', { class: 'table-wrap' }, stateView('empty', { title: 'No traces available', text: 'Tempo answered, but has no traces for this search and time range. Try another service name or a wider time range.' }))); return; }
    listBox.append(h('div', { class: 'table-wrap', style: { maxHeight: 'calc(100vh - 230px)' } }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Trace ID'), h('th', { class: 'num' }, 'Duration'), h('th', {}, 'Service'), h('th', {}, timeHeader('Started')), h('th', {}, 'Status'))),
      h('tbody', {}, traces.map((t) => h('tr', { class: `clickable ${t.traceId === selected ? 'sel' : ''}`, onclick: () => openTrace(t.traceId) },
        h('td', { class: 'mono trace-id' }, t.traceId.slice(0, 12)),
        h('td', { class: `num ${t.durationMs > 2000 ? 'c-red' : t.durationMs > 1000 ? 'c-orange' : ''}` }, fmt(t.durationMs, 'ms')),
        h('td', {}, t.rootService),
        h('td', { class: 'dim', style: { fontSize: '12px' } }, timeEl(t.startMs, dateTime(t.startMs).slice(11))),
        h('td', {}, h('i', { class: `dot ${t.error === null ? 'dot-muted' : t.error ? 'dot-red' : 'dot-green'}`, title: t.error === null ? 'Unknown' : t.error ? 'Error' : 'OK' }))))))));
  }

  async function openTrace(id) {
    selected = id;
    drawList();
    clear(detailBox).append(stateView('loading'));
    try {
      trace = await api(`/traces/${id}`);
      drawDetail();
    } catch (e) {
      clear(detailBox).append(stateFromError(e, 'Trace'));
    }
  }

  function drawDetail() {
    const services = [...new Set(trace.spans.map((s) => s.service))];
    const pal = palette();
    const svcColor = (svc) => pal[services.indexOf(svc) % pal.length];
    clear(detailBox).append(
      h('div', { class: 'panel-head' }, h('h3', {}, 'Trace Details'), h('span', { class: 'mono dim', style: { fontSize: '11.5px' } }, trace.traceId),
        h('div', { class: 'right' }, trace.error ? h('span', { class: 'pill pill-red' }, 'Error') : h('span', { class: 'pill pill-green' }, 'OK'), h('span', { class: 'pill pill-muted' }, fmt(trace.durationMs, 'ms')))),
      h('div', { style: { marginBottom: '14px' } }, tabs([['timeline', 'Timeline'], ['spans', 'Spans'], ['map', 'Service Map']], detailTab, (k) => { detailTab = k; drawDetail(); })));

    if (detailTab === 'timeline') {
      const depth = depthMap(trace.spans);
      const total = trace.durationMs || 1;
      const rows = orderTree(trace.spans);
      detailBox.append(h('div', { class: 'wf' }, rows.map((s) => {
        const left = ((s.startMs - trace.startMs) / total) * 100;
        const width = Math.max(0.6, (s.durationMs / total) * 100);
        const barBg = s.error ? color('crit') : svcColor(s.service);
        return h('div', { class: 'wf-row', title: `${s.service}: ${s.name} (${fmt(s.durationMs, 'ms')})${s.statusMessage ? ` - ${s.statusMessage}` : ''}` },
          h('div', { class: 'wf-name', style: { paddingLeft: `${depth.get(s.spanId) * 14}px` } }, h('i', { class: 'dot', style: { background: svcColor(s.service) } }), h('span', {}, s.service), h('span', { class: 'dim' }, s.name)),
          h('div', { class: 'wf-track' }, h('div', { class: `wf-bar ${s.error ? 'err' : ''}`, style: { left: `${left}%`, width: `${width}%`, background: barBg, color: readableOn(barBg) } }, width > 12 ? fmt(s.durationMs, 'ms') : '')));
      })),
      h('div', { class: 'wf-axis' }, h('span'), h('div', { class: 'ticks' }, [0, 0.25, 0.5, 0.75, 1].map((f) => h('span', {}, fmt(total * f, 'ms'))))));
    } else if (detailTab === 'spans') {
      detailBox.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Service'), h('th', {}, 'Operation'), h('th', { class: 'num' }, 'Start'), h('th', { class: 'num' }, 'Duration'), h('th', {}, 'Status'))),
        h('tbody', {}, orderTree(trace.spans).map((s) => h('tr', {},
          h('td', {}, h('i', { class: 'dot', style: { background: svcColor(s.service), marginRight: '6px' } }), s.service),
          h('td', { class: 'mono', style: { fontSize: '12px' } }, s.name),
          h('td', { class: 'num' }, `+${fmt(s.startMs - trace.startMs, 'ms')}`),
          h('td', { class: 'num' }, fmt(s.durationMs, 'ms')),
          h('td', {}, s.error ? h('span', { class: 'pill pill-red', title: s.statusMessage || '' }, 'Error') : h('span', { class: 'pill pill-green' }, 'OK'))))))));
    } else {
      detailBox.append(serviceMap(trace.spans, svcColor));
    }
  }

  run();
  return { refresh: run, autoRefresh: false };
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
function serviceMap(spans, svcColor) {
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
  mk('defs', {}).innerHTML = `<marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="${color('chart-tick')}"/></marker>`;
  for (const [k, n] of edges) {
    const [a, b] = k.split('>');
    const p1 = pos.get(a), p2 = pos.get(b);
    const x1 = p1.x + nodeW, y1 = p1.y + nodeH / 2, x2 = p2.x, y2 = p2.y + nodeH / 2;
    mk('path', { d: `M${x1} ${y1} C${x1 + 30} ${y1}, ${x2 - 30} ${y2}, ${x2 - 2} ${y2}`, stroke: color('chart-tick'), 'stroke-width': 1.5, fill: 'none', 'marker-end': 'url(#arr)' });
    mk('text', { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 6, fill: color('chart-tick'), 'font-size': 10, 'text-anchor': 'middle' }, `${n} call${n > 1 ? 's' : ''}`);
  }
  for (const [svc, p] of pos) {
    const err = spans.some((s) => s.service === svc && s.error);
    mk('rect', { x: p.x, y: p.y, width: nodeW, height: nodeH, rx: 8, fill: color('panel-2'), stroke: err ? color('crit') : svcColor(svc), 'stroke-width': 1.6 });
    mk('circle', { cx: p.x + 14, cy: p.y + nodeH / 2, r: 5, fill: svcColor(svc) });
    mk('text', { x: p.x + 26, y: p.y + nodeH / 2 + 4, fill: color('text'), 'font-size': 12 }, svc.length > 16 ? `${svc.slice(0, 15)}…` : svc);
  }
  return h('div', {}, svg, h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } }, 'Arrows show which service called which in this trace. Red border = errors in that service.'));
}
