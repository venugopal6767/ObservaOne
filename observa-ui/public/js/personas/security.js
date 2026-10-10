// Security Team: "is anyone attacking us, what is exposed, and what must be patched?"
// Detections first, then attack sources, vulnerabilities, exposure and certificates. Sample data for now.
import { h, clear, icon, dateTime, emptyState, toast } from '../ui.js';
import { chartSlots } from '../pages/common.js';
import { mockFetch } from './mock.js';
import { securityData, eventDetail, hostDetail, ipDetail, setEventStatus, blockIp, CATEGORIES } from './mock-sec.js';
import { declareModal } from './sre.js';
import { personaById } from './registry.js';
import {
  personaHead, filterBar, kpiCard, panel, chartBox, stackedBars, table, quickActions, loadingSkeleton, errorState,
  since, detailHead, miniStat, linkBtn, detailPage, barCats, meter,
  attentionStrip, stampFresh,
  notConnected, NEEDS,
} from './widgets.js';

const persona = { ...personaById('security'), title: 'Security' };
const BASE = '/views/security';
const KEYS = ['severity', 'category'];
const readF = (ctx) => Object.fromEntries(KEYS.map((k) => [k, ctx.params.get(k) || '']));
const args = (ctx, f = {}) => { const { start, end } = ctx.range; return { env: ctx.env, start, end, ...f }; };
const back = (ctx, f) => linkBtn(ctx.link(BASE, f), 'arrowLeft', 'Security dashboard');
const SEV = { critical: 'sev-critical', high: 'sev-high', medium: 'sev-warning', low: 'sev-info' };
const sevPill = (s) => h('span', { class: `pill ${SEV[s]}` }, s[0].toUpperCase() + s.slice(1));
const ST = { new: ['New', 'st-open'], investigating: ['Investigating', 'st-inv'], closed: ['Closed', 'st-res'], false_positive: ['False positive', 'st-res'] };
const stPill = (s) => h('span', { class: `pill ${ST[s][1]}` }, ST[s][0]);
const catLabel = (c) => CATEGORIES.find(([k]) => k === c)?.[1] || c;
const riskTone = (v) => (v >= 60 ? '#ef4444' : v >= 30 ? '#f59e0b' : 'rgba(148,163,184,0.45)');
const riskBar = (v) => h('div', { class: 'meter' }, h('i', { style: { width: `${Math.max(3, v)}%`, background: riskTone(v) } }), h('span', {}, String(v)));
const userName = (ctx) => ctx.me.user.displayName || ctx.me.user.username;


