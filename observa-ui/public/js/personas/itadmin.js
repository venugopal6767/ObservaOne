// IT / Platform Administrator: "is the monitoring platform itself healthy, are agents reporting,
// are we inside our licence and storage, and is access under control?" Sample data for now.
import { h, clear, icon, dateTime, emptyState } from '../ui.js';
import { chartSlots } from '../pages/common.js';
import { mockFetch } from './mock.js';
import { adminData, agentDetail, componentDetail, ingestionDetail, PLATFORMS } from './mock-admin.js';
import { personaById } from './registry.js';
import {
  personaHead, filterBar, kpiCard, panel, chartBox, lineDrill, stackedBars, table, quickActions, loadingSkeleton, errorState,
  statusPill, since, detailHead, miniStat, linkBtn, detailPage, barCats, meter,
  attentionStrip, stampFresh,
  notConnected, NEEDS,
} from './widgets.js';

const persona = { ...personaById('itadmin'), title: 'Platform administration' };
const BASE = '/views/itadmin';
const KEYS = ['platform'];
const readF = (ctx) => Object.fromEntries(KEYS.map((k) => [k, ctx.params.get(k) || '']));
const args = (ctx, f = {}) => { const { start, end } = ctx.range; return { env: ctx.env, start, end, ...f }; };
const back = (ctx, f) => linkBtn(ctx.link(BASE, f), 'arrowLeft', 'Platform admin');
const gb = (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} TB` : `${v.toFixed(v < 10 ? 1 : 0)} GB`);
const AG = { online: ['Online', 'st-ok'], degraded: ['Struggling', 'st-slow'], offline: ['Offline', 'st-err'] };
const agPill = (s) => h('span', { class: `pill ${AG[s][1]}` }, AG[s][0]);
const platLabel = (p) => PLATFORMS.find(([k]) => k === p)?.[1] || p;
const dayLabel = (ms) => new Date(ms).toLocaleDateString(undefined, { day: '2-digit', month: 'short' });

// ======================= dashboard =======================
export function itAdminDashboard(main, ctx) {
  const setChart = chartSlots(ctx);
  const f = readF(ctx);
  const filters = h('div');
  const body = h('div');
  main.append(personaHead(ctx, persona, { actions: [linkBtn(ctx.link('/agents', { tab: 'install' }), 'plus', 'Install agent', 'btn btn-sm btn-primary')] }), filters, body);
  const defs = [{ key: 'platform', label: 'All platforms', options: PLATFORMS }];

  async function refresh(silent = false) {
    clear(filters).append(filterBar(ctx, defs, f, () => refresh()));
    if (!silent) clear(body).append(loadingSkeleton(6));
    let d;
    try { d = await mockFetch((empty) => adminData({ ...args(ctx, f), empty })); } catch (e) { clear(body).append(errorState(e.message, () => refresh())); return; }
    draw(d);
    stampFresh();
  }

  function draw(d) {
    clear(body);
    if (!d.components.length) {
      body.append(h('div', { class: 'state-box' }, emptyState('Nothing reporting yet', 'Install an agent on a server to start collecting data.', linkBtn(ctx.link('/agents', { tab: 'install' }), 'plus', 'Install agent', 'btn btn-primary'))));
      return;
    }
    const k = d.kpi;
    const L = (path, extra = {}) => ctx.link(path, { ...f, ...extra });
    const offline = d.agents.filter((a) => a.status === 'offline');
    const down = d.datasources.filter((x) => x.status !== 'connected');
    const licPct = (k.ingestToday / d.licenceGbDay) * 100;
    body.append(attentionStrip([
      down.length && { level: 'critical', text: `${down[0].name} is not reachable`, detail: `${down[0].kind} stops working until it is back`, action: { label: 'Check connection', href: ctx.link('/datasources') } },
      offline.length && { level: 'critical', text: `${offline.length} agent${offline.length > 1 ? 's' : ''} stopped reporting`, detail: `${offline.map((a) => a.host).slice(0, 3).join(', ')}`, action: { label: 'Open agent', href: L(`${BASE}/agents/${offline[0].host}`) } },
      licPct > 85 && { level: licPct > 100 ? 'critical' : 'warning', text: `Data in is at ${licPct.toFixed(0)}% of the daily licence`, detail: 'extra data may be dropped above 100%', action: { label: 'Top senders', href: L(`${BASE}/ingestion`) } },
      k.soonestFull.daysToFull < 45 && { level: k.soonestFull.daysToFull < 21 ? 'critical' : 'warning', text: `${k.soonestFull.name} disk full in ${Math.round(k.soonestFull.daysToFull)} days`, detail: `growing ${gb(k.soonestFull.growthGbDay)} a day`, action: { label: 'Make room', href: L(`${BASE}/components/${k.soonestFull.id}`) } },
    ]));
    const lic = (k.ingestToday / d.licenceGbDay) * 100;
    const stor = (k.storageUsed / k.storageCap) * 100;
    body.append(h('div', { class: 'ov-kpis persona-kpis-6' },
      kpiCard(setChart, { ic: 'agent', tone: k.offline ? 'red' : 'green', title: 'Agents online', value: `${k.online}/${k.agents}`, href: '#adm-agents',
        foot: [h('span', { class: k.offline ? 'c-red' : 'dim' }, `${k.offline} offline`), h('span', { class: 'c-orange' }, `${k.outdated} outdated`)] }),
      kpiCard(setChart, { ic: 'datasources', tone: k.dsOk === k.ds ? 'green' : 'red', title: 'Data sources', value: `${k.dsOk}/${k.ds}`, href: '#adm-ds',
        foot: [h('span', { class: k.dsOk === k.ds ? 'dim' : 'c-red' }, k.dsOk === k.ds ? 'all connected' : `${k.ds - k.dsOk} down`)] }),
      kpiCard(setChart, { ic: 'upload', tone: lic > 90 ? 'red' : lic > 75 ? 'orange' : 'blue', title: 'Data in today', value: gb(k.ingestToday), href: L(`${BASE}/ingestion`),
        foot: [h('span', { class: lic > 90 ? 'c-red' : 'dim' }, `${lic.toFixed(0)}% of ${d.licenceGbDay} GB/day licence`)] }),
      kpiCard(setChart, { ic: 'disk', tone: stor > 80 ? 'red' : 'purple', title: 'Storage used', value: gb(k.storageUsed), href: '#adm-components',
        foot: [h('span', { class: 'dim' }, `${stor.toFixed(0)}% of ${gb(k.storageCap)}`)] }),
      kpiCard(setChart, { ic: 'clock', tone: k.soonestFull.daysToFull < 30 ? 'red' : 'green', title: 'First store full in', value: `${Math.round(k.soonestFull.daysToFull)}`, unit: 'days', href: L(`${BASE}/components/${k.soonestFull.id}`),
        foot: [h('span', { class: 'dim' }, `${k.soonestFull.name} at today's growth`)] }),
      kpiCard(setChart, { ic: 'user', tone: d.users.mfaPct < 90 ? 'orange' : 'green', title: 'Active users (24 h)', value: String(d.users.active24h), href: '#adm-access',
        foot: [h('span', { class: 'dim' }, `of ${d.users.total}`), h('span', { class: d.users.mfaPct < 90 ? 'c-orange' : 'c-green' }, `MFA ${d.users.mfaPct.toFixed(0)}%`)] })));

    // ingestion vs licence + storage per store
    const ing = chartBox(240), st = chartBox(240);
    body.append(h('div', { class: 'ov-row persona-row-2' },
      panel('Data in per day vs licence', 'upload', h('div', {}, ing.el, h('div', { class: 'dim chart-hint' }, `The red line is the ${d.licenceGbDay} GB/day licence. Click a day to see who sent the data.`)), { link: L(`${BASE}/ingestion`), linkLabel: 'Details' }),
      panel('Storage used per store', 'disk', h('div', {}, st.el, h('div', { class: 'dim chart-hint' }, 'Percent of each store\'s disk. Click a bar to open the store.')))));
    const ch = stackedBars(ing.canvas, d.days.map((x) => dayLabel(x.day)), [
      { label: 'Logs', data: d.days.map((x) => Number(x.logs.toFixed(1))), color: '#3b82f6' },
      { label: 'Metrics', data: d.days.map((x) => Number(x.metrics.toFixed(1))), color: '#22c55e' },
      { label: 'Traces', data: d.days.map((x) => Number(x.traces.toFixed(1))), color: '#a855f7' },
    ], { onPick: (i) => ctx.navigate(L(`${BASE}/ingestion`, { day: String(d.days[i].day) })) });
    ch.data.datasets.push({ type: 'line', label: 'Licence', data: d.days.map(() => d.licenceGbDay), borderColor: '#ef4444', borderDash: [5, 4], pointRadius: 0, borderWidth: 1.5, stack: 'licence' });
    ch.options.scales.y.ticks.callback = (v) => `${v} GB`;
    ch.update('none');
    setChart('ing', ch);
    const stores = d.components.filter((c) => c.store);
    setChart('st', barCats(st.canvas, stores.map((c) => c.name), stores.map((c) => Number(((c.usedGb / c.capGb) * 100).toFixed(1))), {
      unit: 'percent', colors: stores.map((c) => (c.usedGb / c.capGb > 0.8 ? '#ef4444' : c.usedGb / c.capGb > 0.65 ? '#f59e0b' : '#22c55e')),
      onPick: (i) => ctx.navigate(L(`${BASE}/components/${stores[i].id}`)),
    }));

    // agents + platform components
    const agEl = panel('Agents', 'agent', table([
      { label: 'Host', value: (a) => h('div', {}, h('b', {}, a.host), h('div', { class: 'dim', style: { fontSize: '11px' } }, `${platLabel(a.platform)} · ${a.env}`)) },
      { label: 'Status', value: (a) => agPill(a.status) },
      { label: 'Version', value: (a) => h('span', { class: a.outdated ? 'c-orange' : 'dim' }, a.outdated ? `${a.version} (old)` : a.version) },
      { label: 'Last seen', value: (a) => h('span', { class: a.status === 'offline' ? 'c-red' : 'dim' }, since(a.lastSeen)) },
    ], d.agents, { max: 8, onRow: (a) => ctx.navigate(L(`${BASE}/agents/${a.host}`)), empty: ['No agents', 'No agents on this platform.'] }), { link: ctx.link('/agents'), linkLabel: 'Agents page' });
    agEl.id = 'adm-agents';
    const compEl = panel('Platform components', 'server', table([
      { label: 'Component', value: (c) => h('div', {}, h('b', {}, c.name), h('div', { class: 'dim', style: { fontSize: '11px' } }, `${c.role} · ${c.version}`)) },
      { label: 'Status', value: (c) => statusPill(c.status) },
      { minor: true, label: 'CPU', value: (c) => meter(c.cpu) },
      { label: 'Disk', value: (c) => (c.store ? meter((c.usedGb / c.capGb) * 100, 65, 80) : h('span', { class: 'dim' }, '-')) },
    ], d.components, { onRow: (c) => ctx.navigate(L(`${BASE}/components/${c.id}`)) }));
    compEl.id = 'adm-components';
    body.append(h('div', { class: 'ov-row persona-row-2b' }, agEl, compEl));

    // data sources + access + actions
    const u = d.users;
    const dsEl = panel('Data sources', 'datasources', table([
      { label: 'Source', value: (x) => h('div', {}, h('b', {}, x.name), h('div', { class: 'dim', style: { fontSize: '11px' } }, x.kind)) },
      { label: 'Status', value: (x) => h('span', { class: `pill ${x.status === 'connected' ? 'st-ok' : 'st-err'}` }, x.status === 'connected' ? 'Connected' : 'Down') },
      { label: 'Response', value: (x) => (x.status === 'connected' ? `${Math.round(x.latency)} ms` : '-'), num: true },
    ], d.datasources, { onRow: () => ctx.navigate(ctx.link('/datasources')) }), { link: ctx.link('/datasources'), linkLabel: 'Manage' });
    dsEl.id = 'adm-ds';
    const accEl = panel('Users and access', 'user', h('div', {},
      h('div', { class: 'kv-row' }, h('span', { class: 'dim' }, 'Users'), h('b', {}, `${u.total} (${u.admins} admins)`)),
      h('div', { class: 'kv-row' }, h('span', { class: 'dim' }, 'MFA turned on'), h('b', { class: u.mfaPct < 90 ? 'c-orange' : 'c-green' }, `${u.mfaPct.toFixed(0)}%`)),
      h('div', { class: 'kv-row' }, h('span', { class: 'dim' }, 'Sign in with SSO / LDAP'), h('b', {}, `${u.ssoPct.toFixed(0)}%`)),
      h('div', { class: 'kv-row' }, h('span', { class: 'dim' }, 'Never signed in'), h('b', { class: u.neverSignedIn ? 'c-orange' : '' }, String(u.neverSignedIn))),
      h('div', { class: 'kv-row' }, h('span', { class: 'dim' }, 'API keys expiring in 14 days'), h('b', { class: u.keysExpiring ? 'c-orange' : '' }, String(u.keysExpiring))),
      h('div', { class: 'qa-row', style: { justifyContent: 'flex-start' } }, linkBtn(ctx.link('/settings', { tab: 'users' }), 'user', 'Users'), linkBtn(ctx.link('/settings', { tab: 'security' }), 'shield', 'MFA policy'), linkBtn(ctx.link('/settings', { tab: 'audit' }), 'list', 'Audit log'))));
    accEl.id = 'adm-access';
    body.append(h('div', { class: 'ov-row ov-row-c' }, dsEl, accEl,
      panel('Quick actions', 'activity', quickActions([
        { ic: 'refresh', label: 'Upgrade old agents', unavailable: NEEDS.agents },
        { ic: 'plus', label: 'Install an agent', sub: 'Linux, Windows, Docker, K8s', href: ctx.link('/agents', { tab: 'install' }) },
        { ic: 'datasources', label: 'Test all data sources', sub: 'Check connections now', href: ctx.link('/datasources') },
        { ic: 'download', label: 'Back up the database', unavailable: NEEDS.backup },
      ]))));
  }

  refresh();
  return { refresh: () => refresh(true) };
}

