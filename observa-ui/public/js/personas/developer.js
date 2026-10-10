// Developer: "are my services healthy, and where is the code failing or slow?"
// Errors first, then latency, then the endpoints and traces behind them. Sample data for now.
import { h, clear, icon, fmt, dateTime, emptyState, toast } from '../ui.js';
import { chartSlots } from '../pages/common.js';
import { mockFetch, SERVICES, TEAMS } from './mock.js';
import { developerData, serviceDetail, endpointDetail, errorDetail, traceDetail } from './mock-dev.js';
import { personaById } from './registry.js';
import {
  personaHead, filterBar, kpiCard, delta, panel, chartBox, lineDrill, table, quickActions,
  loadingSkeleton, errorState, since, detailHead, miniStat, linkBtn, detailPage, barCats,
  attentionStrip, stampFresh,
  notConnected, NEEDS,
} from './widgets.js';

const persona = { ...personaById('developer'), title: 'Developer' };
const KEYS = ['team', 'service'];
const BASE = '/views/developer';
const readF = (ctx) => Object.fromEntries(KEYS.map((k) => [k, ctx.params.get(k) || '']));
const args = (ctx, f = {}) => { const { start, end } = ctx.range; return { env: ctx.env, start, end, ...f }; };
const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);
const errTone = (v) => (v >= 2 ? 'c-red' : v >= 1 ? 'c-orange' : 'c-green');
const pct = (v) => `${v.toFixed(2)}%`;
const shortType = (t) => (t.length > 46 ? `${t.slice(0, 44)}…` : t);
const back = (ctx, f) => linkBtn(ctx.link(BASE, f), 'arrowLeft', 'Developer dashboard');
const versionTag = (v) => h('code', { class: 'ver' }, v);

