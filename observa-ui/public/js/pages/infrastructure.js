import { h, api, clear, icon, fmt, ago, pill, stateView, stateFromError, healthPill, paginate, stateBanner, timeEl, color } from '../ui.js';

const CPU = 'clamp(max by (host) (100 - avg by (instance, host) (rate(windows_cpu_time_total{mode="idle"}[5m])) * 100), 0, 100) or clamp(max by (host) (100 - avg by (instance, host) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100), 0, 100)';
const MEM = 'max by (host) (100 * (1 - windows_memory_available_bytes / windows_memory_physical_total_bytes)) or max by (host) (100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes))';
const DISK = 'min by (host) (100 * windows_logical_disk_free_bytes{volume!~"HarddiskVolume.*"} / windows_logical_disk_size_bytes{volume!~"HarddiskVolume.*"}) or min by (host) (100 * node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs|ramfs|nsfs|fuse.*"} / node_filesystem_size_bytes{fstype!~"tmpfs|overlay|squashfs|ramfs|nsfs|fuse.*"})';

export function infrastructurePage(main, ctx) {
  ctx.setDsChip('Prometheus', color('ok'));
  const out = h('div', {}, h('div', { class: 'table-wrap' }, stateView('loading', { skeleton: 'table' })));
  let page = 0;
  const other = h('div', { style: { marginTop: '18px' } });
  main.append(h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Infrastructure'), h('p', {}, 'Every server: scraped by Prometheus or sending through the ObservaOne Agent'))), out, other);

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
      const rest = targets.filter((t) => t.job !== 'windows' && t.job !== 'linux');
      const tone = (v, hi = true) => (v === undefined ? '' : hi ? (v >= 90 ? 'c-red' : v >= 80 ? 'c-orange' : '') : (v < 10 ? 'c-red' : v < 20 ? 'c-orange' : 'c-green'));
      const pg = paginate(servers, { page, pageSize: 50, noun: servers.length === 1 ? 'host' : 'hosts', onPage: (p) => { page = p; load(); } });
      page = pg.page;
      clear(out).append(failed.length ? stateBanner('partial', `Some values could not be loaded and show "-". ${failed.join(' · ')}`) : '',
        servers.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['Server', 'Status', 'OS', 'Env', 'Role', 'CPU', 'Memory', 'Lowest disk free', 'Last scrape', ''].map((x, i) => h('th', { class: i >= 5 && i <= 7 ? 'num' : '' }, x)))),
        h('tbody', {}, pg.rows.map((t) => h('tr', {},
          h('td', {}, h('b', { style: { fontWeight: 600 } }, t.host), t.source === 'agent' ? h('div', { class: 'dim', style: { fontSize: '11px' } }, ctx.canOpen('/agents') ? h('a', { href: '/agents', 'data-link': true }, 'via ObservaOne Agent') : 'via ObservaOne Agent') : h('div', { class: 'dim mono', style: { fontSize: '11px' } }, t.instance)),
          h('td', {}, healthPill(t.health, t.lastError || undefined)),
          h('td', {}, t.os === 'windows' ? 'Windows' : 'Linux'),
          h('td', {}, t.env || '-'), h('td', {}, t.role || '-'),
          h('td', { class: `num ${tone(C.get(t.host))}` }, fmt(C.get(t.host), 'percent')),
          h('td', { class: `num ${tone(M.get(t.host))}` }, fmt(M.get(t.host), 'percent')),
          h('td', { class: `num ${tone(D.get(t.host), false)}` }, fmt(D.get(t.host), 'percent')),
          h('td', { class: 'dim', title: t.source === 'agent' ? 'Last data received from the agent' : 'Last scrape by Prometheus' }, t.lastScrape ? timeEl(Date.parse(t.lastScrape), ago(t.lastScrape)) : '-'),
          h('td', {}, !ctx.canOpen('/dashboards') ? null : h('a', { href: `/dashboards/${t.os === 'windows' ? 'windows' : 'linux'}-servers`, 'data-link': true, onclick: () => sessionStorage.setItem(`oo.var.${t.os === 'windows' ? 'windows' : 'linux'}-servers.host`, t.host), title: 'Open dashboard', 'aria-label': `Open dashboard for ${t.host}` }, icon('dashboards', 15))))))), pg.foot)
        : h('div', { class: 'table-wrap' }, stateView('empty', {
          title: 'No monitored hosts available',
          text: 'Install the ObservaOne Agent on a server, or add it to prometheus/targets/windows.yml or linux.yml.',
          action: ctx.canOpen('/agents') ? h('a', { href: '/agents', 'data-link': true, class: 'btn btn-sm' }, 'Install an agent') : null,
        })));
      clear(other).append(h('h3', { style: { margin: '0 0 10px', fontSize: '14px' } }, 'Monitoring components'),
        h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Job'), h('th', {}, 'Endpoint'), h('th', {}, 'Status'), h('th', { class: 'num' }, 'Scrape time'), h('th', {}, 'Error'))),
          h('tbody', {}, rest.map((t) => h('tr', {}, h('td', {}, t.job), h('td', { class: 'mono' }, t.instance),
            h('td', {}, t.health === 'up' ? pill('UP', 'green') : t.health === 'down' ? pill('DOWN', 'red') : pill('Unknown', 'muted')),
            h('td', { class: 'num' }, `${t.durationMs} ms`), h('td', { class: 'dim', style: { fontSize: '12px' } }, t.lastError || '')))))));
    } catch (e) {
      clear(other);
      clear(out).append(h('div', { class: 'table-wrap' }, stateFromError(e, 'Infrastructure')));
    }
  }
  load();
  return { refresh: load };
}