// ======================= dashboard =======================
export function securityDashboard(main, ctx) {
  const setChart = chartSlots(ctx);
  const f = readF(ctx);
  const filters = h('div');
  const body = h('div');
  main.append(personaHead(ctx, persona, {
    actions: [linkBtn(ctx.link(`${BASE}/events`, { ...f, status: 'open' }), 'list', 'Open detections')],
  }), filters, body);
  const defs = [
    { key: 'severity', label: 'Any severity', options: [['critical', 'Critical'], ['high', 'High'], ['medium', 'Medium']] },
    { key: 'category', label: 'All categories', options: CATEGORIES },
  ];

  async function refresh(silent = false) {
    clear(filters).append(filterBar(ctx, defs, f, () => refresh()));
    if (!silent) clear(body).append(loadingSkeleton(6));
    let d;
    try { d = await mockFetch((empty) => securityData({ ...args(ctx, f), empty })); } catch (e) { clear(body).append(errorState(e.message, () => refresh())); return; }
    draw(d);
    stampFresh();
  }

  function draw(d) {
    clear(body);
    if (!d.hosts.length) {
      body.append(h('div', { class: 'state-box' }, emptyState('No security data yet', 'Connect a log source with sign-in and host events, and a vulnerability scanner.', linkBtn(ctx.link('/datasources'), 'datasources', 'Data sources', 'btn btn-primary'))));
      return;
    }
    const k = d.kpi;
    const L = (path, extra = {}) => ctx.link(path, { ...f, ...extra });
    const newCrit = d.events.filter((e) => e.sev === 'critical' && e.status === 'new');
    const exploit = d.vulns.filter((v) => v.exploitable);
    const ports = d.hosts.filter((x) => x.ports.some((p) => p !== 443));
    const cert = d.certs.filter((c) => c.days <= 14);
    body.append(attentionStrip([
      newCrit.length && { level: 'critical', text: `${newCrit.length} critical detection${newCrit.length > 1 ? 's' : ''} not triaged`, detail: `${newCrit[0].rule} · ${since(newCrit[0].at)}`, action: { label: 'Triage', href: L(`${BASE}/events/${newCrit[0].id}`) } },
      exploit.length && { level: 'critical', text: `${exploit[0].pkg} on ${exploit[0].host} has a known exploit`, detail: `fixed in ${exploit[0].fixed}${exploit.length > 1 ? ` · ${exploit.length - 1} more` : ''}`, action: { label: 'Patch list', href: L(`${BASE}/hosts/${exploit[0].host}`) } },
      ports.length && { level: 'warning', text: `${ports[0].name} has port ${ports[0].ports.filter((p) => p !== 443).join(', ')} open to the internet`, detail: ports.length > 1 ? `${ports.length - 1} more host${ports.length > 2 ? 's' : ''}` : 'only 443 is expected', action: { label: 'Open host', href: L(`${BASE}/hosts/${ports[0].name}`) } },
      cert.length && { level: 'warning', text: `Certificate for ${cert[0].domain} expires in ${cert[0].days} days`, detail: cert[0].issuer, action: { label: 'Certificates', onclick: () => document.getElementById('sec-certs')?.scrollIntoView({ behavior: 'smooth' }) } },
    ]));
    body.append(h('div', { class: 'ov-kpis persona-kpis-6' },
      kpiCard(setChart, { ic: 'shield', tone: k.critical ? 'red' : 'orange', title: 'Detections', value: String(k.events), href: L(`${BASE}/events`),
        foot: [h('span', { class: 'c-red' }, `${k.critical} critical`), h('span', { class: 'dim' }, `${k.open} not closed`)] }),
      kpiCard(setChart, { ic: 'key', tone: 'orange', title: 'Failed sign-ins', value: String(k.failedSignins), href: L(`${BASE}/events`, { category: 'auth' }),
        foot: [h('span', { class: 'dim' }, `${k.locked} accounts locked`)] }),
      kpiCard(setChart, { ic: 'alert', tone: k.vulnCritical ? 'red' : 'orange', title: 'Vulnerabilities', value: String(k.vulnCritical + k.vulnHigh), href: '#sec-hosts',
        foot: [h('span', { class: 'c-red' }, `${k.vulnCritical} critical`), h('span', { class: 'c-orange' }, `${k.vulnHigh} high`)] }),
      kpiCard(setChart, { ic: 'globe', tone: k.exposed ? 'red' : 'green', title: 'Unexpected open ports', value: String(k.exposed), href: '#sec-hosts',
        foot: [h('span', { class: 'dim' }, 'internet-facing, not HTTPS')] }),
      kpiCard(setChart, { ic: 'lock', tone: k.certsSoon ? 'orange' : 'green', title: 'Certificates expiring', value: String(k.certsSoon), href: '#sec-certs',
        foot: [h('span', { class: 'dim' }, 'within 30 days')] }),
      kpiCard(setChart, { ic: 'user', tone: 'purple', title: 'Risky admin changes', value: String(k.privileged), href: L(`${BASE}/events`, { category: 'config' }),
        foot: [h('span', { class: 'dim' }, 'roles, MFA, public storage')] })));

    const ev = chartBox(240), ips = chartBox(240);
    const fmtB = (ms) => (ctx.rangeSeconds > 2 * 86400 ? new Date(ms).toLocaleDateString(undefined, { day: '2-digit', month: 'short' }) : new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
    body.append(h('div', { class: 'ov-row persona-row-2' },
      panel('Detections over time', 'activity', h('div', {}, ev.el, h('div', { class: 'dim chart-hint' }, 'Click a bar to list those detections'))),
      panel('Top source addresses', 'globe', h('div', {}, ips.el, h('div', { class: 'dim chart-hint' }, 'Events per address. Click a bar to investigate it.')))));
    setChart('ev', stackedBars(ev.canvas, d.buckets.map((b) => fmtB(b.from)), [
      { label: 'Critical', data: d.buckets.map((b) => b.critical), color: '#ef4444' },
      { label: 'High', data: d.buckets.map((b) => b.high), color: '#f97316' },
      { label: 'Medium', data: d.buckets.map((b) => b.medium), color: '#f59e0b' },
    ], { onPick: (i) => ctx.navigate(L(`${BASE}/events`, { from: String(Math.round(d.buckets[i].from)), to: String(Math.round(d.buckets[i].to)) })) }));
    if (d.topIps.length) {
      setChart('ips', barCats(ips.canvas, d.topIps.map((x) => `${x.ip}${x.blocked ? ' (blocked)' : ''}`), d.topIps.map((x) => x.count), {
        horizontal: true, colors: d.topIps.map((x) => (x.blocked ? '#64748b' : x.reputation === 'known bad' ? '#ef4444' : '#f59e0b')),
        onPick: (i) => ctx.navigate(L(`${BASE}/ips/${d.topIps[i].ip}`)),
      }));
    }

    body.append(h('div', { class: 'ov-row persona-row-2b' },
      panel('Latest detections', 'shield', table([
        { label: 'Severity', value: (e) => sevPill(e.sev) },
        { label: 'Detection', value: (e) => h('div', {}, h('b', {}, e.rule), h('div', { class: 'dim', style: { fontSize: '11px' } }, `${catLabel(e.cat)} · ${e.host} · ${e.ip}`)) },
        { label: 'Status', value: (e) => stPill(e.status) },
        { label: 'When', value: (e) => h('span', { class: 'dim' }, since(e.at)) },
      ], d.events, { max: 7, onRow: (e) => ctx.navigate(L(`${BASE}/events/${e.id}`)), empty: ['No detections', 'Nothing suspicious in this period.'] }), { link: L(`${BASE}/events`) }),
      Object.assign(panel('Hosts at risk', 'server', table([
        { label: 'Host', value: (x) => h('div', {}, h('b', {}, x.name), h('div', { class: 'dim', style: { fontSize: '11px' } }, x.os)) },
        { label: 'Risk', value: (x) => riskBar(x.risk) },
        { minor: true, label: 'Vulns', value: (x) => h('span', { class: x.vulns.some((v) => v.severity === 'critical') ? 'c-red' : '' }, String(x.vulns.length)), num: true },
        { label: 'Open ports', value: (x) => h('span', { class: x.ports.some((p) => p !== 443) ? 'c-red' : 'dim' }, x.ports.length ? x.ports.join(', ') : 'none') },
      ], d.hosts.slice(0, 7), { onRow: (x) => ctx.navigate(L(`${BASE}/hosts/${x.name}`)) })), { id: 'sec-hosts' })));

    body.append(h('div', { class: 'ov-row ov-row-c' },
      Object.assign(panel('Certificates', 'lock', table([
        { label: 'Domain', value: (c) => h('div', {}, h('b', { class: 'mono' }, c.domain), h('div', { class: 'dim', style: { fontSize: '11px' } }, c.issuer)) },
        { label: 'Expires in', value: (c) => h('span', { class: c.days <= 14 ? 'c-red' : c.days <= 30 ? 'c-orange' : 'dim' }, `${c.days} days`), num: true },
      ], d.certs)), { id: 'sec-certs' }),
      panel('Worst vulnerabilities', 'alert', table([
        { label: 'Package', value: (v) => h('div', {}, h('b', {}, v.pkg), h('div', { class: 'dim', style: { fontSize: '11px' } }, `${v.id} · ${v.host}`)) },
        { label: 'Severity', value: (v) => sevPill(v.severity) },
        { label: 'Fix', value: (v) => h('span', { class: 'mono dim' }, v.fixed) },
      ], [...d.vulns].sort((a, b) => ['critical', 'high', 'medium', 'low'].indexOf(a.severity) - ['critical', 'high', 'medium', 'low'].indexOf(b.severity) || b.exploitable - a.exploitable).slice(0, 6),
      { onRow: (v) => ctx.navigate(L(`${BASE}/hosts/${v.host}`)) })),
      panel('Quick actions', 'activity', quickActions([
        { ic: 'list', label: 'Triage new detections', sub: `${d.events.filter((e) => e.status === 'new').length} waiting`, href: L(`${BASE}/events`, { status: 'new' }) },
        { ic: 'user', label: 'Review users and MFA', sub: 'Who has admin rights', href: ctx.can('users.manage') ? ctx.link('/settings', { tab: 'users' }) : ctx.link('/settings', { tab: 'profile' }) },
        ...(ctx.can('audit.read') ? [{ ic: 'shield', label: 'Audit log', sub: 'Every change, who and when', href: ctx.link('/settings', { tab: 'audit' }) }] : []),
        ...(ctx.can('incidents.manage') ? [{ ic: 'incident', label: 'Declare security incident', sub: 'Starts the incident workflow', onclick: () => declareModal(ctx, { title: 'Security: ', severity: 'critical' }) }] : []),
      ]))));
  }

  refresh();
  return { refresh: () => refresh(true) };
}

// ======================= detections list =======================
export function securityEvents(main, ctx) {
  const f = { ...readF(ctx), status: ctx.params.get('status') || '', from: ctx.params.get('from') || '', to: ctx.params.get('to') || '' };
  const filters = h('div');
  const body = h('div', {}, loadingSkeleton(0));
  main.append(detailHead('shield', 'Security', 'Detections', 'Everything the detection rules flagged, newest first.', [back(ctx, readF(ctx))]), filters, body);
  async function refresh() {
    clear(filters).append(filterBar(ctx, [
      { key: 'severity', label: 'Any severity', options: [['critical', 'Critical'], ['high', 'High'], ['medium', 'Medium']] },
      { key: 'category', label: 'All categories', options: CATEGORIES },
      { key: 'status', label: 'Any status', options: [['open', 'Not closed'], ['new', 'New'], ['investigating', 'Investigating'], ['closed', 'Closed'], ['false_positive', 'False positive']] },
    ], f, refresh));
    if (f.from) filters.firstChild.append(h('span', { class: 'chip-filter' }, `${dateTime(Number(f.from)).slice(5, 16)} – ${dateTime(Number(f.to)).slice(11, 16)}`, h('button', { 'aria-label': 'Remove time filter', onclick: () => { f.from = ''; f.to = ''; history.replaceState({}, '', ctx.link(location.pathname, f)); refresh(); } }, icon('x', 11))));
    let d;
    try { d = await mockFetch(() => securityData(args(ctx, { severity: f.severity, category: f.category }))); } catch (e) { clear(body).append(errorState(e.message, refresh)); return; }
    let rows = d.events;
    if (f.status === 'open') rows = rows.filter((e) => e.status !== 'closed' && e.status !== 'false_positive'); else if (f.status) rows = rows.filter((e) => e.status === f.status);
    if (f.from) rows = rows.filter((e) => e.at >= Number(f.from) && e.at < Number(f.to));
    clear(body).append(h('div', { class: 'muted', style: { marginBottom: '8px' } }, `${rows.length} detection(s)`), table([
      { label: 'Severity', value: (e) => sevPill(e.sev) },
      { label: 'Detection', value: (e) => h('div', {}, h('b', {}, e.rule), h('div', { class: 'dim', style: { fontSize: '11px' } }, e.technique)) },
      { label: 'Category', value: (e) => catLabel(e.cat) },
      { label: 'Host / user', value: (e) => h('span', { class: 'dim' }, `${e.host} · ${e.user}`) },
      { label: 'Source', value: (e) => h('span', { class: 'mono' }, e.ip) },
      { label: 'Events', value: (e) => String(e.count), num: true },
      { label: 'Status', value: (e) => stPill(e.status) },
      { label: 'When', value: (e) => h('span', { class: 'dim', title: dateTime(e.at) }, since(e.at)) },
    ], rows, { onRow: (e) => ctx.navigate(ctx.link(`${BASE}/events/${e.id}`, readF(ctx))), empty: ['No detections match', 'Change the filters or the time range.'] }));
  }
  refresh();
  return { refresh };
}

// ======================= one detection =======================
export function securityEvent(main, ctx) {
  const id = location.pathname.split('/').pop();
  const f = readF(ctx);
  const page = detailPage(main, {
    load: () => mockFetch(() => eventDetail(args(ctx), id), { delay: 200 }),
    notFound: ['Detection not found', 'It may be outside the selected time range.', back(ctx, f)],
    render(body, d) { draw(body, d); },
  });
  function draw(body, d) {
    clear(body);
    const { e, ip } = d;
    const set = (status, msg) => { setEventStatus(e.id, status, userName(ctx)); toast(msg); draw(body, eventDetail(args(ctx), id)); };
    const raw = { id: e.id, rule: e.rule, severity: e.sev, category: e.cat, technique: e.technique, time: new Date(e.at).toISOString(), source_ip: e.ip, host: e.host, user: e.user, event_count: e.count, environment: e.env };
    body.append(
      detailHead('shield', `Detection · ${catLabel(e.cat)}`, [e.rule, ' ', sevPill(e.sev)], `${dateTime(e.at)} · ${e.technique}`, [
        linkBtn(ctx.link(`${BASE}/events`, f), 'arrowLeft', 'All detections'),
        e.status !== 'investigating' && e.status !== 'closed' ? h('button', { class: 'btn btn-sm', onclick: () => set('investigating', 'Marked as investigating') }, icon('search', 13), 'Investigate') : null,
        e.status !== 'closed' && e.status !== 'false_positive' ? h('button', { class: 'btn btn-sm', onclick: () => set('false_positive', 'Closed as false positive') }, icon('x', 13), 'False positive') : null,
        e.status !== 'closed' && e.status !== 'false_positive' ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => set('closed', 'Detection closed') }, icon('check', 13), 'Close') : null,
      ]),
      h('div', { class: 'grid cards-4', style: { marginBottom: '14px' } },
        miniStat('Status', ST[e.status][0], d.e.handledBy ? `by ${d.e.handledBy}` : null),
        miniStat('Source address', h('span', { class: 'mono' }, e.ip), `${ip.country} · ${ip.owner}`),
        miniStat('Target', e.host, `user ${e.user}`),
        miniStat('Events', String(e.count), 'grouped into this detection')),
      h('div', { class: 'ov-row persona-row-2b', style: { marginTop: 0 } },
        panel('Raw event', 'list', h('pre', { class: 'stack' }, JSON.stringify(raw, null, 2))),
        h('div', { class: 'stack-col' },
          panel('Source address', 'globe', h('div', {},
            h('div', { class: 'kv-row' }, h('span', { class: 'dim' }, 'Reputation'), h('b', { class: ip.reputation === 'known bad' ? 'c-red' : ip.reputation === 'suspicious' ? 'c-orange' : '' }, ip.reputation)),
            h('div', { class: 'kv-row' }, h('span', { class: 'dim' }, 'Country'), h('span', {}, ip.country)),
            h('div', { class: 'kv-row' }, h('span', { class: 'dim' }, 'Network'), h('span', {}, ip.owner)),
            h('div', { class: 'qa-row', style: { justifyContent: 'flex-start' } },
              notConnected('x', 'Block address', NEEDS.firewall),
              linkBtn(ctx.link(`${BASE}/ips/${ip.ip}`, f), 'search', 'All activity')))),
          panel('Next steps', 'activity', quickActions([
            d.host ? { ic: 'server', label: 'Host security', sub: `${d.host.name}: ${d.host.vulns.length} vulnerabilities`, href: ctx.link(`${BASE}/hosts/${d.host.name}`, f) } : null,
            { ic: 'logs', label: 'Logs around this time', sub: `${e.host}, 15 min`, href: ctx.link('/logs', { q: `{host="${e.host}"} |= "${e.ip}"` }) },
            ...(ctx.can('incidents.manage') ? [{ ic: 'incident', label: 'Declare security incident', sub: 'If this is real', onclick: () => declareModal(ctx, { title: `Security: ${e.rule}`, severity: e.sev === 'critical' ? 'critical' : 'warning' }) }] : []),
          ].filter(Boolean))))),
      h('div', { class: 'ov-row' }, panel('Other detections from this address', 'shield', table([
        { label: 'Severity', value: (x) => sevPill(x.sev) },
        { label: 'Detection', value: (x) => h('b', {}, x.rule) },
        { label: 'Target', value: (x) => h('span', { class: 'dim' }, `${x.host} · ${x.user}`) },
        { label: 'When', value: (x) => h('span', { class: 'dim' }, since(x.at)) },
      ], d.related, { onRow: (x) => ctx.navigate(ctx.link(`${BASE}/events/${x.id}`, f)), empty: ['None', 'This is the only detection from this address.'] }))));
  }
  return page;
}

