// Application Owner: "how are the applications I own doing: health, users, cost, releases, risks?"
// Sample data for now.
import { h, clear, icon, fmt, dateTime, emptyState, modal } from '../ui.js';
import { chartSlots } from '../pages/common.js';
import { mockFetch, TEAMS } from './mock.js';
import { appOwnerData, appDetail, releaseDetail, APPS, componentLang } from './mock-app.js';
import { onCall } from './mock-sre.js';
import { personaById } from './registry.js';
import {
  personaHead, filterBar, kpiCard, panel, chartBox, lineDrill, donut, table, quickActions, loadingSkeleton, errorState,
  statusPill, since, detailHead, miniStat, linkBtn, detailPage, barCats, scoreBar, legendRow,
  attentionStrip, stampFresh,
  notConnected, NEEDS,
} from './widgets.js';

const persona = { ...personaById('appowner'), title: 'My applications' };
const BASE = '/views/appowner';
const KEYS = ['team', 'app'];
const readF = (ctx) => Object.fromEntries(KEYS.map((k) => [k, ctx.params.get(k) || '']));
const money = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${Math.round(v)}`);
const back = (ctx, f) => linkBtn(ctx.link(BASE, f), 'arrowLeft', 'My applications');
const scoreTone = (s) => (s >= 85 ? 'c-green' : s >= 70 ? 'c-orange' : 'c-red');
const STATUS = { healthy: ['Healthy', 'st-ok'], degraded: ['Needs attention', 'st-slow'], at_risk: ['At risk', 'st-err'] };
const appPill = (s) => h('span', { class: `pill ${STATUS[s][1]}` }, STATUS[s][0]);
const RISK = { critical: 'sev-critical', warning: 'sev-warning', info: 'sev-info' };
const PIE = ['#3b82f6', '#a855f7', '#22c55e', '#f59e0b', '#06b6d4', '#ec4899'];
const budgetMeter = (cost, budget) => {
  const p = (cost / budget) * 100;
  return h('div', { class: 'meter', title: `${money(cost)} of ${money(budget)}` }, h('i', { style: { width: `${Math.min(100, p)}%`, background: p > 100 ? '#ef4444' : p > 90 ? '#f59e0b' : 'rgba(148,163,184,0.45)' } }), h('span', {}, `${p.toFixed(0)}%`));
};

function contactModal(app) {
  const o = onCall().find((x) => x.team === app.team);
  modal(`Contact the ${app.team} team`, h('div', { class: 'contact' },
    h('p', { class: 'muted' }, `${app.name} is built and run by the ${app.team} team.`),
    h('div', { class: 'report-grid' },
      h('div', {}, h('span', { class: 'dim' }, 'Application owner'), h('b', {}, app.owner)),
      h('div', {}, h('span', { class: 'dim' }, 'On call now'), h('b', {}, o?.primary || '-')),
      h('div', {}, h('span', { class: 'dim' }, 'On-call phone'), h('b', { class: 'selectable' }, o?.phone || '-'))),
    h('p', { class: 'dim', style: { fontSize: '12px' } }, `Team channel: #team-${app.team.toLowerCase()} · email: ${app.team.toLowerCase()}-team@example.local`)), [{ label: 'Close' }]);
}


