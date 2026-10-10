// SRE / Reliability Engineer: are we keeping our promises (SLOs, error budgets), and how are incidents going?
// Includes the incident workflow: acknowledge -> investigate -> mitigate -> resolve -> postmortem.
import { h, clear, icon, fmt, dateTime, emptyState, toast, modal, field, select } from '../ui.js';
import { chartSlots } from '../pages/common.js';
import { mockFetch, SERVICES, TEAMS } from './mock.js';
import { sreData, slos, incidentById, updateIncident, declareIncident, onCall, STATUS_FLOW, STATUS_LABEL } from './mock-sre.js';
import { personaById } from './registry.js';
import {
  personaHead, filterBar, kpiCard, panel, chartBox, lineDrill, stackedBars, table, quickActions,
  loadingSkeleton, errorState, statusPill, since, detailHead, miniStat, linkBtn, detailPage,
  attentionStrip, stampFresh,
  notConnected, NEEDS,
} from './widgets.js';

const persona = { ...personaById('sre'), title: 'Reliability' };
const BASE = '/views/sre';
const KEYS = ['team', 'service'];
const readF = (ctx) => Object.fromEntries(KEYS.map((k) => [k, ctx.params.get(k) || '']));
const args = (ctx, f = {}) => { const { start, end } = ctx.range; return { env: ctx.env, start, end, ...f }; };
const back = (ctx, f) => linkBtn(ctx.link(BASE, f), 'arrowLeft', 'SRE dashboard');
const mins = (m) => (m < 60 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1)} h`);
const budgetTone = (b) => (b <= 0 ? '#ef4444' : b < 25 ? '#f59e0b' : 'rgba(148,163,184,0.45)');
const SLO_PILL = { healthy: ['Healthy', 'st-ok'], at_risk: ['At risk', 'st-slow'], breached: ['Breached', 'st-err'] };
const sloPill = (s) => h('span', { class: `pill ${SLO_PILL[s][1]}` }, SLO_PILL[s][0]);
const SEV = { critical: 'sev-critical', warning: 'sev-warning', info: 'sev-info' };
const sevPill = (s) => h('span', { class: `pill ${SEV[s]}` }, s[0].toUpperCase() + s.slice(1));
const INC_PILL = { detected: 'st-open', acknowledged: 'st-ack', investigating: 'st-inv', mitigated: 'st-slow', resolved: 'st-res' };
const incPill = (s) => h('span', { class: `pill ${INC_PILL[s]}` }, STATUS_LABEL[s]);
const budgetBar = (b) => h('div', { class: 'meter', title: `${b.toFixed(1)}% of the error budget left` },
  h('i', { style: { width: `${Math.max(0, Math.min(100, b))}%`, background: budgetTone(b) } }), h('span', {}, b <= 0 ? `${b.toFixed(0)}% (over)` : `${b.toFixed(0)}%`));
const burn = (v) => h('span', { class: v >= 6 ? 'c-red' : v >= 2 ? 'c-orange' : 'dim' }, `${v.toFixed(1)}x`);
const me = (ctx) => ctx.me.user.displayName || ctx.me.user.username;

export function declareModal(ctx, preset = {}) {
  const title = h('input', { class: 'input', id: 'inc-title', maxlength: 120, placeholder: 'What is broken, in one line', value: preset.title || '' });
  let service = preset.service || SERVICES[0].name, severity = preset.severity || 'critical';
  modal('Declare an incident', h('div', {},
    field('Title', title),
    h('div', { class: 'form-row' },
      field('Service', select(SERVICES.map((s) => [s.name, s.name]), service, (v) => { service = v; })),
      field('Severity', select([['critical', 'Critical: customers blocked'], ['warning', 'Warning: degraded'], ['info', 'Info: no customer impact']], severity, (v) => { severity = v; }))),
    h('div', { class: 'info-box' }, `You become the incident commander. The on-call for the service's team is paged (demo: nobody is paged).`)), [
    { label: 'Cancel' },
    { label: 'Declare incident', primary: true, onclick: () => {
      if (!title.value.trim()) throw new Error('Give the incident a title.');
      const id = declareIncident(ctx.env, { title: title.value.trim(), service, severity, user: me(ctx) });
      toast(`Incident INC-${id} declared`);
      ctx.navigate(ctx.link(`${BASE}/incidents/${id}`));
    } },
  ]);
}

