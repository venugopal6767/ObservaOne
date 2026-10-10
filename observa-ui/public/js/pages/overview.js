import { h, api, clear, short, timeChart, barChart, doughnut, legendRow, legendName, stateView, stateFromError, ApiError, skeleton, statusColor, thresholdColor } from '../ui.js';
import { chartSlots, statCard, pctChange } from './common.js';

// Every value here is real or shown as unavailable with its reason. Nothing is filled in.
export function overviewPage(main, ctx) {
  const setChart = chartSlots(ctx);
  const cards = h('div', { class: 'grid cards-6' });
  const rowA = h('div', { class: 'grid cols-2', style: { marginTop: '14px' } });
  const rowB = h('div', { class: 'grid cols-3', style: { marginTop: '14px' } });
  main.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Overview'), h('p', {}, 'Monitor your entire infrastructure and applications'))),
    cards, rowA, rowB);
  cards.append(skeleton('cards', 6));
  rowB.append(skeleton('chart'));

  // Panels follow the global time range in the top bar, so they carry no range label of their own.
  // A panel that shows something else (e.g. the current value only) says so with a chip.
  const panel = (title, body, { right } = {}) =>
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, title), right ? h('div', { class: 'right' }, right) : null), body);
  const nowChip = () => h('span', { class: 'pill pill-muted', title: 'Current value, not the selected time range' }, 'Now');
  // small grey line under a tile that explains a missing value
  const reason = (text) => h('div', { class: 'stat-reason', title: text }, text.length > 60 ? `${text.slice(0, 57)}...` : text);
  const agentsLink = () => (ctx.canOpen('/agents') ? h('a', { href: '/agents', 'data-link': true, class: 'btn btn-sm' }, 'Install an agent') : null);
  // a failed piece of the overview, as the right state (unavailable vs error)
  const failed = (msg, what) => stateFromError(new ApiError(msg, { status: /Cannot reach|timeout|HTTP 5\d\d/i.test(msg) ? 502 : 400 }), what);

  async function load() {
    let d;
    try {
      d = await api('/overview', { query: ctx.range });
    } catch (e) {
      clear(cards).append(stateFromError(e, 'Overview'));
      clear(rowA); clear(rowB);
      return;
    }
    // Only the parts whose module is on (server decides; it does not even query the others)
    const M = d.modules || {};
    if (!M.infrastructure && !M.alerting && !M.services) {
      cards.className = ''; // full width, not squeezed into one tile column
      clear(cards).append(stateView('empty', {
        title: 'No monitoring modules are enabled',
        text: ctx.can('settings.manage') ? 'Turn on the modules this deployment uses in Settings > Modules.' : 'Nothing is enabled for your account yet. Contact your administrator.',
        action: ctx.can('settings.manage') ? h('a', { href: '/settings?tab=modules', 'data-link': true, class: 'btn btn-sm' }, 'Open Modules') : null,
      }));
      clear(rowA); clear(rowB);
      return;
    }
    const svc = d.services;
    const s = svc?.summary;
    // a function: each tile needs its own element (one DOM node can't sit in three tiles)
    const svcReason = () => (d.servicesError ? reason(`Service metrics unavailable: ${d.servicesError}`) : null);
    const noTraffic = s && !s.totalRps;

    // ---- stat cards ----
    const tiles = [];
    if (M.services) tiles.push(
      statCard('Total Services', s ? String(s.total) : '-', {
        // the server count is Infrastructure data: only shown when that module is on
        extra: svcReason() || (!M.infrastructure ? null : d.servers.total === null
          ? reason(`Servers: ${d.servers.error || 'unknown'}`)
          : h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '4px' } }, `${d.servers.total} servers monitored`)),
      }));
    if (M.infrastructure) tiles.push(
      statCard('CPU Usage', d.cpu.now === null ? '-' : d.cpu.now.toFixed(1), {
        unit: d.cpu.now === null ? '' : '%', trend: pctChange(d.cpu.now, d.cpu.before), tone: d.cpu.now >= 90 ? 'red' : '',
        extra: d.cpu.now === null ? reason(d.cpu.error ? `Unavailable: ${d.cpu.error}` : 'No CPU data from any server') : null,
      }),
      statCard('Memory Usage', d.mem.now === null ? '-' : d.mem.now.toFixed(1), {
        unit: d.mem.now === null ? '' : '%', trend: pctChange(d.mem.now, d.mem.before), tone: d.mem.now >= 90 ? 'red' : '',
        extra: d.mem.now === null ? reason(d.mem.error ? `Unavailable: ${d.mem.error}` : 'No memory data from any server') : null,
      }));
    if (M.services) tiles.push(
      statCard('Request Rate', s ? short(s.totalRps) : '-', { unit: s ? '/s' : '', extra: svcReason() || (noTraffic ? reason('No traffic in this period') : null) }),
      statCard('Error Rate', s && s.errorRate !== null ? s.errorRate.toFixed(1) : '-', {
        unit: s && s.errorRate !== null ? '%' : '',
        tone: s && s.errorRate >= 5 ? 'red' : s && s.errorRate >= 1 ? 'orange' : '',
        extra: svcReason() || (noTraffic ? reason('No requests, so no error rate') : null),
      }));
    let alertCard = null;
    if (M.alerting) tiles.push(alertCard =
      statCard('Active Alerts', d.alerts.active === null ? '-' : String(d.alerts.active), {
        // grey when unknown: an unreachable Alertmanager must not look like "no alerts"
        tone: d.alerts.active === null ? '' : d.alerts.active ? 'red' : 'green', iconName: 'alerting',
        extra: d.alerts.error ? reason(`Alertmanager unavailable: ${d.alerts.error}`)
          : h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '4px' } }, `${d.alerts.critical} critical`),
      }));
    cards.className = `grid cards-${tiles.length}`;
    clear(cards).append(...tiles);
    if (alertCard && ctx.canOpen('/alerting')) {
      alertCard.style.cursor = 'pointer';
      alertCard.onclick = () => ctx.navigate('/alerting');
    }

    // ---- request rate + latency ----
    clear(rowA);
    if (M.services) rowA.append(
      seriesPanel('Request Rate', d.rpsSeries, d.rpsError || d.servicesError, 'reqps', 'rps'),
      seriesPanel('Latency (P95)', d.latSeries, d.latError || d.servicesError, 'ms', 'lat'),
    );
    rowA.style.display = M.services ? '' : 'none';

    // ---- cpu by node, memory by server, services health ----
    const cpuBox = h('div');
    if (d.cpuByHostError) cpuBox.append(failed(d.cpuByHostError, 'CPU'));
    else if (!d.cpuByHost.length) cpuBox.append(stateView('empty', { title: 'No monitored hosts available', text: 'Install the ObservaOne Agent on a server, or add it to prometheus/targets.', action: agentsLink() }));
    else {
      const c = h('canvas');
      cpuBox.append(h('div', { class: 'chart-box' }, c));
      const colors = d.cpuByHost.map((x) => thresholdColor(x.value, { warn: 80, crit: 90 }));
      setChart('cpu', barChart(c, d.cpuByHost.map((x) => x.host || '(no host label)'), d.cpuByHost.map((x) => x.value), { unit: 'percent', colors, max: 100 }));
    }
    const memBox = h('div');
    if (d.memError) memBox.append(failed(d.memError, 'Memory'));
    else if (!d.memSeries.length) memBox.append(stateView('empty', { title: 'No memory data for the selected time range' }));
    else {
      const c = h('canvas');
      const series = d.memSeries.slice(0, 8).map((r) => ({ label: r.metric.host, points: r.values }));
      memBox.append(h('div', { class: 'chart-box', style: { height: '180px' } }, c), legendRow(series.map((x) => x.label)));
      setChart('mem', timeChart(c, series, { unit: 'percent', area: true, max: 100 }));
    }
    const healthBox = h('div');
    if (!s) healthBox.append(failed(d.servicesError || 'No answer', 'Services'));
    else if (!s.total) healthBox.append(stateView('empty', { title: 'No services discovered', text: 'No application request metrics match config/services.json yet.' }));
    else {
      const c = h('canvas');
      healthBox.append(h('div', { class: 'health' },
        h('div', { class: 'donut' }, c, h('div', { class: 'center' }, h('b', {}, s.total), h('span', {}, 'Services'))),
        h('div', { class: 'health-list' },
          h('div', {}, h('i', { class: 'dot dot-green' }), 'Healthy', h('b', {}, s.healthy)),
          h('div', {}, h('i', { class: 'dot dot-orange' }), 'Degraded', h('b', {}, s.degraded)),
          h('div', {}, h('i', { class: 'dot dot-red' }), 'Down', h('b', {}, s.down)),
          h('div', { title: 'No requests in this period' }, h('i', { class: 'dot', style: { background: 'var(--unknown)' } }), 'No traffic', h('b', {}, s.noTraffic)))));
      setChart('health', doughnut(c, ['Healthy', 'Degraded', 'Down', 'No traffic'], [s.healthy, s.degraded, s.down, s.noTraffic], ['ok', 'warn', 'crit', 'unknown'].map(statusColor)));
    }
    const bottom = [];
    if (M.infrastructure) bottom.push(panel('CPU Usage by Node', cpuBox, { right: nowChip() }), panel('Memory Usage by Server', memBox));
    if (M.services) bottom.push(panel('Services Health', healthBox, { right: [nowChip(), ctx.canOpen('/services') ? h('a', { href: '/services', 'data-link': true, style: { marginLeft: '10px' } }, 'View all') : null] }));
    rowB.className = `grid cols-${Math.max(1, bottom.length)}`;
    rowB.style.marginTop = '14px';
    clear(rowB).append(...bottom);

    function seriesPanel(title, s2, errMsg, unit, key) {
      const box = h('div');
      if (!s2) box.append(failed(errMsg || 'No answer', title));
      else if (!s2.result.length) box.append(stateView('empty', { title: 'No request metrics for the selected time range', text: 'Your applications do not expose request metrics yet, or config/services.json does not match them.' }));
      else {
        const c = h('canvas');
        const series = s2.result.map((r) => ({ label: r.metric.service || legendName(r.metric), points: r.values }));
        box.append(h('div', { class: 'chart-box' }, c), legendRow(series.map((x) => x.label)));
        setChart(key, timeChart(c, series, { unit }));
      }
      return panel(title, box);
    }
  }

  load();
  return { refresh: load };
}