// ======================= dashboard =======================
export function appOwnerDashboard(main, ctx) {
  const setChart = chartSlots(ctx);
  const f = readF(ctx);
  const filters = h('div');
  const body = h('div');
  main.append(personaHead(ctx, persona), filters, body);
  const defs = () => [
    { key: 'team', label: 'All teams', options: TEAMS.filter((t) => APPS.some((a) => a.team === t)).map((t) => [t, t]) },
    { key: 'app', label: 'All applications', options: APPS.filter((a) => !f.team || a.team === f.team).map((a) => [a.id, a.name]) },
  ];

  async function refresh(silent = false) {
    clear(filters).append(filterBar(ctx, defs(), f, () => refresh()));
    if (!silent) clear(body).append(loadingSkeleton(6));
    let d;
    try { d = await mockFetch((empty) => appOwnerData({ env: ctx.env, ...f, empty })); } catch (e) { clear(body).append(errorState(e.message, () => refresh())); return; }
    draw(d);
    stampFresh();
  }

  function draw(d) {
    clear(body);
    if (!d.apps.length) {
      body.append(h('div', { class: 'state-box' }, emptyState('No applications', 'You do not own an application that matches these filters.', linkBtn(ctx.link(BASE), 'x', 'Clear filters', 'btn btn-primary'))));
      return;
    }
    const k = d.kpi;
    const L = (path, extra = {}) => ctx.link(path, { ...f, ...extra });
    const overBudget = d.apps.filter((a) => a.cost > a.budget).sort((a, b) => b.cost / b.budget - a.cost / a.budget);
    const crit = d.apps.flatMap((a) => a.risks.filter((x) => x.level === 'critical' && !x.text.startsWith('Spending')).map((x) => ({ ...x, app: a })));
    const rb = d.releases.filter((x) => x.status === 'rolled_back' && x.at > Date.now() - 7 * 86400_000);
    const low = d.apps.filter((a) => a.score < 70);
    body.append(attentionStrip([
      overBudget.length && { level: 'critical', text: `${overBudget[0].name} is ${(((overBudget[0].cost / overBudget[0].budget) - 1) * 100).toFixed(0)}% over budget`, detail: `${money(overBudget[0].cost)} of ${money(overBudget[0].budget)}${overBudget.length > 1 ? ` · ${overBudget.length - 1} more over` : ''}`, action: { label: 'Where it goes', href: L(`${BASE}/apps/${overBudget[0].id}`) } },
      crit.length && { level: 'critical', text: `${crit[0].app.name}: ${crit[0].text.toLowerCase()}`, action: { label: 'Open app', href: L(`${BASE}/apps/${crit[0].app.id}`) } },
      low.length && { level: 'warning', text: `${low[0].name} health score is ${low[0].score}`, detail: 'below 70 out of 100', action: { label: 'Why', href: L(`${BASE}/apps/${low[0].id}`) } },
      rb.length && { level: 'warning', text: `${rb[0].appName} ${rb[0].version} was rolled back`, detail: since(rb[0].at), action: { label: 'Release notes', href: L(`${BASE}/releases/${rb[0].id}`) } },
    ]));
    const over = k.cost > k.budget;
    body.append(h('div', { class: 'ov-kpis persona-kpis-6' },
      kpiCard(setChart, { ic: 'heart', tone: k.score >= 85 ? 'green' : 'orange', title: 'Health score', value: String(k.score), unit: '/ 100', href: '#app-list',
        foot: [h('span', { class: 'dim' }, 'uptime, errors, speed, security')] }),
      kpiCard(setChart, { ic: 'user', tone: 'blue', title: 'Daily users', value: fmt(k.users, 'short', 1), href: '#app-usage', spark: d.usage, sparkColor: '#3b82f6',
        delta: { text: `${k.usersChange >= 0 ? '↑' : '↓'} ${Math.abs(k.usersChange).toFixed(1)}%`, cls: k.usersChange >= 0 ? 'good' : 'bad' }, foot: [h('span', { class: 'dim' }, 'vs last month')] }),
      kpiCard(setChart, { ic: 'alert', tone: k.errorRate >= 1 ? 'red' : 'green', title: 'Failed requests', value: k.errorRate.toFixed(2), unit: '%', href: '#app-list',
        foot: [h('span', { class: 'dim' }, 'what users see as errors')] }),
      kpiCard(setChart, { ic: 'activity', tone: over ? 'red' : 'purple', title: 'Cost this month', value: money(k.cost), href: '#app-cost',
        foot: [h('span', { class: over ? 'c-red' : 'dim' }, `${((k.cost / k.budget) * 100).toFixed(0)}% of ${money(k.budget)} budget`)] }),
      kpiCard(setChart, { ic: 'upload', tone: k.rolledBack ? 'orange' : 'green', title: 'Releases (30 days)', value: String(k.releases), href: '#app-releases',
        foot: [h('span', { class: k.rolledBack ? 'c-orange' : 'dim' }, `${k.rolledBack} rolled back`)] }),
      kpiCard(setChart, { ic: 'shield', tone: k.risks ? 'orange' : 'green', title: 'Risks to act on', value: String(k.risks), href: '#app-list',
        foot: [h('span', { class: 'dim' }, 'certificates, budget, security')] })));

    // usage + cost split
    const us = chartBox(240), cs = chartBox(200);
    const parts = {};
    d.apps.forEach((a) => a.costParts.forEach(([c, v]) => { parts[c] = (parts[c] || 0) + v; }));
    const partList = Object.entries(parts).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const usageP = panel('Daily users, last 30 days', 'user', h('div', {}, us.el, h('div', { class: 'dim chart-hint' }, 'Weekends are usually quieter. Click a line to open the application.')));
    usageP.id = 'app-usage';
    const costP = panel('Where the money goes', 'activity', h('div', { class: 'cost-split' }, h('div', { class: 'donut', style: { height: '200px' } }, cs.canvas),
      h('div', { class: 'cost-list' }, partList.map(([c, v], i) => h('a', { class: 'cost-row', href: ctx.link(`/views/developer/services/${c}`), 'data-link': true }, h('i', { style: { background: PIE[i] } }), h('span', {}, c), h('b', {}, money(v)))))));
    costP.id = 'app-cost';
    body.append(h('div', { class: 'ov-row persona-row-2' }, usageP, costP));
    setChart('us', lineDrill(us.canvas, d.apps.map((a) => ({ label: a.name, points: a.usage })), { onPick: (pt, ds) => ctx.navigate(L(`${BASE}/apps/${d.apps[ds].id}`)) }));
    setChart('cs', donut(cs.canvas, partList.map(([c]) => c), partList.map(([, v]) => Math.round(v)), PIE, (i) => ctx.navigate(ctx.link(`/views/developer/services/${partList[i][0]}`))));

    // applications + releases
    const list = panel('My applications', 'cube', table([
      { label: 'Application', value: (a) => h('div', {}, h('b', {}, a.name), h('div', { class: 'dim', style: { fontSize: '11px' } }, `owner ${a.owner} · ${a.team}`)) },
      { label: 'Health', value: (a) => h('b', { class: scoreTone(a.score) }, String(a.score)), num: true },
      { label: 'Status', value: (a) => appPill(a.status) },
      { minor: true, label: 'Users', value: (a) => fmt(a.users, 'short', 1), num: true },
      { label: 'Budget used', value: (a) => budgetMeter(a.cost, a.budget) },
      { label: 'Risks', value: (a) => (a.risks.length ? h('span', { class: a.risks.some((x) => x.level === 'critical') ? 'c-red' : 'c-orange' }, String(a.risks.length)) : h('span', { class: 'dim' }, '0')), num: true },
    ], d.apps, { onRow: (a) => ctx.navigate(L(`${BASE}/apps/${a.id}`)) }));
    list.id = 'app-list';
    const rel = panel('Recent releases', 'upload', table([
      { label: 'Release', value: (x) => h('div', {}, h('b', {}, x.appName), h('div', { class: 'dim', style: { fontSize: '11px' } }, x.version)) },
      { minor: true, label: 'What changed', value: (x) => h('span', { class: 'dim cut', title: x.changes.join(', ') }, x.changes[0]) },
      { label: 'Result', value: (x) => statusPill(x.status) },
      { label: 'When', value: (x) => h('span', { class: 'dim' }, since(x.at)) },
    ], d.releases, { max: 6, onRow: (x) => ctx.navigate(L(`${BASE}/releases/${x.id}`)) }));
    rel.id = 'app-releases';
    body.append(h('div', { class: 'ov-row persona-row-2b' }, list, rel));

    const first = d.apps[0];
    body.append(h('div', { class: 'ov-row persona-row-2b' },
      panel('Outside services we depend on', 'globe', table([
        { label: 'Provider', value: (x) => h('b', {}, x.name) },
        { minor: true, label: 'Used by', value: (x) => h('span', { class: 'dim' }, x.app) },
        { label: 'Response', value: (x) => `${Math.round(x.latency)} ms`, num: true },
        { label: 'Uptime', value: (x) => `${x.uptime.toFixed(2)}%`, num: true },
        { label: 'Status', value: (x) => statusPill(x.status) },
      ], d.external, { empty: ['No outside providers', 'These applications only use our own services.'] })),
      panel('Quick actions', 'activity', quickActions([
        { ic: 'user', label: 'Contact the team', sub: `${first.team} · on call now`, onclick: () => contactModal(first) },
        { ic: 'bell', label: 'Set a budget alert', unavailable: NEEDS.cost },
        { ic: 'list', label: 'Release notes', sub: 'Latest changes', href: d.releases[0] ? L(`${BASE}/releases/${d.releases[0].id}`) : '#' },
        { ic: 'check', label: 'Customer impact', sub: 'Business view', href: ctx.link('/views/business') },
      ]))));
  }

  refresh();
  return { refresh: () => refresh(true) };
}

