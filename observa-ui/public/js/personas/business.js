// Business / Executive: "are customers able to use our services, and what is it costing us?"
// Plain language, monthly view, no technical terms. Sample data for now.
import { h, clear, icon, fmt, dateTime, emptyState, toast } from '../ui.js';
import { chartSlots } from '../pages/common.js';
import { mockFetch } from './mock.js';
import { businessData, businessService, summaryLines, BUSINESS_SERVICES, REGIONS, pickRegionLabel } from './mock-biz.js';
import { incidentById, STATUS_LABEL } from './mock-sre.js';
import { personaById } from './registry.js';
import {
  personaHead, filterBar, kpiCard, panel, chartBox, table, quickActions, loadingSkeleton, errorState,
  since, detailHead, miniStat, linkBtn, detailPage, barCats, delta,
  attentionStrip, stampFresh,
  notConnected, NEEDS,
} from './widgets.js';
import { baseOptions } from '../ui.js';

const persona = { ...personaById('business'), title: 'Business overview' };
const BASE = '/views/business';
const KEYS = ['region', 'service'];
const readF = (ctx) => Object.fromEntries(KEYS.map((k) => [k, ctx.params.get(k) || '']));
const money = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${Math.round(v)}`);
const pct = (v, d = 2) => `${v.toFixed(d)}%`;
const hrs = (m) => (m < 60 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1)} h`);
const back = (ctx, f) => linkBtn(ctx.link(BASE, f), 'arrowLeft', 'Business overview');
const HEALTH = { healthy: ['Normal', 'st-ok'], degraded: ['Slower than usual', 'st-slow'], at_risk: ['Below promise', 'st-err'] };
const health = (s) => h('span', { class: `pill ${HEALTH[s][1]}` }, HEALTH[s][0]);
const slaPill = (met) => h('span', { class: `pill ${met ? 'st-ok' : 'st-err'}` }, met ? 'Met' : 'Missed');
const monthName = () => new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

// bars + line on one chart (incidents per month and minutes of customer impact)
function comboChart(canvas, labels, bars, line, onPick) {
  const opts = baseOptions('none', { showLegend: true });
  opts.scales.y1 = { position: 'right', beginAtZero: true, grid: { display: false }, ticks: { color: opts.scales.y.ticks.color, font: { size: 10 }, callback: (v) => `${v}m` }, border: { display: false } };
  opts.plugins.tooltip.callbacks.label = (c) => ` ${c.dataset.label}: ${c.datasetIndex === 1 ? `${Math.round(c.parsed.y)} min` : c.parsed.y}`;
  opts.onClick = (e, els) => { if (els.length) onPick(els[0].index); };
  opts.onHover = (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; };
  return new window.Chart(canvas, {
    data: { labels, datasets: [
      { type: 'bar', label: 'Customer-facing incidents', data: bars, backgroundColor: '#6366f1', borderRadius: 3, maxBarThickness: 26, order: 2 },
      { type: 'line', label: 'Minutes customers were affected', data: line, borderColor: '#f59e0b', backgroundColor: '#f59e0b', yAxisID: 'y1', tension: 0.3, pointRadius: 3, order: 1 },
    ] },
    options: opts,
  });
}

