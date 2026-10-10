import { h, api, clear, icon, emptyState, fmt, ago, pill } from '../ui.js';
import { errorState, staleNotice } from '../personas/widgets.js';

const CPU = 'clamp(max by (host) (100 - avg by (instance, host) (rate(windows_cpu_time_total{mode="idle"}[5m])) * 100), 0, 100) or clamp(max by (host) (100 - avg by (instance, host) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100), 0, 100)';
const MEM = 'max by (host) (100 * (1 - windows_memory_available_bytes / windows_memory_physical_total_bytes)) or max by (host) (100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes))';
const DISK = 'min by (host) (100 * windows_logical_disk_free_bytes{volume!~"HarddiskVolume.*"} / windows_logical_disk_size_bytes{volume!~"HarddiskVolume.*"}) or min by (host) (100 * node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs|ramfs|nsfs|fuse.*"} / node_filesystem_size_bytes{fstype!~"tmpfs|overlay|squashfs|ramfs|nsfs|fuse.*"})';

export function infrastructurePage(main, ctx) {
  ctx.setDsChip('Prometheus', '#22c55e');
  const out = h('div', {}, h('div', { class: 'table-wrap skeleton', style: { height: '260px' } }));
  const other = h('div', { style: { marginTop: '18px' } });
  const notes = h('div');
  const stale = h('div');
  main.append(h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Infrastructure'), h('p', {}, 'Every server: scraped by Prometheus or sending through the ObservaOne Agent'))), stale, notes, out, other);
  let loaded = false, okAt = 0;

  async function load() {
    try {
      // a failed CPU / memory / disk query is reported, never shown as an empty column
      const metric = (q, label) => api('/prom/query', { query: { query: q } }).then((r) => ({ r }), (e) => ({ r: { result: [] }, err: `${label}: ${e.message}` }));
      const [targets, cpu, mem, disk] = await Promise.all([api('/prom/targets'), metric(CPU, 'CPU'), metric(MEM, 'Memory'), metric(DISK, 'Disk')]);
      const m = (x) => new Map(x.r.result.map((y) => [y.metric.host, Number(y.value[1])]));
      const C = m(cpu), M = m(mem), D = m(disk);
      const failed = [cpu, mem, disk].filter((x) => x.err).map((x) => x.err);
      const allServers = targets.filter((t) => t.job === 'windows' || t.job === 'linux');
      // the environment picked in the top bar applies here too
      const env = ctx.env;
      const servers = allServers.filter((t) => !env || t.env === env).sort((a, b) => (a.health === b.health ? a.host.localeCompare(b.host) : a.health === 'up' ? 1 : -1));
      clear(stale); loaded = true; okAt = Date.now();
      clear(notes).append(...[
        failed.length ? h('div', { class: 'error-box warn', role: 'status', style: { marginBottom: '12px' } }, icon('alert', 16), h('span', {}, `Some figures are unavailable, so those columns show "—": ${failed.join(' · ')}`)) : null,
        env ? h('p', { class: 'muted', style: { margin: '0 0 10px' } }, `Environment ${env}: ${servers.length} of ${allServers.length} servers. `, h('a', { href: location.pathname, onclick: (e) => { e.preventDefault(); document.querySelector('#env').value = ''; document.querySelector('#env').dispatchEvent(new Event('change')); } }, 'Show all environments')) : null].filter(Boolean));
      const val = (map, host, hi) => (map.has(host) ? fmt(map.get(host), 'percent') : h('span', { class: 'dim', title: 'No value for this server' }, '—'));
      const rest = targets.filter((t) => t.job !== 'windows' && t.job !== 'linux');
      const tone = (v, hi = true) => (v === undefined ? '' : hi ? (v >= 90 ? 'c-red' : v >= 80 ? 'c-orange' : '') : (v < 10 ? 'c-red' : v < 20 ? 'c-orange' : 'c-green'));
      const minor = new Set([2, 3, 4, 6, 8]);
      clear(out).append(servers.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['Server', 'Status', 'OS', 'Env', 'Role', 'CPU', 'Memory', 'Lowest disk free', 'Last scrape', h('span', { class: 'sr-only' }, 'Dashboard')].map((x, i) => h('th', { class: `${i >= 5 && i <= 7 ? 'num' : ''} ${minor.has(i) ? 'col-phone-hide' : ''}` }, x)))),
        h('tbody', {}, servers.map((t) => h('tr', {},
          h('td', {}, h('b', { style: { fontWeight: 600 } }, t.host), t.source === 'agent' ? h('div', { class: 'dim', style: { fontSize: '11px' } }, h('a', { href: ctx.link('/agents'), 'data-link': true }, 'via ObservaOne Agent')) : h('div', { class: 'dim mono', style: { fontSize: '11px' } }, t.instance)),
          h('td', {}, t.health === 'up' ? pill('UP', 'solid-green') : h('span', { class: 'pill pill-solid-orange', title: `${t.lastError ? `${t.lastError}. ` : ''}The exporter is not answering, so the host's own state is unknown.` }, 'NOT REPORTING')),
          h('td', { class: 'col-phone-hide' }, t.os === 'windows' ? 'Windows' : 'Linux'),
          h('td', { class: 'col-phone-hide' }, t.env || '—'), h('td', { class: 'col-phone-hide' }, t.role || '—'),
          h('td', { class: `num ${tone(C.get(t.host))}` }, val(C, t.host)),
          h('td', { class: `num col-phone-hide ${tone(M.get(t.host))}` }, val(M, t.host)),
          h('td', { class: `num ${tone(D.get(t.host), false)}` }, val(D, t.host)),
          h('td', { class: 'dim col-phone-hide' }, t.lastScrape ? ago(t.lastScrape) : '—'),
          h('td', {}, h('a', { href: ctx.link(`/dashboards/${t.os === 'windows' ? 'windows' : 'linux'}-servers`), 'data-link': true, onclick: () => sessionStorage.setItem(`oo.var.${t.os === 'windows' ? 'windows' : 'linux'}-servers.host`, t.host), title: `Open the dashboard for ${t.host}`, 'aria-label': `Open the dashboard for ${t.host}` }, icon('dashboards', 15))))))))
        : h('div', { class: 'table-wrap' }, env && allServers.length ? emptyState(`No servers in environment ${env}`, 'Pick another environment in the top bar.')
          : emptyState('No servers yet', 'Install the ObservaOne Agent (Agents page), or add Windows servers to prometheus/targets/windows.yml and Linux servers to linux.yml.')));
      clear(other).append(h('h3', { style: { margin: '0 0 10px', fontSize: '14px' } }, 'Monitoring components'),
        h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Job'), h('th', { class: 'col-phone-hide' }, 'Endpoint'), h('th', {}, 'Status'), h('th', { class: 'num col-phone-hide' }, 'Scrape time'), h('th', {}, 'Error'))),
          h('tbody', {}, rest.map((t) => h('tr', {}, h('td', {}, t.job), h('td', { class: 'mono col-phone-hide' }, t.instance),
            h('td', {}, t.health === 'up' ? pill('UP', 'green') : pill('DOWN', 'red')),
            h('td', { class: 'num col-phone-hide' }, `${t.durationMs} ms`), h('td', { class: 'dim', style: { fontSize: '12px' } }, t.lastError || '—')))))));
    } catch (e) {
      if (loaded) clear(stale).append(staleNotice({ okAt, message: e.message, retry: () => ctx.refreshNow() }));
      else { clear(other); clear(out).append(errorState(e.message, () => ctx.refreshNow(), 'Infrastructure could not load')); }
      throw e;
    }
  }
  const ready = load();
  ready.catch(() => {});
  return { refresh: load, ready };
}