// ======================= agent =======================
export function itAdminAgent(main, ctx) {
  const setChart = chartSlots(ctx);
  const host = decodeURIComponent(location.pathname.split('/').pop());
  const f = readF(ctx);
  return detailPage(main, {
    load: () => mockFetch(() => agentDetail(args(ctx), host)),
    notFound: ['Agent not found', '', back(ctx, f)],
    render(body, d) {
      const a = d.a;
      const s = chartBox(200), q = chartBox(200);
      body.append(
        detailHead('agent', `Agent · ${platLabel(a.platform)}`, [a.host, ' ', agPill(a.status)], `${a.ip} · ${a.env} · version ${a.version}${a.outdated ? ' (an upgrade is available)' : ''}`, [
          back(ctx, f),
          notConnected('refresh', 'Restart', NEEDS.agents),
          a.outdated ? notConnected('upload', 'Upgrade', NEEDS.agents) : null,
        ]),
        a.status === 'offline' ? h('div', { class: 'error-box', style: { marginBottom: '14px' } }, icon('alert', 16), h('span', {}, `No data since ${dateTime(a.lastSeen)}. Check the server is on and that it can reach the platform on port 443.`)) : null,
        a.status === 'degraded' ? h('div', { class: 'error-box warn', style: { marginBottom: '14px' } }, icon('alert', 16), h('span', {}, `The send queue is ${a.queue}% full and ${a.sendErrors} sends failed. The platform may be rate-limiting it, or the network is slow.`)) : null,
        h('div', { class: 'grid cards-4', style: { marginBottom: '14px' } },
          miniStat('Last seen', since(a.lastSeen), dateTime(a.lastSeen), a.status === 'offline' ? 'c-red' : ''),
          miniStat('Metrics sent', `${Math.round(a.samples)}/s`), miniStat('Log lines sent', `${Math.round(a.logs)}/s`), miniStat('Running for', `${a.uptimeDays} days`)),
        h('div', { class: 'ov-row persona-row-2', style: { marginTop: 0 } },
          panel('Metrics sent per second', 'metrics', s.el),
          panel('Send queue (% full)', 'list', q.el)),
        h('div', { class: 'ov-row persona-row-2b' },
          panel('What it collects', 'list', h('ul', { class: 'plain-list' }, d.receivers.map((x) => h('li', {}, x)))),
          panel('Agent settings', 'settings', h('pre', { class: 'stack' }, d.config))));
      setChart('s', lineDrill(s.canvas, [{ label: 'samples/s', points: d.samples, color: '#22c55e' }], { area: true, legend: false }));
      setChart('q', lineDrill(q.canvas, [{ label: 'queue %', points: d.queue, color: '#f59e0b' }], { unit: 'percent', max: 100, legend: false }));
    },
  });
}