// ======================= dashboard =======================
export function sreDashboard(main, ctx) {
  const setChart = chartSlots(ctx);
  const f = readF(ctx);
  const filters = h('div');
  const body = h('div');
  main.append(personaHead(ctx, persona, {
    actions: [h('button', { class: 'btn btn-sm btn-danger', onclick: () => declareModal(ctx, { service: f.service || undefined }) }, icon('incident', 13), 'Declare incident')],
  }), filters, body);
  const defs = () => [
    { key: 'team', label: 'All teams', options: TEAMS.map((t) => [t, t]) },
    { key: 'service', label: 'All services', options: SERVICES.filter((s) => !f.team || s.team === f.team).map((s) => [s.name, s.name]) },
  ];

  async function refresh(silent = false) {
    clear(filters).append(filterBar(ctx, defs(), f, () => refresh()));
    if (!silent) clear(body).append(loadingSkeleton(6));
    let d;
    try { d = await mockFetch((empty) => sreData({ ...args(ctx, f), empty })); } catch (e) { clear(body).append(errorState(e.message, () => refresh())); return; }
    draw(d);
    stampFresh();
  }

  function draw(d) {
    clear(body);
    if (!d.slos.length && !d.incidents.length) {
      body.append(h('div', { class: 'state-box' }, emptyState('No SLOs or incidents here', 'Nothing matches these filters. Clear them, or create SLOs for your services.', linkBtn(ctx.link(BASE), 'x', 'Clear filters', 'btn btn-primary'))));
      return;
    }
    const k = d.kpi;
    const L = (path, extra = {}) => ctx.link(path, { ...f, ...extra });
    const breached = d.slos.filter((s) => s.status === 'breached').sort((a, b) => a.budgetLeft - b.budgetLeft);
    const fast = d.slos.filter((s) => s.burn1h >= 6 && s.status !== 'breached').sort((a, b) => b.burn1h - a.burn1h);
    const unacked = d.incidents.filter((x) => x.status === 'detected');
    const noCmd = d.incidents.filter((x) => x.status !== 'resolved' && !x.commander);
    body.append(attentionStrip([
      unacked.length && { level: 'critical', text: `${unacked.length} incident${unacked.length > 1 ? 's' : ''} not acknowledged`, detail: `${unacked[0].title} · ${since(unacked[0].startedAt)}`, action: { label: 'Acknowledge', href: L(`${BASE}/incidents/${unacked[0].id}`) } },
      breached.length && { level: 'critical', text: `${breached[0].name} is out of error budget`, detail: `${breached[0].budgetLeft.toFixed(0)}% left${breached.length > 1 ? ` · ${breached.length - 1} more breached` : ''}`, action: { label: 'Open SLO', href: L(`${BASE}/slos/${breached[0].id}`) } },
      fast.length && { level: 'warning', text: `${fast[0].name} is burning budget ${fast[0].burn1h.toFixed(0)}x too fast`, detail: 'at this rate it runs out within days', action: { label: 'Open SLO', href: L(`${BASE}/slos/${fast[0].id}`) } },
      noCmd.length && { level: 'warning', text: `INC-${noCmd[0].id} has no commander`, detail: noCmd[0].title, action: { label: 'Take it', href: L(`${BASE}/incidents/${noCmd[0].id}`) } },
    ]));
    body.append(h('div', { class: 'ov-kpis persona-kpis-6' },
      kpiCard(setChart, { ic: 'check', tone: k.breached ? 'red' : k.atRisk ? 'orange' : 'green', title: 'SLOs on target', value: `${k.slosOk}/${k.slosTotal}`, href: '#sre-slos',
        foot: [h('span', { class: 'c-orange' }, `${k.atRisk} at risk`), h('span', { class: 'c-red' }, `${k.breached} breached`)] }),
      kpiCard(setChart, { ic: 'pulse', tone: k.budgetMin <= 0 ? 'red' : 'blue', title: 'Error budget left', value: k.budgetAvg.toFixed(0), unit: '% avg', href: '#sre-slos',
        foot: [h('span', { class: k.budgetMin <= 0 ? 'c-red' : 'dim' }, `lowest ${k.budgetMin.toFixed(0)}%`)] }),
      kpiCard(setChart, { ic: 'activity', tone: k.fastBurn ? 'red' : 'green', title: 'Burning fast', value: String(k.fastBurn), unit: 'SLOs', href: L(`${BASE}`, { sort: 'burn' }) + '#sre-slos',
        foot: [h('span', { class: 'dim' }, 'burn rate over 2x in the last hour')] }),
      kpiCard(setChart, { ic: 'incident', tone: k.openCritical ? 'red' : 'orange', title: 'Open incidents', value: String(k.open), href: L(`${BASE}/incidents`, { status: 'open' }),
        foot: [h('span', { class: 'c-red' }, `${k.openCritical} critical`)] }),
      kpiCard(setChart, { ic: 'bell', tone: 'purple', title: 'Time to acknowledge', value: mins(k.mttaMin), href: L(`${BASE}/incidents`, { status: 'resolved' }),
        foot: [h('span', { class: 'dim' }, 'median (MTTA)')] }),
      kpiCard(setChart, { ic: 'clock', tone: 'blue', title: 'Time to resolve', value: mins(k.mttrMin), href: L(`${BASE}/incidents`, { status: 'resolved' }),
        foot: [h('span', { class: 'dim' }, 'median (MTTR)')] })));

    // budget burn-down for the SLOs in the most trouble + incidents per week
    const bd = chartBox(240), wk = chartBox(240);
    const worst = [...d.slos].sort((a, b) => a.budgetLeft - b.budgetLeft).slice(0, 4);
    body.append(h('div', { class: 'ov-row persona-row-2' },
      panel('Error budget left (30 days)', 'pulse', h('div', {}, bd.el, h('div', { class: 'dim chart-hint' }, 'The 4 SLOs with the least budget. Click a line to open the SLO.'))),
      panel('Incidents per week', 'incident', h('div', {}, wk.el, h('div', { class: 'dim chart-hint' }, 'Click a bar to see that week\'s incidents')), { link: L(`${BASE}/incidents`) })));
    if (worst.length) {
      setChart('bd', lineDrill(bd.canvas, worst.map((s) => ({ label: s.name, points: s.burnDown })), {
        unit: 'percent', onPick: (pt, ds) => ctx.navigate(L(`${BASE}/slos/${worst[ds].id}`)),
      }));
    }
    const wlabels = d.weeks.map((w) => new Date(w.start).toLocaleDateString(undefined, { day: '2-digit', month: 'short' }));
    setChart('wk', stackedBars(wk.canvas, wlabels, [
      { label: 'Critical', data: d.weeks.map((w) => w.critical), color: '#ef4444' },
      { label: 'Warning', data: d.weeks.map((w) => w.warning), color: '#f59e0b' },
      { label: 'Info', data: d.weeks.map((w) => w.info), color: '#3b82f6' },
    ], { onPick: (i, ds) => ctx.navigate(L(`${BASE}/incidents`, { week: String(d.weeks[i].start), severity: ['critical', 'warning', 'info'][ds] })) }));

    // SLO table + active incidents
    const sortBurn = ctx.params.get('sort') === 'burn';
    const sloRows = [...d.slos].sort(sortBurn ? (a, b) => b.burn1h - a.burn1h : (a, b) => a.budgetLeft - b.budgetLeft);
    const sloEl = panel('Service level objectives', 'check', table([
      { label: 'SLO', value: (s) => h('div', {}, h('b', {}, s.name), h('div', { class: 'dim', style: { fontSize: '11px' } }, `target ${s.target}%`)) },
      { label: 'Now', value: (s) => h('span', { class: s.current < s.target ? 'c-red' : '' }, `${s.current.toFixed(3)}%`), num: true },
      { label: 'Budget left', value: (s) => budgetBar(s.budgetLeft) },
      { label: 'Burn 1h', value: (s) => burn(s.burn1h), num: true },
      { label: 'Status', value: (s) => sloPill(s.status) },
    ], sloRows, { max: 8, onRow: (s) => ctx.navigate(L(`${BASE}/slos/${s.id}`)), empty: ['No SLOs', ''] }), { extra: h('span', { class: 'dim', style: { fontSize: '11px' } }, sortBurn ? 'sorted by burn rate' : 'least budget first') });
    sloEl.id = 'sre-slos';
    const open = d.incidents.filter((x) => x.status !== 'resolved');
    body.append(h('div', { class: 'ov-row persona-row-2b' }, sloEl,
      panel('Active incidents', 'incident', table([
        { label: 'Sev', value: (x) => sevPill(x.severity) },
        { label: 'Incident', value: (x) => h('div', {}, h('b', {}, x.title), h('div', { class: 'dim', style: { fontSize: '11px' } }, `INC-${x.id} · ${x.service}`)) },
        { label: 'Status', value: (x) => incPill(x.status) },
        { label: 'Age', value: (x) => h('span', { class: 'dim' }, since(x.startedAt).replace(' ago', '')) },
      ], open, { onRow: (x) => ctx.navigate(L(`${BASE}/incidents/${x.id}`)), empty: ['No open incidents', 'All quiet. Good time to work on reliability.'] }), { link: L(`${BASE}/incidents`) })));

    // on-call + actions
    body.append(h('div', { class: 'ov-row persona-row-2b' },
      panel('On call now', 'user', table([
        { label: 'Team', value: (o) => h('b', {}, o.team) },
        { label: 'Primary', value: (o) => o.primary },
        { label: 'Secondary', value: (o) => h('span', { class: 'dim' }, o.secondary) },
        { label: 'Until', value: (o) => h('span', { class: 'dim' }, dateTime(o.until).slice(5, 16)) },
        { label: '', value: () => notConnected('bell', 'Page', NEEDS.paging) },
      ], d.onCall)),
      panel('Quick actions', 'activity', quickActions([
        { ic: 'incident', label: 'Declare incident', sub: 'You become commander', onclick: () => declareModal(ctx) },
        { ic: 'bellOff', label: 'Silence an alert', sub: 'Maintenance window', href: ctx.link('/alerting') },
        { ic: 'list', label: 'Write a postmortem', sub: 'Resolved incidents without one', href: L(`${BASE}/incidents`, { status: 'resolved', postmortem: 'todo' }) },
        { ic: 'insights', label: 'Capacity forecasts', sub: 'What fills up next', href: ctx.link('/insights') },
      ]))));
  }

  refresh();
  return { refresh: () => refresh(true) };
}

