// Metrics a user can pick without writing PromQL. Each query works for every way a host can report:
//   - ObservaOne Go agent (Linux 1.1+): its own computed observaone_* values; its series carry agent_id
//   - previous-generation agents (Windows, Docker, Kubernetes, Linux 1.0) and directly scraped servers:
//     windows_exporter / node_exporter / cAdvisor / kube-state-metrics data (no agent_id)
// Metric names were checked against windows_exporter 0.31.8, node_exporter 1.12.1 and the agent configs.
//
// q(f) builds the query. f(name, base) returns `name{base,<filters>}` with the user's filters merged in.
// `by` is what one series stands for (shown in the table); `worse` says which way is bad (for "worst 5").

const NOT_GO = 'agent_id=""';
const NIC_LNX = 'device!~"lo|veth.*|docker.*|br-.*|cni.*|flannel.*|cali.*|virbr.*"';
const NIC_WIN = 'nic!~".*(isatap|Loopback|Teredo).*"';
const FS_LNX = 'fstype!~"tmpfs|overlay|squashfs|ramfs|nsfs|fuse.*"';
const VOL_WIN = 'volume!~"HarddiskVolume.*"';
const CTR = 'image!="",container!="POD"'; // real containers (cAdvisor also reports cgroups without an image)
// Docker names a container with "name"; Kubernetes with namespace / pod / container
const CTR_BY = 'host, name, namespace, pod, container';

export const GROUPS = [
  ['common', 'Common'],
  ['linux', 'Linux'],
  ['windows', 'Windows'],
  ['containers', 'Containers'],
  ['kubernetes', 'Kubernetes'],
  ['agent', 'Agent health'],
];