// ======================= host =======================
export function securityHost(main, ctx) {
  const name = decodeURIComponent(location.pathname.split('/').pop());
  const f = readF(ctx);
  return detailPage(main, {
    load: () => mockFetch(() => hostDetail(args(ctx), name)),
    notFound: ['Host not found', '', back(ctx, f)],
    render(body, { host, events }) {
      const odd = host.ports.filter((p) => p !== 443);
      body.append(
        detailHead('server', `Host · ${host.os}`, [host.name, ' ', h('span', { class: 'pill', style: { background: riskTone(host.risk), color: '#fff' } }, `Risk ${host.risk}`)], `Last scanned ${since(host.lastScan)}`, [
          back(ctx, f),
          notConnected('refresh', 'Scan now', NEEDS.scanner),
        ]),
        h('div', { class: 'grid cards-4', style: { marginBottom: '14px' } },
          miniStat('Risk score', String(host.risk), 'out of 100', host.risk >= 60 ? 'c-red' : host.risk >= 30 ? 'c-orange' : 'c-green'),
          miniStat('Vulnerabilities', String(host.vulns.length), `${host.vulns.filter((v) => v.severity === 'critical').length} critical`),
          miniStat('Open to the internet', host.ports.length ? host.ports.join(', ') : 'nothing', odd.length ? `port ${odd.join(', ')} should not be open` : 'as expected', odd.length ? 'c-red' : ''),
          miniStat('Detections', String(events.length), 'last 7 days')),
        h('div', { class: 'ov-row persona-row-2b', style: { marginTop: 0 } },
          panel('Vulnerabilities to patch', 'alert', table([
            { label: 'Package', value: (v) => h('div', {}, h('b', {}, v.pkg), h('div', { class: 'dim', style: { fontSize: '11px' } }, v.id)) },
            { label: 'Severity', value: (v) => sevPill(v.severity) },
            { label: 'Installed', value: (v) => h('span', { class: 'mono dim' }, v.have) },
            { label: 'Fixed in', value: (v) => h('span', { class: 'mono' }, v.fixed) },
            { label: 'Open for', value: (v) => h('span', { class: v.ageDays > 30 ? 'c-orange' : 'dim' }, `${v.ageDays} d`), num: true },
            { label: '', value: (v) => (v.exploitable ? h('span', { class: 'pill st-err', title: 'Public exploit code exists' }, 'Exploit known') : '') },
          ], host.vulns, { empty: ['Nothing to patch', 'This host is up to date.'] })),
          panel('Recent detections', 'shield', table([
            { label: 'Severity', value: (x) => sevPill(x.sev) },
            { label: 'Detection', value: (x) => h('b', {}, x.rule) },
            { label: 'When', value: (x) => h('span', { class: 'dim' }, since(x.at)) },
          ], events, { onRow: (x) => ctx.navigate(ctx.link(`${BASE}/events/${x.id}`, f)), empty: ['No detections', ''] }))));
    },
  });
}