// ======================= dashboard =======================
export function businessDashboard(main, ctx) {
  const setChart = chartSlots(ctx);
  const f = readF(ctx);
  const filters = h('div');
  const body = h('div');
  main.append(personaHead(ctx, persona, {
    subtitle: `Business overview · ${monthName()}`,
    actions: [linkBtn(ctx.link(`${BASE}/report`, f), 'list', 'Monthly report')],
  }), filters, body);
  const defs = [
    { key: 'region', label: 'All regions', options: REGIONS },
    { key: 'service', label: 'All customer services', options: BUSINESS_SERVICES.map((b) => [b.id, b.name]) },
  ];

  async function refresh(silent = false) {
    clear(filters).append(filterBar(ctx, defs, f, () => refresh()));
    if (!silent) clear(body).append(loadingSkeleton(6));
    let d;
    try { d = await mockFetch((empty) => businessData({ env: ctx.env, ...f, empty })); } catch (e) { clear(body).append(errorState(e.message, () => refresh())); return; }
    draw(d);
    stampFresh();
  }

  function draw(d) {
    clear(body);
    if (!d.services.length) {
      body.append(h('div', { class: 'state-box' }, emptyState('No customer services to show', 'Nothing matches these filters.', linkBtn(ctx.link(BASE), 'x', 'Clear filters', 'btn btn-primary'))));
      return;
    }
    const k = d.kpi;
    const L = (path, extra = {}) => ctx.link(path, { ...f, ...extra });
    const missed = d.services.filter((s) => !s.met);
    const ongoing = d.issues.filter((x) => x.status !== 'resolved' && x.severity === 'critical');
    body.append(attentionStrip([
      ongoing.length && { level: 'critical', text: `${ongoing[0].business.name}: ${ongoing[0].title.toLowerCase()}`, detail: `ongoing for ${hrs(ongoing[0].impactMin)} · ${money(ongoing[0].revenueAtRisk)} in sales at risk`, action: { label: 'What is happening', href: L(`${BASE}/issues/${ongoing[0].id}`) } },
      missed.length && { level: 'warning', text: `${missed.map((s) => s.name).join(', ')} below promised uptime`, detail: `${missed[0].availability.toFixed(3)}% vs ${missed[0].sla}% promised · service credits may be owed`, action: { label: 'See details', href: L(`${BASE}/services/${missed[0].id}`) } },
    ]));
    // plain-language summary first: this is what an executive reads
    body.append(h('section', { class: 'exec-summary' },
      h('div', { class: 'exec-title' }, icon('list', 15), `Summary for ${monthName()}${f.region ? ` · ${pickRegionLabel(f.region)}` : ''}`),
      h('ul', {}, summaryLines(d, money).map((l) => h('li', { class: `t-${l.tone}` }, l.text)))));

    body.append(h('div', { class: 'ov-kpis persona-kpis-6' },
      kpiCard(setChart, { ic: 'check', tone: k.availability >= 99.9 ? 'green' : 'orange', title: 'Availability', value: k.availability.toFixed(3), unit: '%', href: '#biz-services',
        delta: k.prevAvailability ? delta(k.availability, k.prevAvailability, { unit: '%' }) : null, foot: [h('span', { class: 'dim' }, 'weighted by sales, this month')] }),
      kpiCard(setChart, { ic: 'shield', tone: k.slaMet === k.slaTotal ? 'green' : 'red', title: 'Promises kept (SLA)', value: `${k.slaMet}/${k.slaTotal}`, href: '#biz-services',
        foot: [h('span', { class: k.slaMet === k.slaTotal ? 'c-green' : 'c-red' }, k.slaMet === k.slaTotal ? 'all met' : `${k.slaTotal - k.slaMet} missed`)] }),
      kpiCard(setChart, { ic: 'activity', tone: 'red', title: 'Sales at risk', value: money(k.revenueAtRisk), href: '#biz-issues',
        foot: [h('span', { class: 'dim' }, 'estimated, during outages')] }),
      kpiCard(setChart, { ic: 'incident', tone: k.customerIncidents ? 'orange' : 'green', title: 'Customer-facing problems', value: String(k.customerIncidents), href: '#biz-issues',
        foot: [h('span', { class: 'dim' }, `${hrs(k.impactMin)} of impact`)] }),
      kpiCard(setChart, { ic: 'user', tone: 'purple', title: 'Customers affected', value: fmt(k.usersAffected, 'short', 1), href: '#biz-services',
        foot: [h('span', { class: 'dim' }, 'saw an error or a very slow page')] }),
      kpiCard(setChart, { ic: 'upload', tone: 'blue', title: 'Orders', value: fmt(k.orders, 'short', 1), href: L(`${BASE}/services/checkout`),
        delta: { text: `${k.ordersChange >= 0 ? '↑' : '↓'} ${Math.abs(k.ordersChange).toFixed(1)}%`, cls: k.ordersChange >= 0 ? 'good' : 'bad' }, foot: [h('span', { class: 'dim' }, `rating ${k.satisfaction.toFixed(1)} / 5`)] })));

    // availability vs promise, by customer service + monthly trend
    const av = chartBox(250), mo = chartBox(250);
    const svcs = [...d.services].sort((a, b) => (a.availability - a.sla) - (b.availability - b.sla));
    body.append(h('div', { class: 'ov-row persona-row-2' },
      panel('Uptime against what we promise', 'check', h('div', {}, av.el,
        h('div', { class: 'dim chart-hint' }, 'How far above (grey) or below (red) each service is from its promised uptime. Click a bar for details.'))),
      panel('Problems per month', 'incident', h('div', {}, mo.el, h('div', { class: 'dim chart-hint' }, 'Click a month to see its problems')))));
    const margin = svcs.map((s) => Number(((s.availability - s.sla) * 100).toFixed(1)));
    setChart('av', barCats(av.canvas, svcs.map((s) => s.name), margin, {
      horizontal: true, colors: svcs.map((s) => (s.met ? 'rgba(148,163,184,0.55)' : '#ef4444')),
      onPick: (i) => ctx.navigate(L(`${BASE}/services/${svcs[i].id}`)),
    }));
    const avChart = av.canvas;
    setTimeout(() => {
      const c = window.Chart.getChart(avChart);
      if (!c) return;
      c.options.plugins.tooltip.callbacks.label = (x) => ` ${svcs[x.dataIndex].availability.toFixed(3)}% (promise ${svcs[x.dataIndex].sla}%)`;
      c.options.scales.x.ticks.callback = (v) => `${v > 0 ? '+' : ''}${(v / 100).toFixed(2)}%`;
      c.update('none');
    });
    setChart('mo', comboChart(mo.canvas, d.months.map((m) => m.label), d.months.map((m) => m.incidents), d.months.map((m) => Math.round(m.impactMin)),
      (i) => ctx.navigate(L(`${BASE}/report`, { month: String(d.months[i].month) }))));

    // customer services table + top issues
    const st = panel('Customer services', 'cube', table([
      { label: 'Service', value: (s) => h('div', {}, h('b', {}, s.name), h('div', { class: 'dim', style: { fontSize: '11px' } }, s.users)) },
      { label: 'Status', value: (s) => health(s.health) },
      { label: 'Uptime', value: (s) => h('span', { class: s.met ? '' : 'c-red' }, pct(s.availability, 3)), num: true },
      { minor: true, label: 'Promise', value: (s) => h('span', { class: 'dim' }, `${s.sla}%`), num: true },
      { label: 'SLA', value: (s) => slaPill(s.met) },
      { label: 'Sales at risk', value: (s) => money(s.revenueAtRisk), num: true },
    ], svcs, { onRow: (s) => ctx.navigate(L(`${BASE}/services/${s.id}`)) }));
    st.id = 'biz-services';
    const iss = panel('Biggest problems this month', 'incident', table([
      { label: 'Problem', value: (x) => h('div', {}, h('b', {}, x.title), h('div', { class: 'dim', style: { fontSize: '11px' } }, `${x.business.name} · ${since(x.startedAt)}`)) },
      { label: 'Impact', value: (x) => hrs(x.impactMin), num: true },
      { label: 'Sales at risk', value: (x) => money(x.revenueAtRisk), num: true },
      { label: 'Status', value: (x) => h('span', { class: `pill ${x.status === 'resolved' ? 'st-ok' : 'st-err'}` }, x.status === 'resolved' ? 'Fixed' : 'Ongoing') },
    ], d.issues, { max: 6, onRow: (x) => ctx.navigate(L(`${BASE}/issues/${x.id}`)), empty: ['No customer-facing problems', 'Nothing affected customers this month.'] }));
    iss.id = 'biz-issues';
    body.append(h('div', { class: 'ov-row persona-row-2b' }, st, iss));

    body.append(h('div', { class: 'ov-row' }, panel('Quick actions', 'activity', h('div', { class: 'qa-wide' }, quickActions([
      { ic: 'list', label: 'Monthly report', sub: 'One page for the board', href: L(`${BASE}/report`) },
      { ic: 'bell', label: 'Weekly email summary', unavailable: NEEDS.email },
      { ic: 'cube', label: 'Owners of each service', sub: 'Who to call', href: ctx.link('/views/appowner') },
    ])))));
  }

  refresh();
  return { refresh: () => refresh(true) };
}

