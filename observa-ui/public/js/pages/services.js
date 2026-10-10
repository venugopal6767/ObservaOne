import { h, api, clear, icon, fmt, short, stateView, stateFromError, healthPill, paginate } from '../ui.js';


export function servicesPage(main, ctx) {
  const summary = h('div', { class: 'grid cards-4' });
  const out = h('div', { style: { marginTop: '14px' } }, h('div', { class: 'table-wrap' }, stateView('loading', { skeleton: 'table' })));
  const searchInput = h('input', { class: 'input', placeholder: 'Filter services...', 'aria-label': 'Filter services', style: { width: '240px' }, oninput: (e) => { search = e.target.value.toLowerCase(); page = 0; draw(); } });
  let data = null, sortKey = 'status', sortDir = 1, search = '', statusFilter = '', page = 0;

  main.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Services'), h('p', {}, 'Monitor your application services')),
      h('div', { class: 'actions' }, searchInput)),
    summary, out);

  async function load() {
    try {
      data = await api('/services');
      draw();
    } catch (e) {
      data = null;
      clear(summary);
      clear(out).append(h('div', { class: 'table-wrap' }, stateFromError(e, 'Services')));
    }
  }

  function card(label, value, bubble, ic, key) {
    return h('div', { class: 'summary-card', style: { cursor: 'pointer', outline: statusFilter === key ? '1px solid var(--accent-2)' : 'none' }, onclick: () => { statusFilter = statusFilter === key ? '' : key; page = 0; draw(); } },
      h('div', { class: `bubble ${bubble}` }, icon(ic, 18)), h('div', {}, h('div', { class: 'k' }, label), h('div', { class: 'v' }, value)));
  }

  function draw() {
    if (!data) return;
    const s = data.summary;
    clear(summary).append(
      card('Total Services', s.total, 'bubble-blue', 'cube', ''),
      card('Healthy', s.healthy, 'bubble-green', 'heart', 'healthy'),
      card('Degraded', s.degraded, 'bubble-orange', 'alert', 'degraded'),
      card('Down', s.down, 'bubble-red', 'down', 'down'));
    if (s.noTraffic) summary.append(card('No traffic', s.noTraffic, 'bubble-blue', 'activity', 'no_traffic'));
    summary.className = `grid ${s.noTraffic ? 'cards-5' : 'cards-4'}`;
    clear(out);
    if (!data.list.length) {
      out.append(h('div', { class: 'table-wrap' }, stateView('empty', {
        title: 'No services discovered',
        text: 'Prometheus answered, but no application request metrics match the queries in config/services.json. Edit that file to match your applications\' metrics.',
      })));
      return;
    }
    const order = { down: 0, degraded: 1, healthy: 2, no_traffic: 3 };
    const val = (x, k) => (k === 'status' ? order[x.status] : k === 'name' ? x.name : x[k] ?? -1);
    const rows = data.list
      .filter((x) => (!search || x.name.toLowerCase().includes(search)) && (!statusFilter || x.status === statusFilter))
      .sort((a, b) => { const A = val(a, sortKey), B = val(b, sortKey); return (A > B ? 1 : A < B ? -1 : a.name.localeCompare(b.name)) * sortDir; });
    if (!rows.length) {
      out.append(h('div', { class: 'table-wrap' }, stateView('empty', { title: 'No services match these filters', text: 'Clear the search box or the status tile filter.' })));
      return;
    }
    const pg = paginate(rows, { page, pageSize: 50, noun: rows.length === 1 ? 'service' : 'services', onPage: (p) => { page = p; draw(); },
      note: rows.length < data.list.length ? `(filtered from ${data.list.length})` : null });
    page = pg.page;
    const th = (label, key, num) => h('th', { class: `sortable ${num ? 'num' : ''}`, onclick: () => { sortDir = sortKey === key ? -sortDir : 1; sortKey = key; draw(); } },
      label, sortKey === key ? (sortDir > 0 ? ' ▲' : ' ▼') : ' ⌄');
    out.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, th('Service', 'name'), th('Status', 'status'), th('Requests/s', 'rps', true), th('Latency (P95)', 'p95', true), th('Error Rate', 'errorRate', true), h('th', { class: 'num' }, 'Actions'))),
      h('tbody', {}, pg.rows.map((x) => {
        // null = not reported / not meaningful (e.g. no traffic): show "-", never 0 or 100%
        const errCls = x.errorRate === null ? 'dim' : x.errorRate >= 5 ? 'c-red' : x.errorRate >= 1 ? 'c-orange' : 'c-green';
        const latCls = x.p95 === null ? 'dim' : x.p95 >= 1000 ? 'c-red' : x.p95 >= 500 ? 'c-orange' : '';
        return h('tr', {},
          h('td', {}, h('b', { style: { fontWeight: 600 } }, x.name), x.namespace ? h('span', { class: 'dim', style: { marginLeft: '8px', fontSize: '11.5px' } }, x.namespace) : null),
          h('td', {}, healthPill(x.status)),
          h('td', { class: 'num' }, short(x.rps)),
          h('td', { class: `num ${latCls}` }, x.p95 === null ? '-' : fmt(x.p95, 'ms')),
          h('td', { class: `num ${errCls}` }, x.errorRate === null ? '-' : `${x.errorRate.toFixed(1)}%`),
          h('td', {}, h('div', { class: 'row-actions' },
            // links only to modules this deployment uses and this user may open
            ctx.canOpen('/logs') ? h('button', { class: 'icon-btn', title: 'View logs', 'aria-label': `View logs for ${x.name}`, onclick: () => ctx.navigate(`/logs?q=${encodeURIComponent(`{app="${x.name}"}`)}`) }, icon('logs', 15)) : null,
            ctx.canOpen('/traces') ? h('button', { class: 'icon-btn', title: 'View traces', 'aria-label': `View traces for ${x.name}`, onclick: () => ctx.navigate(`/traces?q=${encodeURIComponent(`service.name=${x.name}`)}`) }, icon('traces', 15)) : null)));
      }))), pg.foot));
  }

  load();
  return { refresh: load };
}