// ======================= incident list =======================
export function sreIncidents(main, ctx) {
  const f = { ...readF(ctx), status: ctx.params.get('status') || '', severity: ctx.params.get('severity') || '', week: ctx.params.get('week') || '', postmortem: ctx.params.get('postmortem') || '' };
  const filters = h('div');
  const body = h('div', {}, loadingSkeleton(0));
  main.append(detailHead('incident', 'Reliability', 'Incidents', 'Every incident, newest first. Click one to work on it.', [
    back(ctx, readF(ctx)),
    h('button', { class: 'btn btn-sm btn-danger', onclick: () => declareModal(ctx) }, icon('incident', 13), 'Declare incident'),
  ]), filters, body);
  async function refresh() {
    clear(filters).append(filterBar(ctx, [
      { key: 'status', label: 'Any status', options: [['open', 'Open (not resolved)'], ...STATUS_FLOW.map((s) => [s, STATUS_LABEL[s]])] },
      { key: 'severity', label: 'Any severity', options: [['critical', 'Critical'], ['warning', 'Warning'], ['info', 'Info']] },
      { key: 'team', label: 'All teams', options: TEAMS.map((t) => [t, t]) },
    ], f, refresh));
    if (f.week) filters.firstChild.append(h('span', { class: 'chip-filter' }, `Week of ${new Date(Number(f.week)).toLocaleDateString()}`, h('button', { 'aria-label': 'Remove week filter', onclick: () => { f.week = ''; history.replaceState({}, '', ctx.link(location.pathname, f)); refresh(); } }, icon('x', 11))));
    let d;
    try { d = await mockFetch(() => sreData(args(ctx, { team: f.team, service: f.service }))); } catch (e) { clear(body).append(errorState(e.message, refresh)); return; }
    let rows = d.incidents;
    if (f.status === 'open') rows = rows.filter((x) => x.status !== 'resolved'); else if (f.status) rows = rows.filter((x) => x.status === f.status);
    if (f.severity) rows = rows.filter((x) => x.severity === f.severity);
    if (f.postmortem) rows = rows.filter((x) => x.postmortem === f.postmortem);
    if (f.week) rows = rows.filter((x) => x.startedAt >= Number(f.week) && x.startedAt < Number(f.week) + 7 * 86400_000);
    clear(body).append(h('div', { class: 'muted', style: { marginBottom: '8px' } }, `${rows.length} incident(s)`), table([
      { label: 'Sev', value: (x) => sevPill(x.severity) },
      { label: 'Incident', value: (x) => h('div', {}, h('b', {}, x.title), h('div', { class: 'dim', style: { fontSize: '11px' } }, `INC-${x.id} · ${x.service} · ${x.team}`)) },
      { label: 'Status', value: (x) => incPill(x.status) },
      { label: 'Commander', value: (x) => x.commander || h('span', { class: 'dim' }, 'nobody yet') },
      { label: 'Started', value: (x) => h('span', { class: 'dim', title: dateTime(x.startedAt) }, since(x.startedAt)) },
      { label: 'Duration', value: (x) => (x.resolvedAt ? mins((x.resolvedAt - x.startedAt) / 60_000) : h('span', { class: 'c-orange' }, 'ongoing')), num: true },
      { label: 'Postmortem', value: (x) => (x.postmortem === 'done' ? h('span', { class: 'pill st-ok' }, 'Done') : x.postmortem === 'todo' ? h('span', { class: 'pill st-slow' }, 'To do') : '') },
    ], rows, { onRow: (x) => ctx.navigate(ctx.link(`${BASE}/incidents/${x.id}`, readF(ctx))), empty: ['No incidents match', 'Change the filters to see more.'] }));
  }
  refresh();
  return { refresh };
}