// ======================= customer service detail =======================
export function businessServicePage(main, ctx) {
  const setChart = chartSlots(ctx);
  const id = location.pathname.split('/').pop();
  const f = readF(ctx);
  return detailPage(main, {
    load: () => mockFetch(() => businessService({ env: ctx.env, region: f.region }, id)),
    notFound: ['Customer service not found', '', back(ctx, f)],
    render(body, d) {
      const s = d.svc;
      const tr = chartBox(220);
      body.append(
        detailHead('cube', `Customer service · owned by ${s.owner}`, [s.name, ' ', health(s.health)], `Used for ${s.users}. We promise ${s.sla}% uptime.`, [back(ctx, f)]),
        h('div', { class: 'grid cards-4', style: { marginBottom: '14px' } },
          miniStat('Uptime this month', pct(s.availability, 3), `promise ${s.sla}%`, s.met ? 'c-green' : 'c-red'),
          miniStat('Time unavailable', hrs(s.minutesDown), `allowed ${hrs(((100 - s.sla) / 100) * 30 * 24 * 60)} per month`),
          miniStat('Sales at risk', money(s.revenueAtRisk), 'estimated'),
          miniStat('Customer rating', `${s.satisfaction.toFixed(1)} / 5`, `${s.volumeChange >= 0 ? '+' : ''}${s.volumeChange.toFixed(1)}% usage vs last month`)),
        h('div', { class: 'ov-row persona-row-2', style: { marginTop: 0 } },
          panel('Daily uptime, last 30 days', 'activity', h('div', {}, tr.el, h('div', { class: 'dim chart-hint' }, `Red days were below the ${s.sla}% promise`))),
          panel('Promise kept, last 6 months', 'shield', table([
            { label: 'Month', value: (m) => m.month },
            { label: 'Uptime', value: (m) => pct(m.availability, 3), num: true },
            { label: 'SLA', value: (m) => slaPill(m.met) },
            { label: 'Credits owed', value: (m) => (m.credits ? money(m.credits) : h('span', { class: 'dim' }, '-')), num: true },
          ], s.history))),
        h('div', { class: 'ov-row persona-row-2b' },
          panel('Problems this month', 'incident', table([
            { label: 'Problem', value: (x) => h('b', {}, x.title) },
            { label: 'Impact', value: (x) => hrs(x.impactMin), num: true },
            { label: 'Status', value: (x) => h('span', { class: `pill ${x.status === 'resolved' ? 'st-ok' : 'st-err'}` }, x.status === 'resolved' ? 'Fixed' : 'Ongoing') },
          ], d.issues, { onRow: (x) => ctx.navigate(ctx.link(`${BASE}/issues/${x.id}`, f)), empty: ['No problems this month', ''] })),
          panel('What it is built from', 'services', h('div', {},
            h('p', { class: 'muted', style: { margin: '0 0 8px', fontSize: '12.5px' } }, 'The technical parts behind this service. Engineers can open each one.'),
            quickActions(s.components.map((c) => ({ ic: 'cube', label: c, sub: 'open technical view', href: ctx.link(`/views/developer/services/${c}`) })))))));
      setChart('tr', barCats(tr.canvas, s.trend.map((_, i) => { const dd = new Date(Date.now() - (29 - i) * 86400_000); return dd.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }); }),
        s.trend.map(([, v]) => Number(v.toFixed(3))), { colors: s.trend.map(([, v]) => (v < s.sla ? '#ef4444' : '#22c55e')) }));
      setTimeout(() => {
        const c = window.Chart.getChart(tr.canvas);
        if (!c) return;
        c.options.scales.y.min = Math.floor(Math.min(...s.trend.map(([, v]) => v)) - 0.1);
        c.options.scales.y.max = 100;
        c.options.scales.y.beginAtZero = false;
        c.options.scales.y.ticks.callback = (v) => `${v}%`;
        c.update('none');
      });
    },
  });
}

