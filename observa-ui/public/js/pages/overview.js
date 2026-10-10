// Overview: health of everything at a glance. Every number and row opens the page behind it.
import { h, api, clear, icon, fmt, short, ago, sparkline, doughnut, timeChart, emptyState, errorBox, demoBadge } from '../ui.js';
import { chartSlots } from './common.js';
import { openLog } from './logs.js';
import { attentionStrip, errorState, staleNotice } from '../personas/widgets.js';

const SEV = { critical: ['Critical', 'sev-critical'], warning: ['Warning', 'sev-warning'], info: ['Info', 'sev-info'] };
export const STATUS_PILL = { open: ['Open', 'st-open'], acknowledged: ['Acknowledged', 'st-ack'], investigating: ['Investigating', 'st-inv'], resolved: ['Resolved', 'st-res'] };
const LEVEL_PILL = { ERROR: 'lv-error', WARN: 'lv-warn', INFO: 'lv-info', DEBUG: 'lv-debug' };

export const sevPill = (s) => { const [l, c] = SEV[s] || [s, 'sev-info']; return h('span', { class: `pill ${c}` }, l); };
export const statusPill = (s) => { const [l, c] = STATUS_PILL[s] || [s, 'st-open']; return h('span', { class: `pill ${c}` }, l); };
export const levelPill = (lv) => h('span', { class: `pill ${LEVEL_PILL[lv] || 'lv-debug'}` }, lv);