// ======================= application detail =======================
export function appOwnerApp(main, ctx) {
  const setChart = chartSlots(ctx);
  const id = location.pathname.split('/').pop();
  const f = readF(ctx);
  return detailPage(main, {
    load: () => mockFetch(() => appDetail(ctx.env, id)),
    notFound: ['Application not found', '', back(ctx, f)],
    render(body, a) {
      const us = chartBox(220), ct = chartBox(220);
      const parts = [
        ['Uptime', Math.round(Math.max(0, 100 - (100 - a.availability) * 120)), `${a.availability.toFixed(2)}%`],
        ['Errors', Math.round(Math.max(0, 100 - a.errorRate * 18)), `${a.errorRate.toFixed(2)}% of requests`],
        ['Speed', Math.round(Math.max(0, 100 - Math.max(0, a.p95 - 200) / 6)), `P95 ${Math.round(a.p95)} ms`],
        ['Security', Math.max(0, 100 - a.findings * 15), `${a.findings} open finding${a.findings === 1 ? '' : 's'}`],
      ];
      body.append(
        detailHead('cube', `Application · ${a.team}`, [a.name, ' ', appPill(a.status)], `Owner ${a.owner} · built from ${a.components.length} services`, [
          back(ctx, f),
          h('button', { class: 'btn btn-sm', onclick: () => contactModal(a) }, icon('user', 13), 'Contact team'),
          notConnected('bell', 'Budget alert', NEEDS.cost),
        ]),
        h('div', { class: 'grid cards-4', style: { marginBottom: '14px' } },
          miniStat('Health score', `${a.score} / 100`, null, scoreTone(a.score)),
          miniStat('Daily users', fmt(a.users, 'short', 1), `${a.usersChange >= 0 ? '+' : ''}${a.usersChange.toFixed(1)}% vs last month`),
          miniStat('Cost this month', money(a.cost), `budget ${money(a.budget)}`, a.cost > a.budget ? 'c-red' : ''),
          miniStat('Releases', String(a.releases.length), `last ${since(a.releases[0].at)}`)),
        h('div', { class: 'ov-row persona-row-2b', style: { marginTop: 0 } },
          panel('What the health score is made of', 'heart', h('div', { class: 'score-parts' }, parts.map(([l, v, sub]) => h('div', { class: 'score-part' },
            h('div', { class: 'sp-top' }, h('b', {}, l), h('span', { class: scoreTone(v) }, String(v))), scoreBar(v), h('small', { class: 'dim' }, sub))))),
          panel('Risks to act on', 'shield', a.risks.length ? h('div', { class: 'risk-list' }, a.risks.map((x) => h('div', { class: 'risk' }, h('span', { class: `pill ${RISK[x.level]}` }, x.level === 'info' ? 'Plan' : x.level === 'critical' ? 'Act now' : 'Soon'), h('span', {}, x.text))))
            : emptyState('No risks', 'Nothing needs your attention.'))),
        h('div', { class: 'ov-row persona-row-2' },
          panel('Daily users', 'user', us.el),
          panel('Cost by month', 'activity', h('div', {}, ct.el, legendRow(['Under budget', 'Over budget'], ['#a855f7', '#ef4444'])))),
        h('div', { class: 'ov-row persona-row-2b' },
          panel('Services it is built from', 'services', table([
            { label: 'Service', value: (c) => h('b', {}, c[0]) },
            { label: 'Language', value: (c) => h('span', { class: 'dim' }, componentLang(c[0])) },
            { label: 'Cost this month', value: (c) => money(c[1]), num: true },
          ], a.costParts, { onRow: (c) => ctx.navigate(ctx.link(`/views/developer/services/${c[0]}`)) })),
          panel('Releases', 'upload', table([
            { label: 'Version', value: (x) => h('code', { class: 'ver' }, x.version) },
            { label: 'Result', value: (x) => statusPill(x.status) },
            { label: 'When', value: (x) => h('span', { class: 'dim' }, since(x.at)) },
          ], a.releases, { onRow: (x) => ctx.navigate(ctx.link(`${BASE}/releases/${x.id}`, f)) }))));
      setChart('us', lineDrill(us.canvas, [{ label: 'users', points: a.usage, color: '#3b82f6' }], { area: true, legend: false }));
      setChart('ct', barCats(ct.canvas, a.costTrend.map(([m]) => m), a.costTrend.map(([, v]) => Math.round(v)), { colors: a.costTrend.map(([, v]) => (v > a.budget ? '#ef4444' : '#a855f7')) }));
    },
  });
}