// ======================= problem (incident) summary for executives =======================
export function businessIssue(main, ctx) {
  const id = location.pathname.split('/').pop();
  const f = readF(ctx);
  return detailPage(main, {
    load: () => mockFetch(() => {
      const x = incidentById(ctx.env, id);
      if (!x) return null;
      const d = businessData({ env: ctx.env, region: f.region });
      return d.issues.find((y) => String(y.id) === String(id)) || { ...x, business: d.services.find((s) => s.components.includes(x.service)) || d.services[0], impactMin: ((x.resolvedAt || Date.now()) - x.startedAt) / 60_000, revenueAtRisk: 0 };
    }),
    notFound: ['Problem not found', '', back(ctx, f)],
    render(body, x) {
      const fixed = x.status === 'resolved';
      const updates = [...x.events].sort((a, b) => a.at - b.at).filter((e) => e.kind !== 'page');
      body.append(
        detailHead('incident', `Customer-facing problem · ${x.business.name}`, [x.title, ' ', h('span', { class: `pill ${fixed ? 'st-ok' : 'st-err'}` }, fixed ? 'Fixed' : 'Ongoing')],
          `Started ${dateTime(x.startedAt)}${fixed ? `, fixed after ${hrs(x.impactMin)}` : `, ongoing for ${hrs(x.impactMin)}`}`, [
            back(ctx, f),
            ctx.can('incidents.manage') ? linkBtn(ctx.link(`/views/sre/incidents/${x.id}`), 'external', 'Engineering view') : null,
          ]),
        h('div', { class: 'grid cards-4', style: { marginBottom: '14px' } },
          miniStat('Customer service', x.business.name), miniStat('How long', hrs(x.impactMin)),
          miniStat('Customers affected', x.customersAffected ? fmt(x.customersAffected, 'short', 1) : 'being measured'), miniStat('Sales at risk', money(x.revenueAtRisk), 'estimated')),
        h('div', { class: 'ov-row persona-row-2b', style: { marginTop: 0 } },
          panel('What happened', 'list', h('div', { class: 'plain-text' },
            h('p', {}, `${x.business.name} was ${x.severity === 'critical' ? 'not working for some customers' : 'slower or less reliable than normal'}. The problem was in ${x.service}, one of its technical parts.`),
            h('p', {}, fixed ? `It is fixed. ${x.postmortem === 'done' ? 'The team has published a review with follow-up actions.' : 'The team is writing a review of what went wrong.'}` : `The team (lead: ${x.commander || 'being assigned'}) is working on it. Current step: ${STATUS_LABEL[x.status].toLowerCase()}.`))),
          panel('Updates', 'clock', h('ol', { class: 'inc-tl' }, updates.map((e) => h('li', { class: `k-${e.kind}` }, h('span', { class: 'dim' }, dateTime(e.at).slice(5, 16)), h('div', {}, e.text)))))));
    },
  });
}