export function overviewPage(main, ctx) {
  const setChart = chartSlots(ctx);
  // environment comes from the global filter in the top bar
  const env = ctx.env;
  const kpis = h('div', { class: 'ov-kpis ov-kpis-5' });
  const rowA = h('div', { class: 'ov-row ov-row-a' });
  const rowB = h('div', { class: 'ov-row ov-row-b' });
  const rowC = h('div', { class: 'ov-row ov-row-c' });
  const right = h('div', { class: 'actions' });
  const context = h('p', { class: 'ov-context' }, 'Real-time view of your infrastructure, applications, and services.');
  const attn = h('div', { class: 'ov-attn' });
  const stale = h('div', { class: 'ov-stale' });
  const failBox = h('div');
  main.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Overview'), context), right),
    stale, failBox, attn, kpis, rowA, rowB, rowC);
  // loading: blocks in the shape of each row until the first data arrives
  const block = (cls, height) => h('div', { class: `${cls} skeleton`, style: { height } });
  kpis.append(...Array.from({ length: 5 }, () => block('kpi', '118px')));
  rowA.append(block('panel', '250px'), block('panel', '250px'));
  rowB.append(...Array.from({ length: 4 }, () => block('panel', '170px')));
  rowC.append(...Array.from({ length: 3 }, () => block('panel', '240px')));
  main.setAttribute('aria-busy', 'true');
  let okAt = 0; // when the page last drew good data

  const panel = (title, ic, body, link) => h('section', { class: 'panel ov-panel' },
    h('div', { class: 'panel-head' }, icon(ic, 16, 'ov-ic'), h('h3', {}, title), link ? h('div', { class: 'right' }, link) : null), body);
  const viewAll = (label, path) => h('a', { class: 'ov-link', href: ctx.link(path), 'data-link': true }, label, icon('arrowRight', 13));

  async function load() {
    const { start, end } = ctx.range;
    const [ov, inc, logs, traces] = await Promise.allSettled([
      api('/overview', { query: { start, end, env } }),
      api('/incidents', { query: { status: 'all', limit: 100 } }),
      api('/logs', { query: { query: '{service_name=~".+"}', start, end, limit: 6 } }),
      api('/traces', { query: { start, end, limit: 6 } }),
    ]);
    if (ov.status === 'rejected') {
      main.removeAttribute('aria-busy');
      if (okAt) {
        // keep what is on screen; say it is old and why
        clear(stale).append(staleNotice({ okAt, message: ov.reason.message, retry: () => retry() }));
      } else {
        [attn, kpis, rowA, rowB, rowC].forEach((x) => clear(x));
        clear(failBox).append(errorState(ov.reason.message, () => retry(), 'The Overview could not load'));
      }
      throw ov.reason; // tells the shell this refresh failed, so "Updated … ago" is not reset
    }
    clear(stale); clear(failBox);
    main.removeAttribute('aria-busy');
    okAt = Date.now();
    const d = ov.value;
    const incidents = inc.status === 'fulfilled' ? inc.value : null;
    drawHeader(d, incidents);
    drawAttention(d, incidents, inc.status === 'rejected');
    drawKpis(d, incidents);
    drawRowA(d, incidents, inc.status === 'rejected' ? inc.reason.message : null);
    drawRowB(d);
    drawRowC(d, logs, traces);
  }

  function drawHeader(d, incidents) {
    clear(right).append(...[
      env ? h('span', { class: 'pill pill-blue', title: 'Change it in the top bar' }, `Environment: ${env}`) : null].filter(Boolean));
    const secs = ctx.rangeSeconds;
    const rangeTxt = secs < 3600 ? `last ${secs / 60} minutes` : secs < 86400 ? `last ${secs / 3600} hour${secs > 3600 ? 's' : ''}` : `last ${secs / 86400} day${secs > 86400 ? 's' : ''}`;
    clear(context).append(`Environment: ${env || 'all'} · Time range: ${rangeTxt} · Data as of ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
  }

  // ---------------- what needs attention now (live data only) ----------------
  function drawAttention(d, incidents, incFailed) {
    const items = [];
    const open = (incidents?.incidents || []).filter((x) => x.status === 'open');
    const openCrit = open.filter((x) => x.severity === 'critical');
    const one = (list, word) => (list.length === 1 ? { label: 'Open incident', href: `/incidents/${list[0].id}` } : { label: `View ${word}`, href: '/incidents' });
    if (openCrit.length) items.push({ level: 'critical', text: `${openCrit.length} critical incident${openCrit.length > 1 ? 's' : ''} not acknowledged`, detail: openCrit.slice(0, 2).map((x) => x.title).join(' · '), action: one(openCrit, 'incidents') });
    const openOther = open.filter((x) => x.severity !== 'critical');
    if (openOther.length) items.push({ level: 'warning', text: `${openOther.length} incident${openOther.length > 1 ? 's' : ''} waiting for someone to acknowledge`, detail: openOther.slice(0, 2).map((x) => x.title).join(' · '), action: one(openOther, 'incidents') });
    const s = d.services?.summary;
    if (s?.down) items.push({ level: 'critical', text: `${s.down} service${s.down > 1 ? 's' : ''} unhealthy`, detail: d.services.demo ? 'from sample service data' : null, action: { label: 'View services', href: '/services?status=down' } });
    if (s?.degraded) items.push({ level: 'warning', text: `${s.degraded} service${s.degraded > 1 ? 's' : ''} degraded`, detail: d.services.demo ? 'from sample service data' : null, action: { label: 'View services', href: '/services?status=degraded' } });
    if (d.hostsDown?.length) items.push({ level: 'critical', text: `${d.hostsDown.length} host${d.hostsDown.length > 1 ? 's' : ''} not responding`, detail: d.hostsDown.slice(0, 4).join(', '), action: { label: 'View hosts', href: '/infrastructure' } });
    if (d.diskHot?.length) items.push({ level: d.diskHot[0].usedPct >= 95 ? 'critical' : 'warning', text: `${d.diskHot.length} host${d.diskHot.length > 1 ? 's' : ''} with a disk over 90% full`, detail: d.diskHot.slice(0, 3).map((x) => `${x.host} ${Math.round(x.usedPct)}%`).join(', '), action: { label: 'View hosts', href: '/infrastructure' } });
    // checks that could not run are said out loud, never shown as "all clear"
    const failed = [incFailed && 'incidents', d.servicesError && 'services', (d.hostsDown === null || d.diskHot === null) && 'hosts and disks'].filter(Boolean);
    // links keep environment and time range
    for (const x of items) x.action.href = ctx.link(x.action.href);
    // a check that could not run is always visible (never behind "Show more") and stops the strip from saying "All clear"
    const notice = failed.length ? h('div', { class: 'attn-notice', role: 'status' }, icon('alert', 14),
      h('span', {}, h('b', {}, `Could not check ${failed.join(', ')}.`), ' A data source did not answer, so this list may be incomplete. '),
      h('a', { href: '/datasources', 'data-link': true }, 'Data sources')) : null;
    const strip = items.length || !notice ? attentionStrip(items) : h('section', { class: 'attn', 'aria-label': 'Needs your attention' }, h('div', { class: 'attn-title' }, icon('alert', 14), 'Needs your attention'));
    if (notice) strip.append(notice);
    clear(attn).append(strip);
  }

  // ---------------- KPI cards ----------------
  function kpi({ ic, tone, title, value, unit, delta, spark, sparkColor, bars, foot, href, demo }) {
    const c = h('canvas');
    const card = h('a', { class: `kpi kpi-${tone}`, href: ctx.link(href), 'data-link': true },
      h('div', { class: 'kpi-top' }, h('span', { class: 'kpi-ic' }, icon(ic, 18)), h('span', { class: 'kpi-title' }, title, demo ? demoBadge(true, true) : null)),
      h('div', { class: 'kpi-mid' },
        h('div', { class: 'kpi-val' }, delta ? h('span', { class: `kpi-delta ${delta.cls}` }, delta.text) : null, h('b', {}, value), unit ? h('small', {}, unit) : null),
        h('div', { class: 'kpi-spark' }, spark && spark.length > 1 ? c : null)),
      h('div', { class: 'kpi-foot' }, foot));
    if (spark && spark.length > 1) setChart(`spark-${title}`, sparkline(c, spark, sparkColor, bars));
    return card;
  }
  const deltaCount = (now, before, goodWhenUp) => {
    if (now === null || before === null || before === undefined) return null;
    const diff = Math.round(now - before);
    if (!diff) return null;
    return { text: `${diff > 0 ? '↑' : '↓'} ${Math.abs(diff)}`, cls: (diff > 0) === goodWhenUp ? 'good' : 'bad' };
  };
  const deltaPct = (now, before, { relative = false } = {}) => {
    if (now === null || before === null || !Number.isFinite(before) || (relative && !before)) return null;
    const v = relative ? ((now - before) / before) * 100 : now - before;
    if (Math.abs(v) < 0.05) return null;
    return { text: `${v > 0 ? '↑' : '↓'} ${Math.abs(v).toFixed(1)}%`, cls: v > 0 ? 'bad' : 'good' };
  };

  function drawKpis(d, incidents) {
    const s = d.services?.summary;
    const ic = incidents?.counts;
    // incidents opened per hour over the last 24 h, as small bars
    const buckets = Array.from({ length: 24 }, (_, i) => [i, 0]);
    for (const x of incidents?.incidents || []) {
      const hAgo = Math.floor((Date.now() - Date.parse(x.startedAt)) / 3600_000);
      if (hAgo >= 0 && hAgo < 24) buckets[23 - hAgo][1]++;
    }
    const k = d.kpi;
    clear(kpis).append(
      kpi({
        ic: 'server', tone: 'blue', title: 'Total Hosts', value: String(d.hosts.total), href: '/infrastructure',
        delta: deltaCount(d.hosts.healthy, d.hosts.before, true), spark: d.hosts.series, sparkColor: '#22c55e',
        foot: [h('span', { class: 'c-green' }, `${d.hosts.healthy} healthy`), h('span', { class: 'c-red' }, `${d.hosts.unhealthy} unhealthy`), h('span', { class: 'dim' }, `${d.hosts.unknown} unknown`)],
      }),
      kpi({
        ic: 'cube', tone: 'blue', title: 'Total Services', value: s ? String(s.total) : 'N/A', href: '/services', demo: d.services?.demo,
        delta: s && d.servicesBefore ? deltaCount(s.healthy, d.servicesBefore.healthy, true) : null, spark: k?.rps.series, sparkColor: '#22c55e',
        foot: s ? [h('span', { class: 'c-green' }, `${s.healthy} healthy`), h('span', { class: 'c-orange' }, `${s.degraded} degraded`), h('span', { class: 'c-red' }, `${s.down} down`)] : [h('span', { class: 'dim' }, d.servicesError || 'No service data')],
      }),
      kpi({
        ic: 'incident', tone: 'red', title: 'Active Incidents', value: ic ? String(ic.active) : 'N/A', href: '/incidents', spark: buckets, sparkColor: '#ef4444', bars: true,
        foot: ic ? [h('span', { class: 'c-red' }, `${ic.critical} critical`), h('span', { class: 'c-orange' }, `${ic.warning} warning`)] : [h('span', { class: 'dim' }, 'Incidents unavailable')],
      }),
      kpi({
        ic: 'pulse', tone: 'blue', title: 'Error Rate', value: k?.errorRate.now === null || !k ? 'N/A' : k.errorRate.now.toFixed(1), unit: k && k.errorRate.now !== null ? '%' : '', href: '/services', demo: k?.demo,
        delta: k ? deltaPct(k.errorRate.now, k.errorRate.before) : null, spark: k?.errorRate.series, sparkColor: '#06b6d4',
        foot: k && k.errorRate.before !== null ? [h('span', { class: 'dim' }, `from ${k.errorRate.before.toFixed(1)}% (start of range)`)] : [h('span', { class: 'dim' }, k ? 'No requests in this range' : 'Request metrics unavailable')],
      }),
      kpi({
        ic: 'timer', tone: 'purple', title: 'P95 Latency', value: k?.p95.now ? String(Math.round(k.p95.now)) : 'N/A', unit: k?.p95.now ? 'ms' : '', href: '/traces', demo: k?.demo,
        delta: k ? deltaPct(k.p95.now, k.p95.before, { relative: true }) : null, spark: k?.p95.series, sparkColor: '#a855f7',
        foot: k && k.p95.before ? [h('span', { class: 'dim' }, `from ${Math.round(k.p95.before)} ms (start of range)`)] : [h('span', { class: 'dim' }, k ? 'No traced requests in this range' : 'Latency metrics unavailable')],
      }));
  }

  // ---------------- service health + active incidents ----------------
  function drawRowA(d, incidents, incErr) {
    const s = d.services?.summary;
    const health = h('div');
    if (!s || !s.total) health.append(emptyState('No services yet', d.servicesError || 'Your applications do not report request metrics yet.'));
    else {
      const c = h('canvas');
      const pct = (n) => `${((n / s.total) * 100).toFixed(1)}%`;
      const rowOf = (dot, label, n, filter) => h('a', { class: 'ov-health-row', href: ctx.link('/services', { status: filter }), 'data-link': true },
        h('i', { class: `dot ${dot}` }), h('span', {}, label), h('b', {}, String(n)), h('span', { class: 'dim' }, pct(n)));
      health.append(h('div', { class: 'ov-health' },
        h('div', { class: 'donut' }, c, h('div', { class: 'center' }, h('b', {}, s.total), h('span', {}, 'Services'))),
        h('div', { class: 'ov-health-list' }, rowOf('dot-green', 'Healthy', s.healthy, 'healthy'), rowOf('dot-orange', 'Degraded', s.degraded, 'degraded'), rowOf('dot-red', 'Unhealthy', s.down, 'down'))));
      setChart('health', doughnut(c, ['Healthy', 'Degraded', 'Unhealthy'], [s.healthy, s.degraded, s.down], ['#22c55e', '#f59e0b', '#ef4444']));
    }
    const incBox = h('div');
    const active = (incidents?.incidents || []).filter((x) => x.status !== 'resolved').slice(0, 4);
    if (incErr) incBox.append(errorBox(incErr));
    else if (!active.length) incBox.append(emptyState('No active incidents', 'Everything is quiet right now.'));
    else {
      incBox.append(h('table', { class: 'tbl ov-tbl' },
        h('thead', {}, h('tr', {}, ['Severity', 'Title', 'Service', 'Started', 'Status'].map((x) => h('th', {}, x)))),
        h('tbody', {}, active.map((x) => h('tr', { class: 'clickable', onclick: () => ctx.navigate(ctx.link(`/incidents/${x.id}`)) },
          h('td', {}, h('span', { class: 'ov-sev' }, h('i', { class: `dot ${x.severity === 'critical' ? 'dot-red' : 'dot-orange'}` }), sevPill(x.severity))),
          h('td', { class: 'ov-title' }, x.title),
          h('td', {}, x.service ? h('a', { href: ctx.link(`/services/${encodeURIComponent(x.service)}`), 'data-link': true, onclick: (e) => e.stopPropagation() }, x.service) : h('span', { class: 'dim' }, x.host || '—')),
          h('td', { class: 'dim' }, ago(x.startedAt)),
          h('td', {}, statusPill(x.status)))))));
    }
    clear(rowA).append(
      panel('Service Health', 'heart', health, viewAll('View All Services', '/services')),
      panel('Active Incidents', 'incident', incBox, viewAll('View All', '/incidents')));
  }

  // ---------------- CPU / memory / disk / network ----------------
  function drawRowB(d) {
    const mini = (title, ic, color, m, unit, href, max) => {
      const box = h('div', { class: 'ov-mini-chart' });
      const valueText = m.now === null || m.now === undefined ? (m.error ? 'Unavailable' : 'No data') : unit === 'bps' ? fmt(m.now, 'bps') : `${Math.round(m.now)}%`;
      const p = h('section', { class: 'panel ov-panel ov-mini' },
        h('div', { class: 'panel-head' }, h('span', { class: 'ov-mini-ic', style: { color } }, icon(ic, 16)),
          h('div', {}, h('h3', {}, title), h('div', { class: 'ov-mini-val' }, valueText)),
          h('div', { class: 'right' }, viewAll('View', href))),
        box);
      if (m.error) box.append(h('div', { class: 'dim', style: { fontSize: '12px' } }, 'No data'));
      else if (m.series?.length > 1) {
        const c = h('canvas');
        box.append(c);
        setChart(`mini-${title}`, timeChart(c, [{ label: title, points: m.series, color }], { unit: unit === 'bps' ? 'bps' : 'percent', area: true, max }));
      } else box.append(h('div', { class: 'dim', style: { fontSize: '12px', padding: '20px 0' } }, 'Waiting for data'));
      return p;
    };
    clear(rowB).append(
      mini('CPU Usage', 'cpu', '#3b82f6', d.cpu, 'percent', '/infrastructure', 100),
      mini('Memory Usage', 'memory', '#a855f7', d.mem, 'percent', '/infrastructure', 100),
      mini('Disk Usage', 'disk', '#22c55e', d.disk, 'percent', '/insights', 100),
      mini('Network I/O', 'network', '#06b6d4', d.net, 'bps', `/metrics?q=${encodeURIComponent('sum by (host) (rate(node_network_receive_bytes_total[5m]))')}`));
  }

  // ---------------- top services, recent logs, recent traces ----------------
  function drawRowC(d, logs, traces) {
    const top = h('div');
    if (!d.topErrors?.length) top.append(emptyState('No service data'));
    else {
      const maxErr = Math.max(1, ...d.topErrors.map((x) => x.errorRate));
      top.append(h('table', { class: 'tbl ov-tbl' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Service'), h('th', {}, 'Error rate'), h('th', { class: 'num' }, 'Requests'), h('th', {}))),
        h('tbody', {}, d.topErrors.map((x) => {
          const tone = x.errorRate >= 5 ? '#ef4444' : x.errorRate >= 1 ? '#f59e0b' : '#22c55e';
          return h('tr', { class: 'clickable', onclick: () => ctx.navigate(ctx.link(`/services/${encodeURIComponent(x.name)}`)) },
            h('td', {}, h('span', { class: 'ov-svc' }, h('i', { class: 'ov-svc-ic', style: { color: tone } }, icon(x.status === 'healthy' ? 'check' : 'alert', 12)), x.name)),
            h('td', {}, h('div', { class: 'ov-errbar' }, h('span', { style: { color: tone } }, `${x.errorRate.toFixed(1)}%`), h('div', { class: 'bar' }, h('i', { style: { width: `${(x.errorRate / maxErr) * 100}%`, background: tone } })))),
            h('td', { class: 'num' }, `${short(x.rps * 60)}/min`),
            h('td', { class: 'num dim' }, icon('chevron', 12, 'rot-90')));
        }))));
    }
    const logBox = h('div');
    if (logs.status === 'rejected') logBox.append(errorBox(logs.reason.message));
    else if (!logs.value.entries.length) logBox.append(emptyState('No logs in this time range'));
    else logBox.append(h('table', { class: 'tbl ov-tbl' },
      h('thead', {}, h('tr', {}, ['Time', 'Level', 'Service', 'Message'].map((x) => h('th', {}, x)))),
      h('tbody', {}, logs.value.entries.slice(0, 5).map((e) => h('tr', { class: 'clickable', onclick: () => openLog(ctx, e) },
        h('td', { class: 'mono dim' }, new Date(e.ts).toTimeString().slice(0, 8)),
        h('td', {}, levelPill(e.level)),
        h('td', { class: e.service ? 'c-link' : 'dim' }, e.service || '—'),
        h('td', { class: 'ov-msg', title: e.message }, e.message))))));
    const trBox = h('div');
    if (traces.status === 'rejected') trBox.append(errorBox(traces.reason.message));
    else if (!traces.value.traces.length) trBox.append(emptyState('No traces in this time range'));
    else trBox.append(h('table', { class: 'tbl ov-tbl' },
      h('thead', {}, h('tr', {}, ['Time', 'Service', 'Duration', 'Status'].map((x, i) => h('th', { class: i === 2 ? 'num' : '' }, x)))),
      h('tbody', {}, traces.value.traces.slice(0, 5).map((t) => {
        const st = t.error ? ['Error', 'st-err'] : t.durationMs > 1000 ? ['Slow', 'st-slow'] : t.error === null ? ['—', 'st-res'] : ['OK', 'st-ok'];
        return h('tr', { class: 'clickable', onclick: () => ctx.navigate(ctx.link(`/traces/${t.traceId}`)) },
          h('td', { class: 'mono dim' }, new Date(t.startMs).toTimeString().slice(0, 8)),
          h('td', { class: 'c-link' }, t.rootService),
          h('td', { class: 'num' }, fmt(t.durationMs, 'ms')),
          h('td', {}, h('span', { class: `pill ${st[1]}` }, st[0])));
      }))));
    clear(rowC).append(
      panel('Top Services by Error Rate', 'pulse', top, viewAll('View All', '/services?sort=errorRate')),
      panel(h('span', {}, 'Recent Logs ', demoBadge(logs.value?.demo, true)), 'logs', logBox, viewAll('View All', '/logs')),
      panel(h('span', {}, 'Recent Traces ', demoBadge(traces.value?.demo, true)), 'traces', trBox, viewAll('View All', '/traces')));
  }

  load();
  // Retry from a stale notice or error: runs the same load and updates the top-bar freshness through the shell
  const retry = () => ctx.refreshNow ? ctx.refreshNow() : load().catch(() => {});
  const ready = load();
  ready.catch(() => {});
  return { refresh: load, ready };
}