// ======================= incident workflow =======================
const RUNBOOK = [
  'Confirm customer impact (error rate, failed checkouts, support tickets)',
  'Check the latest deployment of the service and its dependencies',
  'Post an update in the incident channel and the status page',
  'Mitigate: roll back, scale up, or fail over',
  'Confirm metrics are back to normal for 15 minutes',
];
const NEXT_ACTION = { detected: 'Acknowledge', acknowledged: 'Start investigating', investigating: 'Mark mitigated', mitigated: 'Resolve' };

export function sreIncident(main, ctx) {
  const id = location.pathname.split('/')[4];
  const f = readF(ctx);
  const page = detailPage(main, {
    load: () => mockFetch(() => incidentById(ctx.env, id), { delay: 200 }),
    notFound: ['Incident not found', `There is no incident INC-${id}.`, linkBtn(ctx.link(`${BASE}/incidents`, f), 'arrowLeft', 'All incidents')],
    render(body, x) { draw(body, x); },
  });

  function draw(body, x) {
    clear(body);
    const idx = STATUS_FLOW.indexOf(x.status);
    const user = me(ctx);
    const advance = () => {
      const next = STATUS_FLOW[idx + 1];
      const patch = { status: next };
      if (next === 'acknowledged') { patch.ackAt = Date.now(); patch.commander = x.commander || user; }
      if (next === 'resolved') { patch.resolvedAt = Date.now(); patch.postmortem = 'todo'; }
      const nx = updateIncident(ctx.env, x.id, patch, { kind: 'status', actor: user, text: STATUS_LABEL[next] });
      toast(`INC-${x.id}: ${STATUS_LABEL[next]}`);
      draw(body, nx);
    };
    const note = h('textarea', { class: 'input', id: 'inc-note', rows: 2, placeholder: 'Add an update: what you found, what you are trying next...' });
    const sloHit = slos({ ...args(ctx), service: x.service }).filter((s) => s.status !== 'healthy');
    body.append(
      detailHead('incident', `Incident INC-${x.id} · ${x.env}`, [x.title, ' ', sevPill(x.severity)], `${x.service} · team ${x.team} · started ${dateTime(x.startedAt)} (${since(x.startedAt)})`, [
        linkBtn(ctx.link(`${BASE}/incidents`, f), 'arrowLeft', 'All incidents'),
        x.status !== 'resolved' ? notConnected('bell', 'Page on-call', NEEDS.paging) : null,
        x.status !== 'resolved' ? h('button', { class: 'btn btn-sm btn-primary', onclick: advance }, icon('check', 13), NEXT_ACTION[x.status]) : null,
        x.status === 'resolved' ? linkBtn(ctx.link(`${BASE}/incidents/${x.id}/postmortem`, f), 'list', x.postmortem === 'done' ? 'View postmortem' : 'Write postmortem', 'btn btn-sm btn-primary') : null,
      ]),
      h('div', { class: 'stepper' }, STATUS_FLOW.map((s, i) => h('div', { class: `step ${i < idx || x.status === 'resolved' ? 'done' : i === idx ? 'now' : ''}` }, h('i', {}, i < idx || x.status === 'resolved' ? icon('check', 11) : String(i + 1)), h('span', {}, STATUS_LABEL[s])))),
      h('div', { class: 'grid cards-4', style: { margin: '14px 0' } },
        miniStat('Commander', x.commander || 'nobody yet', x.comms ? `comms: ${x.comms}` : null),
        miniStat('Customers affected', x.customersAffected ? fmt(x.customersAffected, 'short', 1) : 'measuring', 'estimated from failed requests'),
        miniStat('Time to acknowledge', x.ackAt ? mins((x.ackAt - x.startedAt) / 60_000) : 'not yet', null, x.ackAt ? '' : 'c-orange'),
        miniStat(x.resolvedAt ? 'Time to resolve' : 'Open for', mins(((x.resolvedAt || Date.now()) - x.startedAt) / 60_000))),
      h('div', { class: 'ov-row persona-row-2b', style: { marginTop: 0 } },
        panel('Timeline', 'clock', h('div', {},
          h('ol', { class: 'inc-tl' }, [...x.events].sort((a, b) => a.at - b.at).map((e) => h('li', { class: `k-${e.kind}` },
            h('span', { class: 'dim' }, dateTime(e.at).slice(5, 16)), h('div', {}, h('b', {}, e.actor), ' ', e.text)))),
          x.status !== 'resolved' ? h('div', { class: 'note-box' }, note, h('button', { class: 'btn btn-sm btn-primary', onclick: () => {
            if (!note.value.trim()) return toast('Write an update first', 'err');
            const nx = updateIncident(ctx.env, x.id, {}, { kind: 'note', actor: user, text: note.value.trim() });
            toast('Update added'); draw(body, nx);
          } }, 'Post update')) : null)),
        h('div', { class: 'stack-col' },
          panel('Runbook', 'list', h('div', { class: 'checklist' }, RUNBOOK.map((t, i) => h('label', { class: 'check-row' },
            h('input', { type: 'checkbox', id: `rb-${i}`, checked: !!x.checklist?.[i] || idx >= 3 && i < 4, disabled: x.status === 'resolved', onchange: (e) => {
              updateIncident(ctx.env, x.id, { checklist: { ...(x.checklist || {}), [i]: e.target.checked } });
              x.checklist = { ...(x.checklist || {}), [i]: e.target.checked };
            } }), h('span', {}, t))))),
          panel('Impact and links', 'search', h('div', {},
            sloHit.length ? h('div', { class: 'dim', style: { fontSize: '12px', marginBottom: '6px' } }, 'SLOs hit by this incident') : null,
            ...sloHit.map((s) => h('a', { class: 'slo-link', href: ctx.link(`${BASE}/slos/${s.id}`, f), 'data-link': true }, h('span', {}, s.name), budgetBar(s.budgetLeft))),
            quickActions([
              { ic: 'logs', label: 'Logs', sub: `${x.service}, errors`, href: ctx.link('/logs', { q: `{service_name="${x.service}"} |= "ERROR"` }) },
              { ic: 'cube', label: 'Service health', sub: x.service, href: ctx.link(`/views/developer/services/${x.service}`) },
              { ic: 'upload', label: 'Recent deployments', sub: x.service, href: ctx.link('/views/devops/deployments', { service: x.service }) },
            ]))))));
  }
  return page;
}