// ======================= dashboard =======================
export function developerDashboard(main, ctx) {
  const setChart = chartSlots(ctx);
  const f = readF(ctx);
  const filters = h('div');
  const body = h('div');
  main.append(personaHead(ctx, persona, {
    actions: [linkBtn(ctx.link('/logs', { q: `{service_name=~"${f.service || '.+'}"} |= "ERROR"` }), 'logs', 'My error logs')],
  }), filters, body);

  const defs = () => [
    { key: 'team', label: 'All teams', options: TEAMS.map((t) => [t, t]) },
    { key: 'service', label: 'All services', options: SERVICES.filter((s) => !f.team || s.team === f.team).map((s) => [s.name, s.name]) },
  ];

  async function refresh(silent = false) {
    clear(filters).append(filterBar(ctx, defs(), f, () => refresh()));
    if (!silent) clear(body).append(loadingSkeleton(6));
    let d;
    try { d = await mockFetch((empty) => developerData({ ...args(ctx, f), empty })); } catch (e) { clear(body).append(errorState(e.message, () => refresh())); return; }
    draw(d);
    stampFresh();
  }

  function draw(d) {
    clear(body);
    if (!d.services.length) {
      body.append(h('div', { class: 'state-box' }, emptyState('No services match', 'Pick another team or service, or clear the filters.', linkBtn(ctx.link(BASE), 'x', 'Clear filters', 'btn btn-primary'))));
      return;
    }
    const k = d.kpi;
    const L = (path, extra = {}) => ctx.link(path, { ...f, ...extra });
    const newErr = d.errors.filter((e) => e.isNew);
    const hot = d.services.filter((s) => s.errorRate >= 2).sort((a, b) => b.errorRate - a.errorRate);
    const slow = d.endpoints.filter((x) => x.p95 > 1000).sort((a, b) => b.p95 - a.p95);
    const regressed = d.services.filter((s) => s.errorRate > s.prevErrorRate * 1.5 && s.errorRate > 0.5);
    body.append(attentionStrip([
      hot.length && { level: 'critical', text: `${hot[0].name} fails ${hot[0].errorRate.toFixed(1)}% of requests`, detail: hot.length > 1 ? `and ${hot.length - 1} more service${hot.length > 2 ? 's' : ''} above 2%` : 'above the 2% line', action: { label: 'Open service', href: L(`/views/developer/services/${hot[0].name}`) } },
      newErr.length && { level: 'warning', text: `New error: ${newErr[0].type.length > 40 ? `${newErr[0].type.slice(0, 38)}…` : newErr[0].type}`, detail: `${newErr[0].service} · first seen ${since(newErr[0].firstSeen)}`, action: { label: 'See stack trace', href: L(`/views/developer/errors/${newErr[0].id}`) } },
      regressed.length && { level: 'warning', text: `${regressed[0].name} ${regressed[0].version} has more errors than ${regressed[0].previous}`, detail: `${regressed[0].prevErrorRate.toFixed(2)}% → ${regressed[0].errorRate.toFixed(2)}%`, action: { label: 'Compare versions', href: L(`/views/developer/services/${regressed[0].name}`, { tab: 'versions' }) } },
      slow.length && { level: 'warning', text: `${slow[0].route} takes ${ms(slow[0].p95)} (P95)`, detail: slow[0].service, action: { label: 'Slow traces', href: L(`/views/developer/endpoints/${slow[0].id}`) } },
    ]));
    body.append(h('div', { class: 'ov-kpis persona-kpis-6' },
      kpiCard(setChart, { key: 'rps', ic: 'activity', tone: 'blue', title: 'Requests', value: fmt(k.rps, 'none', k.rps < 100 ? 1 : 0), unit: 'req/s', href: '#dev-services', spark: d.series.rps, sparkColor: '#3b82f6',
        foot: [h('span', { class: 'dim' }, `${d.services.length} service${d.services.length > 1 ? 's' : ''}`)] }),
      kpiCard(setChart, { key: 'err', ic: 'alert', tone: k.errorRate >= 1 ? 'red' : 'green', title: 'Error rate', value: k.errorRate.toFixed(2), unit: '%', href: '#dev-errors', spark: d.series.err, sparkColor: '#ef4444',
        delta: delta(k.errorRate, k.prevErrorRate, { goodWhenUp: false, pct: true }), foot: [h('span', { class: 'dim' }, 'vs previous version')] }),
      kpiCard(setChart, { key: 'p95', ic: 'timer', tone: 'purple', title: 'P95 latency', value: String(Math.round(k.p95)), unit: 'ms', href: '#dev-endpoints', spark: d.series.p95, sparkColor: '#a855f7',
        delta: delta(k.p95, k.prevP95, { goodWhenUp: false, pct: true }), foot: [h('span', { class: 'dim' }, 'all endpoints, weighted')] }),
      kpiCard(setChart, { key: 'ev', ic: 'incident', tone: 'orange', title: 'Error events', value: fmt(k.errorEvents, 'short', 1), href: '#dev-errors',
        foot: [h('span', { class: k.newErrors ? 'c-red' : 'dim' }, `${k.newErrors} new in 24 h`), h('span', { class: 'dim' }, `${d.errors.length} groups`)] }),
      kpiCard(setChart, { key: 'slow', ic: 'clock', tone: 'orange', title: 'Slowest endpoint', value: k.slowest ? ms(k.slowest.p95) : '-', href: k.slowest ? L(`${BASE}/endpoints/${k.slowest.id}`) : '#',
        foot: k.slowest ? [h('span', { class: 'dim mono-cut' }, `${k.slowest.service} ${k.slowest.route}`)] : [] }),
      kpiCard(setChart, { key: 'apdex', ic: 'check', tone: k.apdex >= 0.9 ? 'green' : 'orange', title: 'Apdex', value: k.apdex.toFixed(2), href: '#dev-services',
        foot: [h('span', { class: 'dim' }, k.apdex >= 0.94 ? 'users are satisfied' : k.apdex >= 0.85 ? 'some users wait' : 'users are frustrated')] })));

    // latency (click a point -> traces at that time) + errors by service (click -> service)
    const lat = chartBox(240), ebs = chartBox(240);
    const bySvc = [...d.services].sort((a, b) => b.errorRate - a.errorRate);
    body.append(h('div', { class: 'ov-row persona-row-2' },
      panel('Latency', 'timer', h('div', {}, lat.el, h('div', { class: 'dim chart-hint' }, 'Click the chart to find slow traces from that moment'))),
      panel('Error rate by service', 'alert', h('div', {}, ebs.el, h('div', { class: 'dim chart-hint' }, 'Click a bar to open the service')))));
    setChart('lat', lineDrill(lat.canvas, [
      { label: 'p50', points: d.series.p50, color: '#22c55e' }, { label: 'p95', points: d.series.p95, color: '#a855f7' }, { label: 'p99', points: d.series.p99, color: '#f59e0b' },
    ], { unit: 'ms', onPick: (pt) => ctx.navigate(ctx.link('/traces', { q: f.service ? `service.name=${f.service}` : '', minDuration: '500ms', at: pt[0] })) }));
    setChart('ebs', barCats(ebs.canvas, bySvc.map((s) => s.name), bySvc.map((s) => Number(s.errorRate.toFixed(2))), {
      unit: 'none', colors: bySvc.map((s) => (s.errorRate >= 2 ? '#ef4444' : s.errorRate >= 1 ? '#f59e0b' : '#22c55e')), horizontal: true,
      onPick: (i) => ctx.navigate(L(`${BASE}/services/${bySvc[i].name}`)),
    }));

    // top errors + slowest endpoints
    const errs = panel('Top errors', 'incident', table([
      { label: 'Error', value: (e) => h('div', { class: 'err-cell' }, h('b', { class: 'mono' }, shortType(e.type)), h('div', { class: 'dim' }, e.message.slice(0, 80))) },
      { label: 'Service', value: (e) => e.service },
      { label: 'Events', value: (e) => fmt(e.count, 'short', 1), num: true },
      { minor: true, label: 'Users', value: (e) => String(e.users), num: true },
      { minor: true, label: 'Last seen', value: (e) => h('span', { class: 'dim' }, since(e.lastSeen)) },
      { label: '', value: (e) => (e.isNew ? h('span', { class: 'pill st-err' }, 'New') : '') },
    ], d.errors, { max: 6, onRow: (e) => ctx.navigate(L(`${BASE}/errors/${e.id}`)), empty: ['No errors', 'Nothing failed in this period.'] }));
    errs.id = 'dev-errors';
    const eps = panel('Slowest endpoints', 'clock', table([
      { label: 'Endpoint', value: (x) => h('div', {}, h('b', { class: 'mono' }, x.route), h('div', { class: 'dim', style: { fontSize: '11px' } }, x.service)) },
      { label: 'P95', value: (x) => ms(x.p95), num: true },
      { label: 'Req/s', value: (x) => x.rps.toFixed(1), num: true },
      { label: 'Errors', value: (x) => h('span', { class: errTone(x.errorRate) }, pct(x.errorRate)), num: true },
    ], [...d.endpoints].sort((a, b) => b.p95 - a.p95), { max: 6, onRow: (x) => ctx.navigate(L(`${BASE}/endpoints/${x.id}`)) }));
    eps.id = 'dev-endpoints';
    body.append(h('div', { class: 'ov-row persona-row-2b' }, errs, eps));

    // my services + quick actions
    const svcs = panel('Services', 'cube', table([
      { label: 'Service', value: (s) => h('div', {}, h('b', {}, s.name), h('div', { class: 'dim', style: { fontSize: '11px' } }, `${s.lang} · ${s.team}`)) },
      { label: 'Version', value: (s) => versionTag(s.version) },
      { label: 'Req/s', value: (s) => s.rps.toFixed(1), num: true },
      { label: 'Errors', value: (s) => h('span', { class: errTone(s.errorRate) }, pct(s.errorRate)), num: true },
      { label: 'P95', value: (s) => ms(s.p95), num: true },
      { label: 'Deployed', value: (s) => h('span', { class: 'dim' }, since(s.lastDeployAt)) },
    ], d.services, { onRow: (s) => ctx.navigate(L(`${BASE}/services/${s.name}`)) }));
    svcs.id = 'dev-services';
    const top = d.services[0];
    body.append(h('div', { class: 'ov-row persona-row-2b' }, svcs,
      panel('Quick actions', 'activity', quickActions([
        { ic: 'logs', label: 'Search error logs', sub: f.service || 'all my services', href: ctx.link('/logs', { q: `{service_name=~"${f.service || '.+'}"} |= "ERROR"` }) },
        { ic: 'traces', label: 'Find slow traces', sub: 'slower than 500 ms', href: ctx.link('/traces', { q: f.service ? `service.name=${f.service}` : '', minDuration: '500ms' }) },
        { ic: 'refresh', label: 'Compare versions', sub: `${top.name} ${top.version} vs ${top.previous}`, href: L(`${BASE}/services/${top.name}`, { tab: 'versions' }) },
        { ic: 'metrics', label: 'Explore metrics', sub: 'Build a custom chart', href: ctx.link('/metrics') },
        { ic: 'dashboards', label: 'Save as my dashboard', sub: 'Copy panels you like', href: ctx.link('/dashboards') },
      ]))));
  }

  refresh();
  return { refresh: () => refresh(true) };
}

