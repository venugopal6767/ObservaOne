// Shared PromQL for Windows (windows_exporter) and Linux (node_exporter) servers.
const WIN_DISK = 'volume!~"HarddiskVolume.*"';
const LNX_FS = 'fstype!~"tmpfs|overlay|squashfs|ramfs|nsfs|fuse.*"';

export function cpuByHost(offset = '') {
  const o = offset ? ` offset ${offset}` : '';
  return `clamp(max by (host) (100 - avg by (instance, host) (rate(windows_cpu_time_total{mode="idle"}[5m]${o})) * 100), 0, 100)`
    + ` or clamp(max by (host) (100 - avg by (instance, host) (rate(node_cpu_seconds_total{mode="idle"}[5m]${o})) * 100), 0, 100)`;
}

export function memByHost(offset = '') {
  const o = offset ? ` offset ${offset}` : '';
  return `max by (host) (100 * (1 - windows_memory_available_bytes${o} / windows_memory_physical_total_bytes${o}))`
    + ` or max by (host) (100 * (1 - node_memory_MemAvailable_bytes${o} / node_memory_MemTotal_bytes${o}))`;
}

export function diskFreeByHost() {
  return `min by (host) (100 * windows_logical_disk_free_bytes{${WIN_DISK}} / windows_logical_disk_size_bytes{${WIN_DISK}})`
    + ` or min by (host) (100 * node_filesystem_avail_bytes{${LNX_FS}} / node_filesystem_size_bytes{${LNX_FS}})`;
}

export const SERVERS_UP = 'up{job=~"windows|linux"}';