// ======================= platform component =======================
export function itAdminComponent(main, ctx) {
  const setChart = chartSlots(ctx);
  const id = location.pathname.split('/').pop();
  const f = readF(ctx);
  return detailPage(main, {
    load: () => mockFetch(() => componentDetail(args(ctx), id)),
    notFound: ['Component not found', '', back(ctx, f)],
    render(body, c) {
      const cpu = chartBox(200), mem = chartBox(200), grow = chartBox(200);
      const day = 86400;
      const now = Math.floor(Date.now() / 1000);
      body.append(
        detailHead('server', `Platform component · ${c.role}`, [c.name, ' ', statusPill(c.status)], `Version ${c.version} · running for ${c.uptimeDays} days`, [
          back(ctx, f),
          linkBtn(ctx.link('/logs', { q: `{container="${c.id}"}` }), 'logs', 'Logs'),
        ]),
        c.note ? h('div', { class: 'error-box warn', style: { marginBottom: '14px' } }, icon('alert', 16), h('span', {}, c.note)) : null,
        h('div', { class: 'grid cards-4', style: { marginBottom: '14px' } },
          miniStat('CPU', `${c.cpu.toFixed(0)}%`), miniStat('Memory', `${c.mem.toFixed(0)}%`),
          c.store ? miniStat('Disk', `${gb(c.usedGb)} of ${gb(c.capGb)}`, `growing ${gb(c.growthGbDay)} a day`) : miniStat('Disk', 'not a store'),
          c.store ? miniStat('Full in', `${Math.round(c.daysToFull)} days`, `keeps data ${c.retentionDays} days`, c.daysToFull < 30 ? 'c-red' : 'c-green') : miniStat('Role', c.role)),
        h('div', { class: c.store ? 'grid cols-3' : 'ov-row persona-row-2', style: c.store ? {} : { marginTop: 0 } },
          panel('CPU', 'cpu', cpu.el), panel('Memory', 'memory', mem.el), ...(c.store ? [panel('Disk forecast', 'disk', grow.el)] : [])),
        c.store ? h('div', { class: 'ov-row' }, panel('Ways to make room', 'list', h('ul', { class: 'plain-list' },
          h('li', {}, `Lower how long data is kept (now ${c.retentionDays} days). Each day less frees about ${gb(c.growthGbDay)}.`),
          h('li', {}, `Add disk: ${gb(c.capGb * 0.5)} more gives about ${Math.round((c.capGb * 0.5) / c.growthGbDay)} extra days.`),
          h('li', {}, c.id === 'loki' ? 'Drop noisy debug logs at the agent (see top senders on the ingestion page).' : c.id === 'prometheus' ? 'Drop high-cardinality labels that nobody queries.' : 'Sample fewer traces for healthy, high-volume endpoints.')))) : null);
      setChart('cpu', lineDrill(cpu.canvas, [{ label: 'CPU %', points: c.cpuSeries, color: '#3b82f6' }], { unit: 'percent', max: 100, legend: false }));
      setChart('mem', lineDrill(mem.canvas, [{ label: 'Memory %', points: c.memSeries, color: '#a855f7' }], { unit: 'percent', max: 100, legend: false }));
      if (c.store) {
        const hist = Array.from({ length: 30 }, (_, i) => [now - (29 - i) * day, c.usedGb - c.growthGbDay * (29 - i)]);
        const ahead = Math.min(120, Math.ceil(c.daysToFull) + 5);
        const proj = Array.from({ length: ahead }, (_, i) => [now + i * day, Math.min(c.capGb * 1.05, c.usedGb + c.growthGbDay * i)]);
        setChart('grow', lineDrill(grow.canvas, [
          { label: 'used GB', points: hist, color: '#22c55e' },
          { label: 'forecast', points: proj, color: '#f59e0b' },
          { label: 'disk size', points: [[hist[0][0], c.capGb], [proj[proj.length - 1][0], c.capGb]], color: '#ef4444' },
        ], {}));
      }
    },
  });
}