// ======================= service =======================
export function developerService(main, ctx) {
  const setChart = chartSlots(ctx);
  const name = decodeURIComponent(location.pathname.split('/').pop());
  const f = readF(ctx);
  return detailPage(main, {
    load: () => mockFetch(() => serviceDetail(args(ctx), name)),
    notFound: ['Service not found', `There is no service called "${name}".`, back(ctx, f)],
    render(body, d) {
      const s = d.svc;
      const L = (path, extra = {}) => ctx.link(path, { ...f, ...extra });
      const charts = { rps: chartBox(200), err: chartBox(200), lat: chartBox(200) };
      const verErr = s.errorRate - s.prevErrorRate, verLat = s.p95 - s.prevP95;
      body.append(
        detailHead('cube', 'Service', [s.name, ' ', versionTag(s.version)], `${s.lang} · team ${s.team} · tier ${s.tier} · deployed ${since(s.lastDeployAt)}`, [
          back(ctx, f),
          linkBtn(ctx.link('/logs', { q: `{service_name="${s.name}"}` }), 'logs', 'Logs'),
          linkBtn(ctx.link('/traces', { q: `service.name=${s.name}` }), 'traces', 'Traces'),
        ]),
        h('div', { class: 'grid cards-4', style: { marginBottom: '14px' } },
          miniStat('Requests', `${s.rps.toFixed(1)} req/s`),
          miniStat('Error rate', pct(s.errorRate), `was ${pct(s.prevErrorRate)} on ${s.previous}`, errTone(s.errorRate)),
          miniStat('P95 latency', ms(s.p95), `p50 ${ms(s.p50)}`),
          miniStat('Apdex', s.apdex.toFixed(2), s.apdex >= 0.9 ? 'good' : 'needs work')),
        h('div', { class: 'grid cols-3' },
          panel('Requests per second', 'activity', charts.rps.el),
          panel('Error rate %', 'alert', charts.err.el),
          panel('Latency', 'timer', charts.lat.el)),
        h('div', { class: 'ov-row persona-row-2b' },
          panel('Endpoints', 'list', table([
            { label: 'Endpoint', value: (x) => h('b', { class: 'mono' }, x.route) },
            { label: 'Req/s', value: (x) => x.rps.toFixed(1), num: true },
            { label: 'P95', value: (x) => ms(x.p95), num: true },
            { label: 'Errors', value: (x) => h('span', { class: errTone(x.errorRate) }, pct(x.errorRate)), num: true },
          ], d.endpoints, { onRow: (x) => ctx.navigate(L(`${BASE}/endpoints/${x.id}`)) })),
          panel('Calls to other services', 'services', table([
            { label: 'Dependency', value: (x) => h('b', {}, x.name) },
            { label: 'Calls / request', value: (x) => String(x.calls), num: true },
            { label: 'P95', value: (x) => ms(x.p95), num: true },
            { label: 'Errors', value: (x) => h('span', { class: errTone(x.errorRate) }, pct(x.errorRate)), num: true },
          ], s.deps, { onRow: (x) => (SERVICES.some((y) => y.name === x.name) ? ctx.navigate(L(`${BASE}/services/${x.name}`)) : toast(`${x.name} is a database or cache, not a service`)) }))),
        h('div', { class: 'ov-row persona-row-2b', id: 'versions' },
          panel('Errors in this service', 'incident', table([
            { label: 'Error', value: (e) => h('b', { class: 'mono' }, shortType(e.type)) },
            { label: 'Endpoint', value: (e) => h('span', { class: 'mono dim' }, e.endpoint) },
            { label: 'Events', value: (e) => fmt(e.count, 'short', 1), num: true },
            { label: 'Last seen', value: (e) => h('span', { class: 'dim' }, since(e.lastSeen)) },
          ], d.errors, { onRow: (e) => ctx.navigate(L(`${BASE}/errors/${e.id}`)), empty: ['No errors', 'This service has no error groups right now.'] })),
          panel(`Version compare: ${s.version} vs ${s.previous}`, 'refresh', h('div', { class: 'ver-compare' },
            verRow('Error rate', pct(s.prevErrorRate), pct(s.errorRate), verErr <= 0),
            verRow('P95 latency', ms(s.prevP95), ms(s.p95), verLat <= 0),
            h('p', { class: 'muted', style: { margin: '8px 0 0' } }, verErr > 0.3 || verLat > s.prevP95 * 0.15
              ? `${s.version} is worse than ${s.previous}. Check the errors above, or roll back.`
              : `${s.version} performs the same or better than ${s.previous}.`)))));
      if (ctx.params.get('tab') === 'versions') setTimeout(() => body.querySelector('#versions')?.scrollIntoView({ behavior: 'smooth' }), 100);
      setChart('rps', lineDrill(charts.rps.canvas, [{ label: 'req/s', points: s.rpsSeries, color: '#3b82f6' }], { legend: false, area: true }));
      setChart('err', lineDrill(charts.err.canvas, [{ label: 'error %', points: s.errSeries, color: '#ef4444' }], { legend: false }));
      setChart('lat', lineDrill(charts.lat.canvas, [{ label: 'p50', points: s.p50Series, color: '#22c55e' }, { label: 'p95', points: s.p95Series, color: '#a855f7' }], { unit: 'ms' }));
    },
  });
}

