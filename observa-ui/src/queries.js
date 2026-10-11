// Shared PromQL for servers: ObservaOne Agent (pushes), Windows (windows_exporter) and Linux (node_exporter) scraped.
//
// Agent hosts use the values the agent computes itself, and only when they are FRESH (a sample in the last
// minute; agents send every 15 s). A stopped agent therefore shows "-", never a stale or drifting number.
// Why not rate(node_cpu_seconds_total[5m]) for them: pushed series get no "stale" marker when the agent
// stops, so a 5-minute rate over fewer and fewer samples makes CPU climb on every refresh.
// Scraped hosts keep the classic exporter queries (Prometheus marks their series stale when a scrape fails).
const WIN_DISK = 'volume!~"HarddiskVolume.*"';
const LNX_FS = 'fstype!~"tmpfs|overlay|squashfs|ramfs|nsfs|fuse.*"';
const FRESH = '1m';
const NOT_AGENT = 'agent!="observaone"';
const off = (o) => (o ? ` offset ${o}` : '');

export function cpuByHost(offset = '') {
  const o = off(offset);
  return `clamp(max by (host) (last_over_time(observaone_cpu_utilization_ratio[${FRESH}]${o})) * 100, 0, 100)`
    + ` or clamp(max by (host) (100 - avg by (instance, host) (rate(windows_cpu_time_total{mode="idle"}[5m]${o})) * 100), 0, 100)`
    + ` or clamp(max by (host) (100 - avg by (instance, host) (rate(node_cpu_seconds_total{mode="idle",${NOT_AGENT}}[5m]${o})) * 100), 0, 100)`;
}

export function memByHost(offset = '') {
  const o = off(offset);
  return `max by (host) (100 * last_over_time(observaone_memory_utilization_ratio[${FRESH}]${o}))`
    + ` or max by (host) (100 * (1 - windows_memory_available_bytes${o} / windows_memory_physical_total_bytes${o}))`
    + ` or max by (host) (100 * (1 - node_memory_MemAvailable_bytes{${NOT_AGENT}}${o} / node_memory_MemTotal_bytes{${NOT_AGENT}}${o}))`;
}

export function diskFreeByHost() {
  return `min by (host) (100 * (1 - last_over_time(observaone_filesystem_utilization_ratio{${LNX_FS}}[${FRESH}])))`
    + ` or min by (host) (100 * windows_logical_disk_free_bytes{${WIN_DISK}} / windows_logical_disk_size_bytes{${WIN_DISK}})`
    + ` or min by (host) (100 * node_filesystem_avail_bytes{${LNX_FS},${NOT_AGENT}} / node_filesystem_size_bytes{${LNX_FS},${NOT_AGENT}})`;
}

// Servers up now. Agent hosts count while they sent data in the last minute.
export const SERVERS_UP = `(max by (host) (last_over_time(up{agent="observaone"}[${FRESH}])) or max by (host) (up{job=~"windows|linux",${NOT_AGENT}}))`;