// ======================= ingestion =======================
export function itAdminIngestion(main, ctx) {
  const setChart = chartSlots(ctx);
  const f = { ...readF(ctx), day: ctx.params.get('day') || '' };
  return detailPage(main, {
    load: () => mockFetch(() => ingestionDetail(args(ctx), f.day)),
    notFound: ['No data', '', back(ctx, readF(ctx))],
    render(body, d) {
      const days = chartBox(220), src = chartBox(260);
      const pct = (d.total / d.licence) * 100;
      body.append(
        detailHead('upload', 'Platform admin', `Data in · ${new Date(d.day.day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}`, `${gb(d.total)} received, ${pct.toFixed(0)}% of the ${d.licence} GB/day licence`, [back(ctx, readF(ctx))]),
        h('div', { class: 'grid cards-4', style: { marginBottom: '14px' } },
          miniStat('Logs', gb(d.day.logs)), miniStat('Metrics', gb(d.day.metrics)), miniStat('Traces', gb(d.day.traces)),
          miniStat('Licence used', `${pct.toFixed(0)}%`, pct > 100 ? 'over the limit: extra data may be dropped' : `${gb(d.licence - d.total)} left today`, pct > 90 ? 'c-red' : '')),
        h('div', { class: 'ov-row persona-row-2', style: { marginTop: 0 } },
          panel('Last 14 days', 'activity', h('div', {}, days.el, h('div', { class: 'dim chart-hint' }, 'Click a day to switch to it'))),
          panel('Top senders', 'list', src.el)),
        h('div', { class: 'ov-row' }, panel('Senders', 'list', table([
          { label: 'Service or host', value: (s) => h('b', {}, s.name) },
          { label: 'Logs', value: (s) => gb(s.logs), num: true },
          { label: 'Metrics', value: (s) => gb(s.metrics), num: true },
          { label: 'Traces', value: (s) => gb(s.traces), num: true },
          { label: 'Total', value: (s) => h('b', {}, gb(s.total)), num: true },
          { label: 'Share', value: (s) => meter((s.total / d.total) * 100, 101, 101) },
        ], d.sources))));
      setChart('days', barCats(days.canvas, d.days.map((x) => dayLabel(x.day)), d.days.map((x) => Number((x.logs + x.metrics + x.traces).toFixed(1))), {
        colors: d.days.map((x) => (x.day === d.day.day ? '#3b82f6' : 'rgba(59,130,246,0.35)')),
        onPick: (i) => ctx.navigate(ctx.link(`${BASE}/ingestion`, { ...readF(ctx), day: String(d.days[i].day) }), true),
      }));
      setChart('src', barCats(src.canvas, d.sources.map((s) => s.name), d.sources.map((s) => Number(s.total.toFixed(1))), { horizontal: true }));
    },
  });
}