function verRow(label, before, now, better) {
  return h('div', { class: 'ver-row' }, h('span', { class: 'dim' }, label), h('span', {}, before), icon('arrowRight', 13, 'dim'),
    h('b', { class: better ? 'c-green' : 'c-red' }, now), h('span', { class: `pill ${better ? 'st-ok' : 'st-err'}` }, better ? 'better' : 'worse'));
}

// ======================= endpoint =======================
export function developerEndpoint(main, ctx) {
  const setChart = chartSlots(ctx);
  const id = decodeURIComponent(location.pathname.split('/').pop());
  const f = readF(ctx);
  return detailPage(main, {
    load: () => mockFetch(() => endpointDetail(args(ctx), id)),
    notFound: ['Endpoint not found', '', back(ctx, f)],
    render(body, d) {
      const x = d.ep;
      const L = (path, extra = {}) => ctx.link(path, { ...f, ...extra });
      const lat = chartBox(220), hist = chartBox(220);
      body.append(
        detailHead('list', `Endpoint · ${x.service}`, h('span', { class: 'mono' }, x.route), `${x.rps.toFixed(1)} req/s · error rate ${pct(x.errorRate)}`, [
          linkBtn(L(`${BASE}/services/${x.service}`), 'arrowLeft', x.service),
          linkBtn(ctx.link('/logs', { q: `{service_name="${x.service}"} |= "${x.path}"` }), 'logs', 'Logs for this route'),
        ]),
        h('div', { class: 'grid cards-4', style: { marginBottom: '14px' } },
          miniStat('P50', ms(x.p50)), miniStat('P95', ms(x.p95)), miniStat('P99', ms(x.p99)), miniStat('Errors', pct(x.errorRate), null, errTone(x.errorRate))),
        h('div', { class: 'ov-row persona-row-2', style: { marginTop: 0 } },
          panel('Latency over time', 'timer', lat.el),
          panel('How long requests take', 'metrics', h('div', {}, hist.el, h('div', { class: 'dim chart-hint' }, 'Number of requests per duration bucket')))),
        h('div', { class: 'ov-row' }, panel('Slowest traces', 'traces', table([
          { label: 'Trace', value: (t) => h('code', {}, t.id) },
          { label: 'Duration', value: (t) => h('b', {}, ms(t.durationMs)), num: true },
          { label: 'Spans', value: (t) => String(t.spans), num: true },
          { label: 'Status', value: (t) => h('span', { class: `pill ${t.status === 'error' ? 'st-err' : 'st-ok'}` }, t.status === 'error' ? 'Error' : 'OK') },
          { label: 'When', value: (t) => h('span', { class: 'dim' }, since(t.at)) },
        ], d.traces, { onRow: (t) => ctx.navigate(L(`${BASE}/traces/${t.id}`, { svc: x.service })) }))));
      setChart('lat', lineDrill(lat.canvas, d.latency, { unit: 'ms' }));
      setChart('hist', barCats(hist.canvas, d.buckets, d.histogram, { colors: d.buckets.map((_, i) => (i >= 5 ? '#ef4444' : i >= 4 ? '#f59e0b' : '#3b82f6')) }));
    },
  });
}