// ======================= postmortem =======================
export function srePostmortem(main, ctx) {
  const id = location.pathname.split('/')[4];
  const f = readF(ctx);
  return detailPage(main, {
    load: () => mockFetch(() => incidentById(ctx.env, id), { delay: 200 }),
    notFound: ['Incident not found', '', linkBtn(ctx.link(`${BASE}/incidents`, f), 'arrowLeft', 'All incidents')],
    render(body, x) {
      if (x.status !== 'resolved') {
        body.append(h('div', { class: 'state-box' }, emptyState('Resolve the incident first', 'A postmortem is written after the incident is resolved.', linkBtn(ctx.link(`${BASE}/incidents/${x.id}`, f), 'arrowLeft', `Back to INC-${x.id}`, 'btn btn-primary'))));
        return;
      }
      const done = x.postmortem === 'done';
      const area = (idf, label, text, rows = 3) => field(label, h('textarea', { class: 'input', id: idf, rows, disabled: done }, text));
      const dur = mins((x.resolvedAt - x.startedAt) / 60_000);
      body.append(
        detailHead('list', `Postmortem · INC-${x.id}`, x.title, `Blameless review · ${x.service} · lasted ${dur}`, [
          linkBtn(ctx.link(`${BASE}/incidents/${x.id}`, f), 'arrowLeft', `INC-${x.id}`),
          done ? h('span', { class: 'pill st-ok' }, 'Published') : h('button', { class: 'btn btn-sm btn-primary', onclick: () => {
            updateIncident(ctx.env, x.id, { postmortem: 'done' }, { kind: 'note', actor: me(ctx), text: 'Postmortem published' });
            toast('Postmortem published'); ctx.navigate(ctx.link(`${BASE}/incidents/${x.id}`, f));
          } }, icon('check', 13), 'Publish postmortem'),
        ]),
        h('div', { class: 'pm-grid' },
          panel('Write-up', 'edit', h('div', { class: 'pm-form' },
            area('pm-summary', 'Summary', `${x.title}. ${x.customersAffected} customers were affected for ${dur}.`),
            area('pm-cause', 'Root cause', 'A configuration change in the new release reduced the connection pool size, so requests queued and timed out under normal load.'),
            area('pm-detect', 'How we found out', `An alert fired ${x.ackAt ? mins((x.ackAt - x.startedAt) / 60_000) : 'a few minutes'} before the first customer report.`, 2),
            area('pm-learn', 'What went well / what did not', 'Rollback was quick. The alert had no runbook link, so the first responder lost time finding the dashboard.', 3))),
          h('div', { class: 'stack-col' },
            panel('Action items', 'check', table([
              { label: 'Action', value: (a) => a[0] },
              { label: 'Owner', value: (a) => h('span', { class: 'dim' }, a[1]) },
              { label: 'Due', value: (a) => h('span', { class: 'dim' }, a[2]) },
            ], [
              ['Add a test for pool size in the release pipeline', x.commander || 'team', '2 weeks'],
              ['Link the runbook from the alert', x.comms || 'SRE', '1 week'],
              [`Add a latency SLO for ${x.service}`, 'SRE', '1 month'],
            ])),
            panel('Timeline', 'clock', h('ol', { class: 'inc-tl' }, [...x.events].sort((a, b) => a.at - b.at).map((e) => h('li', { class: `k-${e.kind}` }, h('span', { class: 'dim' }, dateTime(e.at).slice(11, 16)), h('div', {}, e.text))))))));
    },
  });
}