// ======================= release detail =======================
export function appOwnerRelease(main, ctx) {
  const id = location.pathname.split('/').pop();
  const f = readF(ctx);
  return detailPage(main, {
    load: () => mockFetch(() => releaseDetail(ctx.env, id)),
    notFound: ['Release not found', '', back(ctx, f)],
    render(body, { app, rel }) {
      const worse = rel.errAfter > rel.errBefore * 1.3;
      body.append(
        detailHead('upload', `Release · ${app.name}`, [rel.version, ' ', statusPill(rel.status)], `Released ${dateTime(rel.at)} by ${rel.by}`, [
          linkBtn(ctx.link(`${BASE}/apps/${app.id}`, f), 'arrowLeft', app.name),
        ]),
        h('div', { class: 'ov-row persona-row-2b', style: { marginTop: 0 } },
          panel('Release notes', 'list', h('ul', { class: 'plain-list' }, rel.changes.map((c) => h('li', {}, c)))),
          panel('Did it make things better?', 'activity', h('div', { class: 'ver-compare' },
            h('div', { class: 'ver-row' }, h('span', { class: 'dim' }, 'Failed requests'), h('span', {}, `${rel.errBefore.toFixed(2)}%`), icon('arrowRight', 13, 'dim'), h('b', { class: worse ? 'c-red' : 'c-green' }, `${rel.errAfter.toFixed(2)}%`), h('span', { class: `pill ${worse ? 'st-err' : 'st-ok'}` }, worse ? 'worse' : 'same or better')),
            h('p', { class: 'muted', style: { margin: '8px 0 0' } }, rel.status === 'rolled_back' ? 'Errors went up after this release, so it was rolled back automatically. Users are on the previous version.' : worse ? 'Errors went up a little after this release. The team is watching it.' : 'No problems after this release.')))),
        h('div', { class: 'ov-row' }, panel('Services changed', 'services', quickActions(rel.components.map((c) => ({ ic: 'cube', label: c, sub: 'open technical view', href: ctx.link(`/views/developer/services/${c}`) }))))));
    },
  });
}