// ======================= error group =======================
export function developerError(main, ctx) {
  const setChart = chartSlots(ctx);
  const id = location.pathname.split('/').pop();
  const f = readF(ctx);
  return detailPage(main, {
    load: () => mockFetch(() => errorDetail(args(ctx), id)),
    notFound: ['Error not found', 'It may have stopped happening or be outside the time range.', back(ctx, f)],
    render(body, d) {
      const e = d.err;
      const L = (path, extra = {}) => ctx.link(path, { ...f, ...extra });
      const occ = chartBox(180);
      const epIdx = d.endpoints.findIndex((x) => x.route === e.endpoint);
      const stack = h('pre', { class: 'stack' }, `${e.type}: ${e.message}\n${e.frames.map((fr) => `    ${e.lang === 'Python' || e.lang === 'Node.js' ? '' : 'at '}${fr}`).join('\n')}`);
      body.append(
        detailHead('incident', `Error · ${e.service}`, h('span', { class: 'mono' }, shortType(e.type)), e.message, [
          back(ctx, f),
          h('button', { class: 'btn btn-sm', onclick: () => {
            navigator.clipboard?.writeText(stack.textContent).then(() => toast('Stack trace copied'), () => toast('Copy is blocked here: select the text instead', 'err'));
          } }, icon('copy', 13), 'Copy stack trace'),
          notConnected('plus', 'Create ticket', NEEDS.tickets),
        ]),
        h('div', { class: 'grid cards-4', style: { marginBottom: '14px' } },
          miniStat('Events', fmt(e.count, 'short', 1), 'in the selected range'), miniStat('Users affected', String(e.users)),
          miniStat('First seen', since(e.firstSeen), dateTime(e.firstSeen)), miniStat('Last seen', since(e.lastSeen), dateTime(e.lastSeen))),
        h('div', { class: 'ov-row persona-row-2', style: { marginTop: 0 } },
          panel('Stack trace', 'list', stack),
          panel('Occurrences', 'activity', h('div', {}, occ.el,
            h('div', { class: 'ver-compare', style: { marginTop: '10px' } }, d.versions.map(([v, n]) => h('div', { class: 'ver-row' }, versionTag(v), h('span', {}, `${fmt(n, 'short', 1)} events`))))))),
        h('div', { class: 'ov-row persona-row-2b' },
          panel('Recent log lines', 'logs', h('div', { class: 'loglines' }, d.logs.map((l) => h('div', { class: 'logline' }, h('span', { class: 'dim' }, dateTime(l.at).slice(11, 19)), h('span', { class: 'pill lv-error' }, l.level), h('span', { class: 'mono' }, l.text)))),
            { link: ctx.link('/logs', { q: `{service_name="${e.service}"} |= "${e.type.split(':')[0]}"` }), linkLabel: 'Open in Logs' }),
          panel('Where it happens', 'search', h('div', {},
            quickActions([
              ...(epIdx >= 0 ? [{ ic: 'list', label: 'Endpoint', sub: e.endpoint, href: L(`${BASE}/endpoints/${e.service}~${epIdx}`) }] : []),
              { ic: 'cube', label: 'Service', sub: `${e.service} ${e.version}`, href: L(`${BASE}/services/${e.service}`) },
              ...d.traces.slice(0, 2).map((t, i) => ({ ic: 'traces', label: `Failed trace ${i + 1}`, sub: t, href: L(`${BASE}/traces/${t}`, { svc: e.service }) })),
            ])))));
      setChart('occ', lineDrill(occ.canvas, [{ label: 'events / min', points: d.occurrences, color: '#ef4444' }], { area: true, legend: false }));
    },
  });
}