export const CATALOG = [
  // ---------------- common: every server ----------------
  {
    id: 'cpu', group: 'common', label: 'CPU used', unit: 'percent', worse: 'high', by: 'host', max: 100,
    desc: 'Share of CPU time not idle, all cores together. Above 80-90% for long means the server is short of CPU.',
    q: (f) => `clamp(100 * max by (host) (${f('observaone_cpu_utilization_ratio')}), 0, 100)`
      + ` or clamp(100 * (1 - sum by (host) (rate(${f('windows_cpu_time_total', 'mode="idle"')}[5m])) / sum by (host) (rate(${f('windows_cpu_time_total')}[5m]))), 0, 100)`
      + ` or clamp(100 * (1 - sum by (host) (rate(${f('node_cpu_seconds_total', `mode="idle",${NOT_GO}`)}[5m])) / sum by (host) (rate(${f('node_cpu_seconds_total', NOT_GO)}[5m]))), 0, 100)`,
  },
  {
    id: 'memory', group: 'common', label: 'Memory used', unit: 'percent', worse: 'high', by: 'host', max: 100,
    desc: 'Memory in use by programs (file cache that can be freed does not count). Near 100% the server starts swapping or killing processes.',
    q: (f) => `100 * max by (host) (${f('observaone_memory_utilization_ratio')})`
      + ` or 100 * (1 - max by (host) (${f('windows_memory_available_bytes')}) / max by (host) (${f('windows_memory_physical_total_bytes')}))`
      + ` or 100 * (1 - max by (host) (${f('node_memory_MemAvailable_bytes', NOT_GO)}) / max by (host) (${f('node_memory_MemTotal_bytes', NOT_GO)}))`,
  },
  {
    id: 'memory_bytes', group: 'common', label: 'Memory used (bytes)', unit: 'bytes', worse: 'high', by: 'host',
    desc: 'Memory in use by programs, in bytes.',
    q: (f) => `max by (host) (${f('observaone_memory_used_bytes')})`
      + ` or max by (host) (${f('windows_memory_physical_total_bytes')}) - max by (host) (${f('windows_memory_available_bytes')})`
      + ` or max by (host) (${f('node_memory_MemTotal_bytes', NOT_GO)}) - max by (host) (${f('node_memory_MemAvailable_bytes', NOT_GO)})`,
  },
  {
    id: 'disk_free', group: 'common', label: 'Disk free (fullest disk)', unit: 'percent', worse: 'low', by: 'host', max: 100,
    desc: 'Free space on the fullest disk of each server. Below 10-15% you should act before it fills up.',
    q: (f) => `min by (host) (100 * (1 - ${f('observaone_filesystem_utilization_ratio', FS_LNX)}))`
      + ` or min by (host) (100 * ${f('windows_logical_disk_free_bytes', VOL_WIN)} / ${f('windows_logical_disk_size_bytes', VOL_WIN)})`
      + ` or min by (host) (100 * ${f('node_filesystem_avail_bytes', `${FS_LNX},${NOT_GO}`)} / ${f('node_filesystem_size_bytes', `${FS_LNX},${NOT_GO}`)})`,
  },
  {
    id: 'disk_used_fs', group: 'common', label: 'Disk used per disk', unit: 'percent', worse: 'high', by: 'host, disk', max: 100,
    desc: 'Used space of every disk or volume (C:, D:, /, /var ...).',
    q: (f) => `max by (host, disk) (label_replace(100 * ${f('observaone_filesystem_utilization_ratio', FS_LNX)}, "disk", "$1", "mountpoint", "(.*)"))`
      + ` or max by (host, disk) (label_replace(100 * (1 - ${f('windows_logical_disk_free_bytes', VOL_WIN)} / ${f('windows_logical_disk_size_bytes', VOL_WIN)}), "disk", "$1", "volume", "(.*)"))`
      + ` or max by (host, disk) (label_replace(100 * (1 - ${f('node_filesystem_avail_bytes', `${FS_LNX},${NOT_GO}`)} / ${f('node_filesystem_size_bytes', `${FS_LNX},${NOT_GO}`)}), "disk", "$1", "mountpoint", "(.*)"))`,
  },
  {
    id: 'disk_read', group: 'common', label: 'Disk read', unit: 'Bps', worse: 'high', by: 'host',
    desc: 'Bytes read from disk per second, all disks together.',
    q: (f) => `sum by (host) (${f('observaone_disk_read_bytes_per_second')})`
      + ` or sum by (host) (rate(${f('windows_logical_disk_read_bytes_total', VOL_WIN)}[5m]))`
      + ` or sum by (host) (rate(${f('node_disk_read_bytes_total', NOT_GO)}[5m]))`,
  },
  {
    id: 'disk_write', group: 'common', label: 'Disk write', unit: 'Bps', worse: 'high', by: 'host',
    desc: 'Bytes written to disk per second, all disks together.',
    q: (f) => `sum by (host) (${f('observaone_disk_write_bytes_per_second')})`
      + ` or sum by (host) (rate(${f('windows_logical_disk_write_bytes_total', VOL_WIN)}[5m]))`
      + ` or sum by (host) (rate(${f('node_disk_written_bytes_total', NOT_GO)}[5m]))`,
  },
  {
    id: 'disk_iops', group: 'common', label: 'Disk operations', unit: 'iops', worse: 'high', by: 'host',
    desc: 'Reads plus writes per second, all disks together.',
    q: (f) => `(sum by (host) (${f('observaone_disk_reads_per_second')}) + sum by (host) (${f('observaone_disk_writes_per_second')}))`
      + ` or (sum by (host) (rate(${f('windows_logical_disk_reads_total', VOL_WIN)}[5m])) + sum by (host) (rate(${f('windows_logical_disk_writes_total', VOL_WIN)}[5m])))`
      + ` or (sum by (host) (rate(${f('node_disk_reads_completed_total', NOT_GO)}[5m])) + sum by (host) (rate(${f('node_disk_writes_completed_total', NOT_GO)}[5m])))`,
  },
  {
    id: 'net_in', group: 'common', label: 'Network in', unit: 'bps', worse: 'high', by: 'host',
    desc: 'Traffic received, all network cards together (loopback and container bridges left out).',
    q: (f) => `8 * sum by (host) (${f('observaone_network_receive_bytes_per_second')})`
      + ` or 8 * sum by (host) (rate(${f('windows_net_bytes_received_total', NIC_WIN)}[5m]))`
      + ` or 8 * sum by (host) (rate(${f('node_network_receive_bytes_total', `${NIC_LNX},${NOT_GO}`)}[5m]))`,
  },
  {
    id: 'net_out', group: 'common', label: 'Network out', unit: 'bps', worse: 'high', by: 'host',
    desc: 'Traffic sent, all network cards together (loopback and container bridges left out).',
    q: (f) => `8 * sum by (host) (${f('observaone_network_transmit_bytes_per_second')})`
      + ` or 8 * sum by (host) (rate(${f('windows_net_bytes_sent_total', NIC_WIN)}[5m]))`
      + ` or 8 * sum by (host) (rate(${f('node_network_transmit_bytes_total', `${NIC_LNX},${NOT_GO}`)}[5m]))`,
  },
  {
    id: 'uptime', group: 'common', label: 'Uptime', unit: 's', worse: 'low', by: 'host',
    desc: 'Time since the server last started. A sudden drop means it rebooted.',
    q: (f) => `max by (host) (${f('observaone_uptime_seconds')})`
      + ` or max by (host) (time() - ${f('windows_system_boot_time_timestamp')})`
      + ` or max by (host) (time() - ${f('node_boot_time_seconds', NOT_GO)})`,
  },

  // ---------------- Linux ----------------
  {
    id: 'load1', group: 'linux', label: 'Load average (1 min)', unit: 'none', worse: 'high', by: 'host',
    desc: 'Processes running or waiting for CPU or disk. Compare with the number of cores: above it, work is queuing.',
    q: (f) => `max by (host) (${f('node_load1')})`,
  },
  {
    id: 'load_per_core', group: 'linux', label: 'Load per core', unit: 'none', worse: 'high', by: 'host',
    desc: 'Load average (5 min) divided by the number of cores. Above 1 means work is queuing.',
    q: (f) => `max by (host) (${f('node_load5')}) / count by (host) (${f('node_cpu_seconds_total', 'mode="idle"')})`,
  },
  {
    id: 'iowait', group: 'linux', label: 'CPU waiting for disk', unit: 'percent', worse: 'high', by: 'host', max: 100,
    desc: 'Share of CPU time spent waiting for disk (iowait). High values point to a slow or overloaded disk.',
    q: (f) => `100 * sum by (host) (rate(${f('node_cpu_seconds_total', 'mode="iowait"')}[5m])) / sum by (host) (rate(${f('node_cpu_seconds_total')}[5m]))`,
  },
  {
    id: 'swap', group: 'linux', label: 'Swap used', unit: 'percent', worse: 'high', by: 'host', max: 100,
    desc: 'Swap space in use. Growing swap use with high memory use slows the server down.',
    empty: 'None of the Linux servers has swap space configured (or none matches the filters), so there is nothing to show.',
    q: (f) => `100 * (1 - max by (host) (${f('node_memory_SwapFree_bytes')}) / max by (host) (${f('node_memory_SwapTotal_bytes')} > 0))`,
  },
  {
    id: 'procs', group: 'linux', label: 'Processes running', unit: 'none', worse: 'high', by: 'host',
    desc: 'Processes on the CPU or ready to run.',
    q: (f) => `max by (host) (${f('node_procs_running')})`,
  },
  {
    id: 'net_errors', group: 'linux', label: 'Network errors and drops', unit: 'none', worse: 'high', by: 'host',
    desc: 'Packets per second that failed or were dropped. Should be 0.',
    q: (f) => `sum by (host) (rate(${f('node_network_receive_errs_total', NIC_LNX)}[5m]) + rate(${f('node_network_transmit_errs_total', NIC_LNX)}[5m])`
      + ` + rate(${f('node_network_receive_drop_total', NIC_LNX)}[5m]) + rate(${f('node_network_transmit_drop_total', NIC_LNX)}[5m]))`,
  },
  {
    id: 'fs_readonly', group: 'linux', label: 'Read-only file systems', unit: 'none', worse: 'high', by: 'host',
    desc: 'File systems that turned read-only (often after disk errors). Should be 0.',
    q: (f) => `sum by (host) (${f('node_filesystem_readonly', FS_LNX)})`,
  },

  // ---------------- Windows ----------------
  {
    id: 'win_queue', group: 'windows', label: 'Processor queue length', unit: 'none', worse: 'high', by: 'host',
    desc: 'Threads waiting for a CPU. Consistently above 2 per core means the server is short of CPU.',
    q: (f) => `max by (host) (${f('windows_system_processor_queue_length')})`,
  },
  {
    id: 'win_services', group: 'windows', label: 'Automatic services stopped', unit: 'none', worse: 'high', by: 'host',
    desc: 'Services set to start automatically that are not running. Usually 0 on a healthy server.',
    q: (f) => `count by (host) ((${f('windows_service_state', 'state="stopped"')} == 1) and on (host, name) (${f('windows_service_start_mode', 'start_mode="auto"')} == 1))`,
  },
  {
    id: 'win_threads', group: 'windows', label: 'Threads', unit: 'none', worse: 'high', by: 'host',
    desc: 'Threads in all processes. A steady climb can mean a leak in an application.',
    q: (f) => `max by (host) (${f('windows_system_threads')})`,
  },
  {
    id: 'win_disk_latency', group: 'windows', label: 'Disk read latency', unit: 's', worse: 'high', by: 'host, disk',
    desc: 'Average time per disk read. Above 20 ms the disk is slow for most workloads.',
    q: (f) => `max by (host, disk) (label_replace(rate(${f('windows_logical_disk_read_seconds_total', VOL_WIN)}[5m]) / rate(${f('windows_logical_disk_reads_total', VOL_WIN)}[5m]), "disk", "$1", "volume", "(.*)"))`,
  },

  // ---------------- containers (Docker and Kubernetes agents) ----------------
  {
    id: 'ctr_cpu', group: 'containers', label: 'Container CPU', unit: 'percent', worse: 'high', by: 'container',
    desc: 'CPU used by each container, as a share of one core (200% = two full cores).',
    q: (f) => `100 * sum by (${CTR_BY}) (rate(${f('container_cpu_usage_seconds_total', CTR)}[5m]))`,
  },
  {
    id: 'ctr_mem', group: 'containers', label: 'Container memory', unit: 'bytes', worse: 'high', by: 'container',
    desc: 'Memory in use by each container (working set: what counts against its memory limit).',
    q: (f) => `sum by (${CTR_BY}) (${f('container_memory_working_set_bytes', CTR)})`,
  },
  {
    id: 'ctr_net_in', group: 'containers', label: 'Container network in', unit: 'bps', worse: 'high', by: 'container',
    desc: 'Traffic received by each container.',
    q: (f) => `8 * sum by (${CTR_BY}) (rate(${f('container_network_receive_bytes_total', CTR)}[5m]))`,
  },
  {
    id: 'ctr_oom', group: 'containers', label: 'Containers killed (out of memory)', unit: 'none', worse: 'high', by: 'container',
    desc: 'Containers stopped by the kernel for using too much memory, in the last hour.',
    q: (f) => `sum by (${CTR_BY}) (increase(${f('container_oom_events_total', CTR)}[1h])) > 0`,
  },

  // ---------------- Kubernetes (cluster agent) ----------------
  {
    id: 'k8s_pods_bad', group: 'kubernetes', label: 'Pods not running', unit: 'none', worse: 'high', by: 'cluster, namespace',
    desc: 'Pods Pending, Failed or Unknown, per namespace.',
    q: (f) => `sum by (cluster, namespace) (${f('kube_pod_status_phase', 'phase=~"Pending|Failed|Unknown"')}) > 0`,
  },
  {
    id: 'k8s_restarts', group: 'kubernetes', label: 'Container restarts (last hour)', unit: 'none', worse: 'high', by: 'cluster, namespace, pod',
    desc: 'Restarts per pod in the last hour. Repeated restarts usually mean a crash loop.',
    q: (f) => `sum by (cluster, namespace, pod) (increase(${f('kube_pod_container_status_restarts_total')}[1h])) > 0`,
  },
  {
    id: 'k8s_unavailable', group: 'kubernetes', label: 'Deployments missing replicas', unit: 'none', worse: 'high', by: 'cluster, namespace, deployment',
    desc: 'Replicas a deployment wants but does not have running.',
    q: (f) => `sum by (cluster, namespace, deployment) (${f('kube_deployment_status_replicas_unavailable')}) > 0`,
  },
  {
    id: 'k8s_nodes_notready', group: 'kubernetes', label: 'Nodes not ready', unit: 'none', worse: 'high', by: 'cluster',
    desc: 'Kubernetes nodes reporting NotReady.',
    q: (f) => `sum by (cluster) (${f('kube_node_status_condition', 'condition="Ready",status!="true"')})`,
  },

  // ---------------- agent health ----------------
  {
    id: 'agent_failures', group: 'agent', label: 'Agent upload failures', unit: 'none', worse: 'high', by: 'host',
    desc: 'Uploads to ObservaOne that failed in the last 15 minutes. Should be 0; the agent retries and keeps the data meanwhile.',
    q: (f) => `sum by (host) (increase(${f('observaone_agent_upload_failures_total')}[15m]))`
      + ` or sum by (host) (increase(${f('otelcol_exporter_send_failed_metric_points_total', 'agent="observaone"')}[15m]))`,
  },
  {
    id: 'agent_backlog', group: 'agent', label: 'Agent backlog', unit: 'none', worse: 'high', by: 'host',
    desc: 'Data waiting in the agent to be sent (collections for the Go agent, data points for the previous agent). Grows while ObservaOne is unreachable.',
    q: (f) => `max by (host) (${f('observaone_agent_buffered_payloads')})`
      + ` or sum by (host) (${f('otelcol_exporter_queue_size', 'agent="observaone"')})`,
  },
  {
    id: 'agent_memory', group: 'agent', label: 'Agent memory', unit: 'bytes', worse: 'high', by: 'host',
    desc: 'Memory used by the ObservaOne Agent itself.',
    q: (f) => `max by (host) (${f('process_resident_memory_bytes', 'agent_id!=""')})`
      + ` or max by (host) (${f('otelcol_process_memory_rss', 'agent="observaone"')})`,
  },
  {
    id: 'agent_cpu', group: 'agent', label: 'Agent CPU', unit: 'percent', worse: 'high', by: 'host',
    desc: 'CPU used by the ObservaOne Agent itself, as a share of one core.',
    q: (f) => `100 * max by (host) (rate(${f('process_cpu_seconds_total', 'agent_id!=""')}[5m]))`
      + ` or 100 * max by (host) (rate(${f('otelcol_process_cpu_seconds_total', 'agent="observaone"')}[5m]))`,
  },
];

export const byId = (id) => CATALOG.find((m) => m.id === id);

// Raw metric picked from "All metrics": counters as a per-second rate, everything else as is, one line per host.
export function rawQuery(name, type, f) {
  const counter = type === 'counter' || /_total$/.test(name);
  if (/_bucket$/.test(name)) return `histogram_quantile(0.95, sum by (host, le) (rate(${f(name)}[5m])))`;
  return counter ? `sum by (host) (rate(${f(name)}[5m]))` : `max by (host) (${f(name)})`;
}

// Unit guessed from a metric name (Prometheus naming rules).
export function unitFor(name, type) {
  const rate = type === 'counter' || /_total$/.test(name);
  if (/_bytes(_total)?$/.test(name)) return rate ? 'Bps' : 'bytes';
  if (/_seconds(_total)?$/.test(name)) return rate ? 'none' : 's';
  if (/_ratio$/.test(name)) return 'none';
  return 'none';
}

// Metrics of the monitoring system itself: hidden from "All metrics" unless asked for.
export const INTERNAL = /^(prometheus_|go_|promhttp_|net_conntrack_|scrape_|process_|otelcol_|grafana_|alertmanager_|loki_|tempo_|cortex_|up$|target_info|ALERTS)/;