// ======================= monthly report =======================
export function businessReport(main, ctx) {
  const f = { ...readF(ctx) };
  const month = Number(ctx.params.get('month')) || null;
  return detailPage(main, {
    load: () => mockFetch(() => businessData({ env: ctx.env, ...f })),
    notFound: ['No data', '', back(ctx, f)],
    render(body, d) {
      const k = d.kpi;
      const label = month ? new Date(month).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : monthName();
      const m = month ? d.months.find((x) => x.month === month) : null;
      body.append(
        detailHead('list', 'Monthly report', `Service report · ${label}`, `${f.region ? pickRegionLabel(f.region) : 'All regions'}${ctx.env ? ` · ${ctx.env}` : ''}`, [
          back(ctx, f),
          h('button', { class: 'btn btn-sm', onclick: () => {
            const text = body.querySelector('.report').innerText;
            navigator.clipboard?.writeText(text).then(() => toast('Report copied. Paste it into an email or document.'), () => toast('Copy is blocked here: select the text instead', 'err'));
          } }, icon('copy', 13), 'Copy as text'),
        ]),
        h('article', { class: 'report panel' },
          h('h2', {}, 'Headline'),
          m ? h('p', {}, `${m.incidents} customer-facing problems in ${label}, affecting customers for ${hrs(m.impactMin)} in total. Overall uptime ${m.availability.toFixed(3)}%.`) : null,
          h('ul', {}, summaryLines(d, money).map((l) => h('li', {}, l.text))),
          h('h2', {}, 'Numbers'),
          h('div', { class: 'report-grid' },
            [['Availability', `${k.availability.toFixed(3)}%`], ['Promises kept', `${k.slaMet} of ${k.slaTotal}`], ['Sales at risk', money(k.revenueAtRisk)], ['Customer-facing problems', String(k.customerIncidents)], ['Customers affected', fmt(k.usersAffected, 'short', 1)], ['Customer rating', `${k.satisfaction.toFixed(1)} / 5`]]
              .map(([a, b]) => h('div', {}, h('span', { class: 'dim' }, a), h('b', {}, b)))),
          h('h2', {}, 'By customer service'),
          table([
            { label: 'Service', value: (s) => s.name },
            { label: 'Uptime', value: (s) => pct(s.availability, 3), num: true },
            { label: 'Promise', value: (s) => `${s.sla}%`, num: true },
            { label: 'SLA', value: (s) => slaPill(s.met) },
          ], d.services),
          h('h2', {}, 'What we are doing about it'),
          h('ul', {}, d.services.filter((s) => !s.met).map((s) => h('li', {}, `${s.name}: the ${s.owner} team is fixing the causes found in this month's reviews.`)).concat(
            d.services.every((s) => s.met) ? [h('li', {}, 'No action needed: every service kept its promise.')] : []))));
    },
  });
}