// ======================= trace (waterfall) =======================
export function developerTrace(main, ctx) {
  const id = location.pathname.split('/').pop();
  const f = readF(ctx);
  const svc = ctx.params.get('svc') || '';
  return detailPage(main, {
    load: () => mockFetch(() => traceDetail(args(ctx), id, svc)),
    notFound: ['Trace not found', '', back(ctx, f)],
    render(body, t) {
      const colors = {};
      const palette = ['#3b82f6', '#a855f7', '#22c55e', '#06b6d4', '#f59e0b', '#ec4899'];
      const color = (s) => (colors[s] ||= palette[Object.keys(colors).length % palette.length]);
      body.append(
        detailHead('traces', 'Trace', [h('span', { class: 'mono' }, t.route), ' ', h('span', { class: `pill ${t.failed ? 'st-err' : 'st-ok'}` }, t.failed ? 'Error' : 'OK')],
          `${t.id} · ${ms(t.total)} · ${t.spans.length} spans · ${dateTime(t.at)}`, [
            linkBtn(ctx.link(`${BASE}/services/${t.service}`, f), 'arrowLeft', t.service),
            linkBtn(ctx.link('/logs', { q: `{service_name="${t.service}"} |= "${t.id}"` }), 'logs', 'Logs for this trace'),
          ]),
        panel('Spans', 'list', h('div', { class: 'waterfall' },
          h('div', { class: 'wf-head' }, h('span', {}, 'Operation'), h('div', { class: 'wf-scale' }, ['0', ms(t.total / 2), ms(t.total)].map((x) => h('span', {}, x)))),
          t.spans.map((s) => h('div', { class: `wf-row ${s.status === 'error' ? 'err' : ''}` },
            h('div', { class: 'wf-name', style: { paddingLeft: `${s.depth * 16}px` } }, h('i', { style: { background: color(s.service) } }), h('b', {}, s.service), h('span', { class: 'dim mono' }, s.name)),
            h('div', { class: 'wf-track' }, h('div', { class: 'wf-bar', style: { left: `${(s.start / t.total) * 100}%`, width: `${Math.max(0.6, (s.dur / t.total) * 100)}%`, background: s.status === 'error' ? '#ef4444' : color(s.service) } }),
              h('span', { class: 'wf-dur', style: (s.start + s.dur) / t.total > 0.85 ? { right: '6px', color: '#fff' } : { left: `${((s.start + s.dur) / t.total) * 100 + 0.8}%` } }, ms(s.dur))))))),
        ...(t.failed ? [h('div', { class: 'error-box', style: { marginTop: '14px' } }, icon('alert', 16), h('span', {}, `The call to ${t.spans[t.spans.length - 1].service} failed and the error went up to the caller.`))] : []));
    },
  });
}
