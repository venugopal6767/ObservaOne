import { h, api, clear, icon, fmt, ago, pill, stateView, stateFromError, healthPill, paginate, stateBanner, timeEl, color } from '../ui.js';

// same queries as the server (src/queries.js): agent values only when fresh, so a stopped agent shows "-"
const CPU = "clamp(max by (host) (last_over_time(observaone_cpu_utilization_ratio[1m])) * 100, 0, 100) or clamp(max by (host) (100 - avg by (instance, host) (rate(windows_cpu_time_total{mode=\"idle\"}[5m])) * 100), 0, 100) or clamp(max by (host) (100 - avg by (instance, host) (rate(node_cpu_seconds_total{mode=\"idle\",agent!=\"observaone\"}[5m])) * 100), 0, 100)";
const MEM = "max by (host) (100 * last_over_time(observaone_memory_utilization_ratio[1m])) or max by (host) (100 * (1 - windows_memory_available_bytes / windows_memory_physical_total_bytes)) or max by (host) (100 * (1 - node_memory_MemAvailable_bytes{agent!=\"observaone\"} / node_memory_MemTotal_bytes{agent!=\"observaone\"}))";
const DISK = "min by (host) (100 * (1 - last_over_time(observaone_filesystem_utilization_ratio{fstype!~\"tmpfs|overlay|squashfs|ramfs|nsfs|fuse.*\"}[1m]))) or min by (host) (100 * windows_logical_disk_free_bytes{volume!~\"HarddiskVolume.*\"} / windows_logical_disk_size_bytes{volume!~\"HarddiskVolume.*\"}) or min by (host) (100 * node_filesystem_avail_bytes{fstype!~\"tmpfs|overlay|squashfs|ramfs|nsfs|fuse.*\",agent!=\"observaone\"} / node_filesystem_size_bytes{fstype!~\"tmpfs|overlay|squashfs|ramfs|nsfs|fuse.*\",agent!=\"observaone\"})";

export function infrastructurePage(main, ctx) {
  ctx.setDsChip('Prometheus', color('ok'));
  const out = h('div', {}, h('div', { class: 'table-wrap' }, stateView('loading', { skeleton: 'table' })));
  let page = 0;
  main.append(h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Infrastructure'), h('p', {}, 'Every server: scraped by Prometheus or sending through the ObservaOne Agent'))), out);

  // how this server is collected: "ObservaOne Agent", "Prometheus scrape (host:9100)" or both
  function collectedBy(t) {
    const c = t.collection || [t.source];
    const agentLink = ctx.canOpen('/agents')
      ? h('a', { href: `/agents/${t.os === 'windows' ? 'windows' : 'linux'}`, 'data-link': true }, 'ObservaOne Agent') : 'ObservaOne Agent';
    const scrape = h('span', { class: 'mono' }, `scrape ${t.instance && t.instance !== 'agent' ? t.instance : ''}`.trim());
    if (c.includes('agent') && c.includes('scrape')) return [agentLink, ' + ', scrape];
    return c.includes('agent') ? agentLink : scrape;
  }

  async function load() {
    try {
      // host list is required; CPU/memory/disk are extras: if they fail we say so (partial data), never show 0
      const failed = [];
      const extra = (name, q) => api('/prom/query', { query: { query: q } }).catch((e) => { failed.push(`${name}: ${e.message}`); return { result: [] }; });
      const [targets, cpu, mem, disk] = await Promise.all([
        api('/prom/targets'), extra('CPU', CPU), extra('Memory', MEM), extra('Disk', DISK),
      ]);
      const m = (r) => new Map(r.result.map((x) => [x.metric.host, Number(x.value[1])]));
      const C = m(cpu), M = m(mem), D = m(disk);
      // problems first: down, then not reporting / unknown, then up
      const rank = { down: 0, not_reporting: 1, unknown: 2, up: 3 };
      const servers = targets.filter((t) => t.job === 'windows' || t.job === 'linux')
        .sort((a, b) => ((rank[a.health] ?? 2) - (rank[b.health] ?? 2)) || a.host.localeCompare(b.host));
      const tone = (v, hi = true) => (v === undefined ? '' : hi ? (v >= 90 ? 'c-red' : v >= 80 ? 'c-orange' : '') : (v < 10 ? 'c-red' : v < 20 ? 'c-orange' : 'c-green'));
      const pg = paginate(servers, { page, pageSize: 50, noun: servers.length === 1 ? 'host' : 'hosts', onPage: (p) => { page = p; load(); } });
      page = pg.page;
      clear(out).append(failed.length ? stateBanner('partial', `Some values could not be loaded and show "-". ${failed.join(' · ')}`) : '',
        servers.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['Server', 'Status', 'OS', 'Env', 'Role', 'CPU', 'Memory', 'Lowest disk free', 'Last seen', ''].map((x, i) => h('th', { class: i >= 5 && i <= 7 ? 'num' : '' }, x)))),
        h('tbody', {}, pg.rows.map((t) => h('tr', {},
          h('td', {}, h('b', { style: { fontWeight: 600 } }, t.host), h('div', { class: 'dim', style: { fontSize: '11px' } }, collectedBy(t))),
          h('td', {}, healthPill(t.health, t.lastError || undefined),
            // both methods: a failing scrape is shown separately from the agent's own state
            t.scrapeHealth && t.scrapeHealth !== 'up' && (t.collection || []).length > 1
              ? h('div', { class: 'c-orange', style: { fontSize: '11px', marginTop: '3px' }, title: t.scrapeError || '' }, `Prometheus scrape: ${t.scrapeHealth}`) : null),
          h('td', {}, t.os === 'windows' ? 'Windows' : 'Linux'),
          h('td', {}, t.env || '-'), h('td', {}, t.role || '-'),
          h('td', { class: `num ${tone(C.get(t.host))}` }, fmt(C.get(t.host), 'percent')),
          h('td', { class: `num ${tone(M.get(t.host))}` }, fmt(M.get(t.host), 'percent')),
          h('td', { class: `num ${tone(D.get(t.host), false)}` }, fmt(D.get(t.host), 'percent')),
          h('td', { class: 'dim', title: t.source === 'agent' ? 'Last heartbeat (or data) from the agent' : 'Last scrape by Prometheus' }, (t.lastHeartbeat || t.lastScrape) ? timeEl(Date.parse(t.lastHeartbeat || t.lastScrape), ago(t.lastHeartbeat || t.lastScrape)) : '-'),
          h('td', {}, !ctx.canOpen('/dashboards') ? null : h('a', { href: `/dashboards/${t.os === 'windows' ? 'windows' : 'linux'}-servers`, 'data-link': true, onclick: () => sessionStorage.setItem(`oo.var.${t.os === 'windows' ? 'windows' : 'linux'}-servers.host`, t.host), title: 'Open dashboard', 'aria-label': `Open dashboard for ${t.host}` }, icon('dashboards', 15))))))), pg.foot)
        : h('div', { class: 'table-wrap' }, stateView('empty', {
          title: 'No monitored hosts available',
          text: 'Install the ObservaOne Agent on a server, or add it to prometheus/targets/windows.yml or linux.yml.',
          action: ctx.canOpen('/agents') ? h('a', { href: '/agents', 'data-link': true, class: 'btn btn-sm' }, 'Install an agent') : null,
        })));
      // only your servers here: the monitoring stack's own components are on the Data Sources page
    } catch (e) {
      clear(out).append(h('div', { class: 'table-wrap' }, stateFromError(e, 'Infrastructure')));
    }
  }
  load();
  return { refresh: load };
}
