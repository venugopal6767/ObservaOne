// Shared PromQL for servers, whatever collects them:
//   - ObservaOne Go agent (Linux 1.1+): pushes its own computed values; its series carry an agent_id label
//   - previous-generation agents (Windows, Docker, Kubernetes, Linux 1.0): push windows_exporter / node_exporter
//     data through the OpenTelemetry Collector (label agent="observaone", no agent_id)
//   - servers scraped directly by Prometheus (node_exporter / windows_exporter)
//
// Rules:
//   1. Never show an old value: pushed series get no "stale" marker when an agent stops, so every value must have a
//      sample from the last FRESH seconds, otherwise the host has no value ("-").
//   2. CPU = 1 - idle time / total time, both rates over the same window. The extrapolation errors of rate() cancel,
//      so the value is right from the second sample on (a plain rate(idle[5m]) is far too low for the first
//      5 minutes, which made CPU look high and keep moving on every refresh).
const FRESH = 120; // seconds: Go agent sends every 15 s, previous agents every 30 s
const WIN_DISK = 'volume!~"HarddiskVolume.*"';
const LNX_FS = 'fstype!~"tmpfs|overlay|squashfs|ramfs|nsfs|fuse.*"';
const NOT_GO = 'agent_id=""'; // series that are not from the Go agent (it has its own computed metrics)

const off = (o) => (o ? ` offset ${o}` : '');
const secs = (o) => { const m = /^(\d+)([smhd])$/.exec(o || ''); return m ? Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]] : 0; };
// hosts whose metric has a sample in the FRESH seconds before the evaluation time (minus the offset)
const fresh = (metric, o) => `(max by (host) (timestamp(${metric}${off(o)})) > time() - ${secs(o) + FRESH})`;
const lastFresh = (metric, o) => `last_over_time(${metric}[${FRESH}s]${off(o)})`;

const cpuShare = (counter, sel, o) =>
  `clamp(100 * (1 - sum by (host) (rate(${counter}{mode="idle",${sel}}[5m]${off(o)}))`
  + ` / sum by (host) (rate(${counter}{${sel}}[5m]${off(o)}))), 0, 100)`
  + ` and on (host) ${fresh(`${counter}{mode="idle",${sel}}`, o)}`;

export function cpuByHost(offset = '') {
  return `clamp(max by (host) (${lastFresh('observaone_cpu_utilization_ratio', offset)}) * 100, 0, 100)`
    + ` or (${cpuShare('windows_cpu_time_total', 'core!=""', offset)})`
    + ` or (${cpuShare('node_cpu_seconds_total', NOT_GO, offset)})`;
}

export function memByHost(offset = '') {
  const o = off(offset);
  return `max by (host) (100 * ${lastFresh('observaone_memory_utilization_ratio', offset)})`
    + ` or (max by (host) (100 * (1 - windows_memory_available_bytes${o} / windows_memory_physical_total_bytes${o}))`
    + ` and on (host) ${fresh('windows_memory_available_bytes', offset)})`
    + ` or (max by (host) (100 * (1 - node_memory_MemAvailable_bytes{${NOT_GO}}${o} / node_memory_MemTotal_bytes{${NOT_GO}}${o}))`
    + ` and on (host) ${fresh(`node_memory_MemAvailable_bytes{${NOT_GO}}`, offset)})`;
}

export function diskFreeByHost() {
  return `min by (host) (100 * (1 - ${lastFresh(`observaone_filesystem_utilization_ratio{${LNX_FS}}`)}))`
    + ` or (min by (host) (100 * windows_logical_disk_free_bytes{${WIN_DISK}} / windows_logical_disk_size_bytes{${WIN_DISK}})`
    + ` and on (host) ${fresh(`windows_logical_disk_size_bytes{${WIN_DISK}}`)})`
    + ` or (min by (host) (100 * node_filesystem_avail_bytes{${LNX_FS},${NOT_GO}} / node_filesystem_size_bytes{${LNX_FS},${NOT_GO}})`
    + ` and on (host) ${fresh(`node_filesystem_size_bytes{${LNX_FS},${NOT_GO}}`)})`;
}

// Servers up now: agents that sent data in the last FRESH seconds, and scraped servers that are up.
export const SERVERS_UP = `(max by (host) (last_over_time(up{agent="observaone",job=~"windows|linux"}[${FRESH}s])) or max by (host) (up{job=~"windows|linux",agent!="observaone"}))`;