// ======================= source address =======================
export function securityIp(main, ctx) {
  const ipAddr = decodeURIComponent(location.pathname.split('/').pop());
  const f = readF(ctx);
  const page = detailPage(main, {
    load: () => mockFetch(() => ipDetail(args(ctx), ipAddr)),
    notFound: ['No activity from this address', '', back(ctx, f)],
    render(body, d) { draw(body, d); },
  });
  function draw(body, d) {
    clear(body);
    const { info, events } = d;
    body.append(
      detailHead('globe', `Source address · ${info.country}`, [h('span', { class: 'mono' }, info.ip), ' ', info.blocked ? h('span', { class: 'pill st-res' }, 'Blocked') : h('span', { class: `pill ${info.reputation === 'known bad' ? 'st-err' : 'st-slow'}` }, info.reputation)],
        `${info.owner} · first seen ${events.length ? since(events[events.length - 1].at) : '-'}`, [
          back(ctx, f),
          notConnected('x', 'Block address', NEEDS.firewall),
        ]),
      h('div', { class: 'grid cards-4', style: { marginBottom: '14px' } },
        miniStat('Detections', String(events.length), 'last 7 days'),
        miniStat('Events', String(events.reduce((s, e) => s + e.count, 0))),
        miniStat('Accounts targeted', String(d.users.length), d.users.slice(0, 3).join(', ')),
        miniStat('Hosts targeted', String(new Set(events.map((e) => e.host)).size))),
      panel('Activity', 'shield', table([
        { label: 'Severity', value: (x) => sevPill(x.sev) },
        { label: 'Detection', value: (x) => h('b', {}, x.rule) },
        { label: 'Target', value: (x) => h('span', { class: 'dim' }, `${x.host} · ${x.user}`) },
        { label: 'Events', value: (x) => String(x.count), num: true },
        { label: 'When', value: (x) => h('span', { class: 'dim' }, since(x.at)) },
      ], events, { onRow: (x) => ctx.navigate(ctx.link(`${BASE}/events/${x.id}`, f)) })));
  }
  return page;
}

export { meter };