// ======================= SLO detail =======================
export function sreSlo(main, ctx) {
  const setChart = chartSlots(ctx);
  const id = location.pathname.split('/').pop();
  const f = readF(ctx);
  return detailPage(main, {
    load: () => mockFetch(() => slos(args(ctx)).find((s) => s.id === id) || null),
    notFound: ['SLO not found', '', back(ctx, f)],
    render(body, s) {
      const sli = chartBox(230), bd = chartBox(230);
      const minsLeft = Math.max(0, s.budgetLeft) / 100 * (100 - s.target) / 100 * 30 * 24 * 60;
      body.append(
        detailHead('check', `SLO · ${s.service}`, [s.name, ' ', sloPill(s.status)], s.description, [
          back(ctx, f),
          linkBtn(ctx.link(`/views/developer/services/${s.service}`), 'cube', 'Service'),
          h('button', { class: 'btn btn-sm', onclick: () => declareModal(ctx, { service: s.service, title: `${s.name} is burning error budget`, severity: 'warning' }) }, icon('incident', 13), 'Declare incident'),
        ]),
        h('div', { class: 'grid cards-4', style: { marginBottom: '14px' } },
          miniStat('Target', `${s.target}%`, 'rolling 30 days'),
          miniStat('Current', `${s.current.toFixed(3)}%`, null, s.current < s.target ? 'c-red' : 'c-green'),
          miniStat('Budget left', `${s.budgetLeft.toFixed(1)}%`, s.kind === 'availability' ? `about ${Math.round(minsLeft)} min of full downtime` : 'of slow requests allowed', s.budgetLeft <= 0 ? 'c-red' : ''),
          miniStat('Burn rate (1 h)', `${s.burn1h.toFixed(1)}x`, s.burn1h >= 1 ? `at this rate the budget lasts ${Math.max(0, (s.budgetLeft / 100) * 30 / s.burn1h).toFixed(1)} days` : 'slower than allowed', s.burn1h >= 2 ? 'c-red' : '')),
        h('div', { class: 'ov-row persona-row-2', style: { marginTop: 0 } },
          panel('Measured vs target', 'activity', sli.el),
          panel('Error budget left', 'pulse', bd.el)),
        h('div', { class: 'ov-row persona-row-2b' },
          panel('Burn rate by window', 'timer', h('div', { class: 'burn-grid' }, [['1 hour', s.burn1h, 14], ['6 hours', s.burn6h, 6], ['24 hours', s.burn24h, 3], ['3 days', s.burn3d, 1]].map(([w, v, limit]) =>
            h('div', { class: 'burn-cell' }, h('span', { class: 'dim' }, w), h('b', { class: v >= limit ? 'c-red' : v >= 1 ? 'c-orange' : 'c-green' }, `${v.toFixed(1)}x`), h('small', { class: 'dim' }, `alert at ${limit}x`))))),
          panel('Alert rules for this SLO', 'bell', h('ul', { class: 'plain-list' }, s.alerting.map((a) => h('li', {}, a))))));
      setChart('sli', lineDrill(sli.canvas, [{ label: 'measured %', points: s.sli, color: '#3b82f6' }, { label: 'target', points: s.sli.map(([t]) => [t, s.target]), color: '#ef4444' }], { unit: 'none' }));
      setChart('bd', lineDrill(bd.canvas, [{ label: 'budget left %', points: s.burnDown, color: budgetTone(s.budgetLeft) }], { unit: 'percent', area: true, legend: false }));
    },
  });
}
