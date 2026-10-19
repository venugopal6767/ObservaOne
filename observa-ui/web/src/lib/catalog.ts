// Metric catalogue: friendly metrics people pick instead of writing PromQL.
// Each entry builds its PromQL from the global filters (env, platform, cluster, service, host),
// a "one line per" label and an optional "combine" function. Linux (node_exporter), Windows
// (windows_exporter), Kubernetes (cAdvisor + kube-state-metrics) and application (OpenTelemetry
// HTTP) metric names are covered; a query only returns what your Prometheus actually has.
import type { Unit } from './format';

export type Platform = 'linux' | 'windows' | 'kubernetes';
export interface Filters { env?: string; platform?: Platform | ''; cluster?: string; namespace?: string; service?: string; host?: string }
export type Combine = 'avg' | 'max' | 'min' | 'sum';

export type Category = 'system' | 'kubernetes' | 'applications' | 'databases' | 'network' | 'cloud' | 'vmware' | 'windows' | 'linux' | 'custom';
export const CATEGORIES: { id: Category; name: string; hint: string }[] = [
  { id: 'system', name: 'System metrics', hint: 'CPU, memory, disk and load for servers and VMs' },
  { id: 'kubernetes', name: 'Kubernetes', hint: 'Pods, nodes, namespaces, restarts and volumes' },
  { id: 'applications', name: 'Applications', hint: 'Requests, errors, latency and JVM memory per service' },
  { id: 'databases', name: 'Databases', hint: 'PostgreSQL and MySQL connections, transactions and size' },
  { id: 'network', name: 'Network & Devices', hint: 'Server traffic, switch / router / firewall interfaces' },
  { id: 'cloud', name: 'Cloud', hint: 'AWS CloudWatch and Azure Monitor metrics' },
  { id: 'vmware', name: 'VMware', hint: 'ESXi hosts, virtual machines and datastores' },
  { id: 'windows', name: 'Windows', hint: 'windows_exporter metrics' },
  { id: 'linux', name: 'Linux', hint: 'node_exporter metrics' },
  { id: 'custom', name: 'Custom', hint: 'Anything else: write PromQL' },
];

export interface MetricDef {
  id: string;
  name: string;
  category: Category;
  also?: Category[];
  description: string;
  normal: string; // what "normal" looks like, shown on hover
  unit: Unit;
  /** the label each line is drawn for by default */
  by: string;
  /** labels this metric can be split by */
  byOptions: string[];
  /** threshold that means "look at this" (for colours and alert defaults) */
  warn?: number; crit?: number; lowerIsWorse?: boolean;
  keywords: string[];
  /** typical reasons to look at this metric, shown as common use cases */
  uses?: string[];
  /** PromQL for these filters, one line per `by`, combined with `fn` */
  expr: (m: Matchers, by: string, fn: Combine) => string;
  /** raw metric names used, for the info card */
  raw: string[];
}

/** label matchers for the different metric families, built from the filters */
export interface Matchers { host: string; k8s: string; app: string; platform: Platform | '' }

const q = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
export function matchers(f: Filters): Matchers {
  const host: string[] = [], k8s: string[] = [], app: string[] = [];
  if (f.env) { host.push(`env="${q(f.env)}"`); k8s.push(`env="${q(f.env)}"`); }
  if (f.host) host.push(`host="${q(f.host)}"`);
  if (f.cluster) { k8s.push(`cluster="${q(f.cluster)}"`); host.push(`cluster="${q(f.cluster)}"`); }
  if (f.namespace) k8s.push(`namespace="${q(f.namespace)}"`);
  if (f.service) app.push(`service_name="${q(f.service)}"`);
  const j = (xs: string[]) => (xs.length ? `, ${xs.join(', ')}` : '');
  return { host: j(host), k8s: j(k8s), app: j(app), platform: f.platform || '' };
}
/** `a or b`, leaving out the platform the filter excludes */
function either(m: Matchers, linux: string, windows: string): string {
  if (m.platform === 'linux') return linux;
  if (m.platform === 'windows') return windows;
  return `${linux} or ${windows}`;
}
const sel = (inner: string) => `{${inner.replace(/^, /, '')}}`;

// ---- one definition per server metric, shared by every screen (Overview, Explorer, host view, Investigation) ----
// The same rules as the server's own queries (src/queries.js, unit-tested in tests/queries.test.js):
//   - CPU = 1 - idle time / total time, both rates over the same window. "100 - rate(idle) * 100" assumes the counters
//     cover the whole 5-minute window and reads 20 to 80 points too high for 5 minutes after any gap (new host,
//     agent restart, outage, Prometheus restart); the ratio cancels that out. The ObservaOne Go agent sends its own
//     computed value (observaone_cpu_utilization_ratio), used as is.
//   - Pushed series get no stale marker when an agent stops: values must be from the last FRESH seconds, otherwise
//     the server has no value (a gap, never its last value repeated).
//   - Each server is reduced to ONE value first (labels host, env, role), and only then combined (avg / max / ...)
//     across servers, so Linux and Windows servers of the same environment are combined together.
export const FRESH = 120;
const PER_HOST = 'host, env, role';
const NOT_GO = 'agent_id=""'; // node_* series that are not from the Go agent (it sends its own computed CPU value)
const LNX_FS = 'fstype!~"tmpfs|overlay|squashfs|ramfs|nsfs|fuse.*"';
const WIN_VOL = 'volume!~"HarddiskVolume.*"';
const recent = (metric: string) => `last_over_time(${metric}[${FRESH}s])`;
const freshHosts = (metric: string) => `(max by (host) (timestamp(${metric})) > time() - ${FRESH})`;
const cpuRatio = (counter: string, idleSel: string, allSel: string) =>
  `(clamp(100 * (1 - sum by (${PER_HOST}) (rate(${counter}${idleSel}[5m])) / sum by (${PER_HOST}) (rate(${counter}${allSel}[5m]))), 0, 100)`
  + ` and on (host) ${freshHosts(`${counter}${idleSel}`)})`;
/** CPU used per server, % of all its cores */
export function cpuPerHost(m: Matchers): string {
  const linux = `clamp(max by (${PER_HOST}) (${recent(`observaone_cpu_utilization_ratio${sel(m.host)}`)}) * 100, 0, 100)`
    + ` or ${cpuRatio('node_cpu_seconds_total', sel(`mode="idle", ${NOT_GO}${m.host}`), sel(`${NOT_GO}${m.host}`))}`;
  const windows = cpuRatio('windows_cpu_time_total', sel(`mode="idle", core!=""${m.host}`), sel(`core!=""${m.host}`));
  return either(m, linux, windows);
}
/** memory in use per server, % of physical memory */
export function memPerHost(m: Matchers): string {
  return either(m,
    `100 * (1 - max by (${PER_HOST}) (${recent(`node_memory_MemAvailable_bytes${sel(m.host)}`)}) / max by (${PER_HOST}) (${recent(`node_memory_MemTotal_bytes${sel(m.host)}`)}))`,
    `100 * (1 - max by (${PER_HOST}) (${recent(`windows_memory_available_bytes${sel(m.host)}`)}) / max by (${PER_HOST}) (${recent(`windows_memory_physical_total_bytes${sel(m.host)}`)}))`);
}
/** space used on the FULLEST filesystem / volume of each server, % */
export function diskPerHost(m: Matchers): string {
  return either(m,
    `max by (${PER_HOST}) (100 - 100 * ${recent(`node_filesystem_avail_bytes${sel(`${LNX_FS}${m.host}`)}`)} / ${recent(`node_filesystem_size_bytes${sel(`${LNX_FS}${m.host}`)}`)})`,
    `max by (${PER_HOST}) (100 - 100 * ${recent(`windows_logical_disk_free_bytes${sel(`${WIN_VOL}${m.host}`)}`)} / ${recent(`windows_logical_disk_size_bytes${sel(`${WIN_VOL}${m.host}`)}`)})`);
}
/** bytes received + sent per second per server, physical interfaces only */
export function netPerHost(m: Matchers): string {
  const dev = 'device!~"lo|veth.*|docker.*|br-.*"';
  return either(m,
    `(sum by (${PER_HOST}) (rate(node_network_receive_bytes_total${sel(`${dev}${m.host}`)}[5m]) + rate(node_network_transmit_bytes_total${sel(`${dev}${m.host}`)}[5m]))`
    + ` and on (host) ${freshHosts(`node_network_receive_bytes_total${sel(`${dev}${m.host}`)}`)})`,
    `(sum by (${PER_HOST}) (rate(windows_net_bytes_total${sel(m.host)}[5m]))`
    + ` and on (host) ${freshHosts(`windows_net_bytes_total${sel(m.host)}`)})`);
}
/** process CPU as % of the whole server: cores used by the process / cores of the server x 100 */
export const procCpuShare = (counter: string, name: string, s: string, idleSel: string, cpuCounter: string) =>
  `100 * sum by (${name}, host) (rate(${counter}${s}[5m])) / on (host) group_left count by (host) (${cpuCounter}${idleSel})`;
/** combine per-server values: one line per `by` */
const perHost = (inner: string, by: string, fn: Combine) => `${fn} by (${by}) (${inner})`;

export const METRICS: MetricDef[] = [
  {
    id: 'cpu', name: 'CPU usage', category: 'system', also: ['linux', 'windows'], unit: 'percent', by: 'host', byOptions: ['host', 'env', 'role'],
    description: 'How busy the processors are, as a percentage of all cores (1 - idle time / total time).', normal: 'Under 70% most of the time. Sustained above 90% slows everything on the server.',
    warn: 80, crit: 90, keywords: ['cpu', 'processor', 'busy', 'utilization', 'utilisation', 'load'],
    raw: ['observaone_cpu_utilization_ratio', 'node_cpu_seconds_total', 'windows_cpu_time_total'],
    expr: (m, by, fn) => perHost(cpuPerHost(m), by, fn),
  },
  {
    id: 'memory', name: 'Memory usage', category: 'system', also: ['linux', 'windows'], unit: 'percent', by: 'host', byOptions: ['host', 'env', 'role'],
    description: 'Memory in use, as a percentage of the total.', normal: 'Up to 85% is usual for servers that cache files. Above 95% risks swapping or out-of-memory kills.',
    warn: 85, crit: 95, keywords: ['memory', 'ram', 'mem'],
    raw: ['node_memory_MemAvailable_bytes', 'windows_memory_available_bytes'],
    expr: (m, by, fn) => perHost(memPerHost(m), by, fn),
  },
  {
    id: 'disk', name: 'Disk usage', category: 'system', also: ['linux', 'windows'], unit: 'percent', by: 'host', byOptions: ['host', 'env'],
    description: 'Space used on the fullest disk or volume of each server.', normal: 'Below 80%. Above 90% needs action before it fills up.',
    warn: 80, crit: 90, keywords: ['disk', 'storage', 'space', 'volume', 'filesystem'],
    raw: ['node_filesystem_avail_bytes', 'windows_logical_disk_free_bytes'],
    expr: (m, by, fn) => perHost(diskPerHost(m), by, fn),
  },
  {
    id: 'network', name: 'Network traffic', category: 'network', also: ['system'], unit: 'Bps', by: 'host', byOptions: ['host', 'env'],
    description: 'Bytes received plus sent per second, all network cards.', normal: 'Depends on the server; watch for sudden jumps or drops to zero.',
    keywords: ['network', 'traffic', 'bandwidth', 'throughput', 'mbps', 'io'],
    raw: ['node_network_receive_bytes_total', 'windows_net_bytes_total'],
    expr: (m, by, fn) => perHost(netPerHost(m), by, fn),
  },
  {
    id: 'net_errors', name: 'Network errors', category: 'network', unit: 'short', by: 'host', byOptions: ['host'],
    description: 'Packets with errors per second (in + out).', normal: 'Zero. Anything steady above zero points at a cable, driver or switch problem.',
    keywords: ['network errors', 'packet errors', 'dropped'],
    raw: ['node_network_receive_errs_total', 'windows_net_packets_received_errors_total'],
    expr: (m, by, fn) => either(m,
      `${fn} by (${by}) (sum by (instance, ${by}) (rate(node_network_receive_errs_total${sel(m.host)}[5m]) + rate(node_network_transmit_errs_total${sel(m.host)}[5m])))`,
      `${fn} by (${by}) (sum by (instance, ${by}) (rate(windows_net_packets_received_errors_total${sel(m.host)}[5m])))`),
  },
  {
    id: 'load', name: 'System load (1 min)', category: 'linux', also: ['system'], unit: 'short', by: 'host', byOptions: ['host'],
    description: 'Average number of processes waiting for CPU over the last minute (Linux).', normal: 'Below the number of CPU cores.',
    keywords: ['load average', 'system load'],
    raw: ['node_load1'],
    expr: (m, by, fn) => `${fn} by (${by}) (node_load1${sel(m.host)})`,
  },
  {
    id: 'processes_cpu', name: 'Top processes by CPU', category: 'system', also: ['linux', 'windows'], unit: 'percent', by: 'process', byOptions: ['process', 'host'],
    description: 'CPU used by each process, as a share of the whole server like host CPU (100% = every core busy). Needs the process collector.', normal: 'One process using most of the CPU for a long time is worth a look.',
    keywords: ['process', 'processes', 'top processes', 'java', 'nginx'],
    raw: ['namedprocess_namegroup_cpu_seconds_total', 'windows_process_cpu_time_total'],
    expr: (m, by, fn) => either(m,
      `${fn} by (${by === 'process' ? 'groupname' : by}) (${procCpuShare('namedprocess_namegroup_cpu_seconds_total', 'groupname', sel(m.host), sel(`mode="idle"${m.host}`), 'node_cpu_seconds_total')})`,
      `${fn} by (${by}) (${procCpuShare('windows_process_cpu_time_total', 'process', sel(m.host), sel(`mode="idle", core!=""${m.host}`), 'windows_cpu_time_total')})`),
  },
  {
    id: 'pod_cpu', name: 'Pod CPU', category: 'kubernetes', unit: 'short', by: 'namespace', byOptions: ['namespace', 'pod', 'node', 'cluster'],
    description: 'CPU cores used by containers.', normal: 'Close to the pods\' CPU requests; far above means throttling risk.',
    keywords: ['pod cpu', 'container cpu', 'kubernetes cpu', 'namespace cpu', 'k8s cpu'],
    raw: ['container_cpu_usage_seconds_total'],
    expr: (m, by, fn) => `${fn === 'avg' ? 'sum' : fn} by (${by}) (rate(container_cpu_usage_seconds_total{container!="", container!="POD"${m.k8s}}[5m]))`,
  },
  {
    id: 'pod_memory', name: 'Pod memory', category: 'kubernetes', unit: 'bytes', by: 'namespace', byOptions: ['namespace', 'pod', 'node', 'cluster'],
    description: 'Working-set memory used by containers.', normal: 'Below the memory limit; at the limit the container is killed (OOMKilled).',
    keywords: ['pod memory', 'container memory', 'kubernetes memory', 'namespace memory', 'k8s memory'],
    raw: ['container_memory_working_set_bytes'],
    expr: (m, by, fn) => `${fn === 'avg' ? 'sum' : fn} by (${by}) (container_memory_working_set_bytes{container!="", container!="POD"${m.k8s}})`,
  },
  {
    id: 'pod_restarts', name: 'Pod restarts', category: 'kubernetes', unit: 'short', by: 'pod', byOptions: ['pod', 'namespace'],
    description: 'Container restarts in the last hour.', normal: 'Zero. Repeated restarts usually mean a crash loop or out-of-memory kills.',
    warn: 1, crit: 5, keywords: ['restart', 'restarts', 'crash', 'crashloop', 'restarting'],
    raw: ['kube_pod_container_status_restarts_total'],
    expr: (m, by) => `sum by (${by}) (increase(kube_pod_container_status_restarts_total${sel(m.k8s)}[1h])) > 0`,
  },
  {
    id: 'pods_running', name: 'Running pods', category: 'kubernetes', unit: 'short', by: 'namespace', byOptions: ['namespace', 'cluster', 'node'],
    description: 'Pods in the Running phase.', normal: 'Steady; a drop means pods are failing or being evicted.',
    keywords: ['pods', 'running pods', 'pod count'],
    raw: ['kube_pod_status_phase'],
    expr: (m, by) => `sum by (${by}) (kube_pod_status_phase{phase="Running"${m.k8s}})`,
  },
  {
    id: 'rps', name: 'Requests per second', category: 'applications', unit: 'reqps', by: 'service_name', byOptions: ['service_name'],
    description: 'Incoming HTTP requests per second, per service.', normal: 'Follows your business pattern; a sudden drop to zero is an outage.',
    keywords: ['requests', 'rps', 'throughput', 'traffic', 'calls', 'hits'],
    raw: ['http_server_request_duration_seconds_count'],
    expr: (m, by) => `sum by (${by}) (rate(http_server_request_duration_seconds_count${sel(m.app)}[5m]))`,
  },
  {
    id: 'errors', name: 'Error rate', category: 'applications', unit: 'percent', by: 'service_name', byOptions: ['service_name'],
    description: 'Share of requests answered with a 5xx server error.', normal: 'Below 1%. Above 5% users are noticing.',
    warn: 1, crit: 5, keywords: ['error', 'errors', 'error rate', 'failures', '5xx', 'failing'],
    raw: ['http_server_request_duration_seconds_count'],
    expr: (m, by) => `100 * sum by (${by}) (rate(http_server_request_duration_seconds_count{http_response_status_code=~"5.."${m.app}}[5m])) / sum by (${by}) (rate(http_server_request_duration_seconds_count${sel(m.app)}[5m]))`,
  },
  {
    id: 'latency', name: 'Latency (P95)', category: 'applications', unit: 'ms', by: 'service_name', byOptions: ['service_name'],
    description: '95% of requests are faster than this.', normal: 'Depends on the service; most APIs stay under 500 ms.',
    warn: 500, crit: 1000, keywords: ['latency', 'slow', 'slowest', 'response time', 'p95', 'duration'],
    raw: ['http_server_request_duration_seconds_bucket'],
    expr: (m, by) => `1000 * histogram_quantile(0.95, sum by (${by}, le) (rate(http_server_request_duration_seconds_bucket${sel(m.app)}[5m])))`,
  },
  {
    id: 'jvm_heap', name: 'JVM heap usage', category: 'applications', unit: 'percent', by: 'service_name', byOptions: ['service_name', 'namespace'],
    description: 'Java heap in use as a share of the maximum heap.', normal: 'A saw-tooth below 80%. Staying near 100% means long garbage collections and OutOfMemoryError risk.',
    warn: 80, crit: 90, keywords: ['jvm', 'heap', 'java memory', 'garbage collection', 'gc'],
    raw: ['jvm_memory_used_bytes', 'jvm_memory_limit_bytes'],
    expr: (m, by, fn) => `${fn} by (${by}) (100 * sum by (${by}, service_name) (jvm_memory_used_bytes{jvm_memory_type="heap"${m.app}}) / sum by (${by}, service_name) (jvm_memory_limit_bytes{jvm_memory_type="heap"${m.app}}))`,
  },
  {
    id: 'db_connections', name: 'Database connections', category: 'databases', unit: 'percent', by: 'host', byOptions: ['host', 'env'],
    description: 'Open connections as a share of the server maximum (PostgreSQL and MySQL).', normal: 'Below 70%. At 100% new connections are refused.',
    warn: 70, crit: 90, keywords: ['database connections', 'db connections', 'connections', 'connection pool', 'postgres', 'mysql'],
    raw: ['pg_stat_database_numbackends', 'mysql_global_status_threads_connected'],
    expr: (m, by, fn) => `${fn} by (${by}) (100 * sum by (instance, ${by}) (pg_stat_database_numbackends${sel(m.host)}) / max by (instance, ${by}) (pg_settings_max_connections${sel(m.host)}))`
      + ` or ${fn} by (${by}) (100 * max by (instance, ${by}) (mysql_global_status_threads_connected${sel(m.host)}) / max by (instance, ${by}) (mysql_global_variables_max_connections${sel(m.host)}))`,
  },
  {
    id: 'db_tps', name: 'Database transactions', category: 'databases', unit: 'reqps', by: 'host', byOptions: ['host', 'datname'],
    description: 'Committed + rolled back transactions (PostgreSQL) or queries (MySQL) per second.', normal: 'Follows your traffic; a drop to zero while traffic still comes in is an outage.',
    keywords: ['transactions', 'tps', 'queries per second', 'database load', 'qps'],
    raw: ['pg_stat_database_xact_commit', 'mysql_global_status_queries'],
    expr: (m, by) => `sum by (${by}) (rate(pg_stat_database_xact_commit${sel(m.host)}[5m]) + rate(pg_stat_database_xact_rollback${sel(m.host)}[5m]))`
      + (by === 'datname' ? '' : ` or sum by (${by}) (rate(mysql_global_status_queries${sel(m.host)}[5m]))`),
  },
  {
    id: 'db_size', name: 'Database size', category: 'databases', unit: 'bytes', by: 'datname', byOptions: ['datname', 'host'],
    description: 'Size of each PostgreSQL database on disk.', normal: 'Grows steadily; sudden jumps are bulk loads or bloat.',
    keywords: ['database size', 'db size', 'table size'],
    raw: ['pg_database_size_bytes'],
    expr: (m, by, fn) => `${fn === 'avg' ? 'sum' : fn} by (${by}) (pg_database_size_bytes${sel(m.host)})`,
  },
  {
    id: 'if_traffic', name: 'Interface traffic', category: 'network', unit: 'Bps', by: 'device', byOptions: ['device', 'ifName'],
    description: 'Bytes in + out per second on switch, router and firewall interfaces (SNMP).', normal: 'Below 70% of the link speed; a sudden zero on an uplink is an outage.',
    keywords: ['interface', 'switch', 'router', 'firewall', 'snmp', 'uplink', 'port traffic'],
    raw: ['ifHCInOctets', 'ifHCOutOctets'],
    expr: (_m, by, fn) => `${fn === 'avg' ? 'sum' : fn} by (${by}) (rate(ifHCInOctets[5m]) + rate(ifHCOutOctets[5m]))`,
  },
  {
    id: 'if_errors', name: 'Interface errors', category: 'network', unit: 'short', by: 'device', byOptions: ['device', 'ifName'],
    description: 'Input errors per second on network device interfaces (SNMP).', normal: 'Zero. Steady errors point at a bad cable, optic or duplex mismatch.',
    keywords: ['interface errors', 'crc errors', 'port errors'],
    raw: ['ifInErrors'],
    expr: (_m, by) => `sum by (${by}) (rate(ifInErrors[5m]))`,
  },
  {
    id: 'if_down', name: 'Interfaces down', category: 'network', unit: 'short', by: 'device', byOptions: ['device'],
    description: 'Interfaces that are enabled but not passing traffic (oper down, admin up).', normal: 'Zero on every device.',
    warn: 1, crit: 1, keywords: ['interface down', 'port down', 'link down'],
    raw: ['ifOperStatus', 'ifAdminStatus'],
    expr: (_m, by) => `count by (${by}) (ifOperStatus == 2 and ifAdminStatus == 1)`,
  },
  {
    id: 'esxi_cpu', name: 'ESXi host CPU', category: 'vmware', unit: 'percent', by: 'host_name', byOptions: ['host_name', 'cluster_name'],
    description: 'CPU used on each ESXi host, as a share of its capacity.', normal: 'Below 75% leaves room for HA failover.',
    warn: 75, crit: 90, keywords: ['esxi cpu', 'vmware cpu', 'hypervisor cpu', 'vsphere cpu'],
    raw: ['vmware_host_cpu_usage', 'vmware_host_cpu_max'],
    expr: (_m, by, fn) => `${fn} by (${by}) (100 * vmware_host_cpu_usage / vmware_host_cpu_max)`,
  },
  {
    id: 'esxi_mem', name: 'ESXi host memory', category: 'vmware', unit: 'percent', by: 'host_name', byOptions: ['host_name', 'cluster_name'],
    description: 'Memory used on each ESXi host.', normal: 'Below 80%; above that VMs start ballooning and swapping.',
    warn: 80, crit: 90, keywords: ['esxi memory', 'vmware memory', 'hypervisor memory', 'esxi'],
    raw: ['vmware_host_memory_usage', 'vmware_host_memory_max'],
    expr: (_m, by, fn) => `${fn} by (${by}) (100 * vmware_host_memory_usage / vmware_host_memory_max)`,
  },
  {
    id: 'vm_cpu', name: 'VM CPU (MHz)', category: 'vmware', unit: 'short', by: 'vm_name', byOptions: ['vm_name', 'host_name'],
    description: 'CPU used by each virtual machine, in MHz.', normal: 'Compare with the vCPUs: 1 vCPU is roughly 2,000-3,000 MHz.',
    keywords: ['vm cpu', 'virtual machine cpu', 'vm', 'virtual machines'],
    raw: ['vmware_vm_cpu_usage_average'],
    expr: (_m, by, fn) => `${fn === 'avg' ? 'sum' : fn} by (${by}) (vmware_vm_cpu_usage_average)`,
  },
  {
    id: 'datastore', name: 'Datastore usage', category: 'vmware', unit: 'percent', by: 'ds_name', byOptions: ['ds_name'],
    description: 'Space used on each VMware datastore.', normal: 'Below 80%. Full datastores stop VMs and snapshots.',
    warn: 80, crit: 90, keywords: ['datastore', 'vmware storage', 'vsan'],
    raw: ['vmware_datastore_freespace_size', 'vmware_datastore_capacity_size'],
    expr: (_m, by, fn) => `${fn} by (${by}) (100 - 100 * vmware_datastore_freespace_size / vmware_datastore_capacity_size)`,
  },
  {
    id: 'pvc_usage', name: 'Volume usage (PVC)', category: 'kubernetes', unit: 'percent', by: 'persistentvolumeclaim', byOptions: ['persistentvolumeclaim', 'namespace', 'cluster'],
    description: 'Space used on persistent volumes.', normal: 'Below 80%. A full volume stops databases and queues.',
    warn: 80, crit: 90, keywords: ['pvc', 'persistent volume', 'volume usage', 'pvcs'],
    raw: ['kubelet_volume_stats_used_bytes', 'kubelet_volume_stats_capacity_bytes'],
    expr: (m, by, fn) => `${fn} by (${by}) (100 * kubelet_volume_stats_used_bytes${sel(m.k8s)} / kubelet_volume_stats_capacity_bytes${sel(m.k8s)})`,
  },
];

/** common use cases shown when a metric is selected */
const USES: Record<string, string[]> = {
  cpu: ['Which servers are overloaded right now', 'Hosts with high CPU over a period', 'Capacity planning before a release', 'Compare CPU with yesterday or last week'],
  memory: ['Servers about to run out of memory', 'Memory leaks: usage that only goes up', 'Right-sizing VMs'],
  disk: ['Disks that will fill up soon', 'Log or backup folders growing too fast', 'Clean-up before a disk-full outage'],
  network: ['Unusual traffic spikes or drops', 'Backups or transfers saturating a link', 'Compare traffic between servers'],
  net_errors: ['Faulty cables, drivers or switch ports', 'Packet loss behind slow applications'],
  load: ['Processes waiting for CPU or disk', 'Overloaded Linux servers'],
  processes_cpu: ['Which process is using the CPU', 'Runaway Java or Node processes', 'Noisy neighbours on shared servers'],
  pod_cpu: ['Busiest namespaces or pods', 'Pods close to their CPU limits', 'Cluster capacity planning'],
  pod_memory: ['Pods at risk of OOMKill', 'Memory per namespace for chargeback'],
  pod_restarts: ['Crash-looping pods', 'Pods killed for running out of memory'],
  pods_running: ['Pods disappearing after a deployment', 'Evictions on busy nodes'],
  rps: ['Traffic per service', 'Sudden drops that mean an outage', 'Peak hours for capacity planning'],
  errors: ['Which service is failing', 'Errors after a deployment', 'SLO error budgets'],
  latency: ['Slowest services', 'Latency regressions after a release', 'Response-time SLOs'],
  jvm_heap: ['Memory leaks in Java and Mule services', 'Heap sizes that are too small', 'Long garbage-collection pauses'],
  db_connections: ['Connection pools running out', 'Applications leaking connections'],
  db_tps: ['Database load per server', 'Traffic drops at the database layer'],
  db_size: ['Databases growing fast', 'Disk planning for database servers'],
  if_traffic: ['Saturated uplinks', 'Traffic per switch or firewall'],
  if_errors: ['Bad cables or optics', 'Duplex mismatches'],
  if_down: ['Ports or links that went down'],
  esxi_cpu: ['Overloaded ESXi hosts', 'Room for HA failover'],
  esxi_mem: ['ESXi hosts that will start swapping', 'VM placement'],
  vm_cpu: ['Busiest virtual machines', 'VMs that need more vCPUs'],
  datastore: ['Datastores filling up', 'Snapshot growth'],
  pvc_usage: ['Persistent volumes about to fill', 'Database and queue storage on Kubernetes'],
};
for (const m of METRICS) m.uses = USES[m.id];
export const metricById = (id: string) => METRICS.find((x) => x.id === id);

/** PromQL for a builder state */
export function buildQuery(s: { metric: string; filters: Filters; by?: string; fn?: Combine; topk?: number; op?: '>' | '<'; value?: number }): string {
  const d = metricById(s.metric);
  if (!d) return '';
  let e = d.expr(matchers(s.filters), s.by || d.by, s.fn || 'avg');
  if (s.topk) e = `topk(${s.topk}, ${e.includes(' or ') ? `(${e})` : e})`;
  if (s.op && s.value !== undefined && Number.isFinite(s.value)) e = `${e.includes(' or ') && !s.topk ? `(${e})` : e} ${s.op} ${s.value}`;
  return e;
}

/** One-line plain-English description of a builder state */
export function describe(s: { metric: string; filters: Filters; by?: string; fn?: Combine; topk?: number; op?: '>' | '<'; value?: number }, rangeLabel: string): string {
  const d = metricById(s.metric);
  if (!d) return '';
  const fnWord = { avg: 'Average', max: 'Highest', min: 'Lowest', sum: 'Total' }[s.fn || 'avg'];
  const by = (s.by || d.by).replace('service_name', 'service');
  const where = [s.filters.env && `env ${s.filters.env}`, s.filters.platform && `${s.filters.platform} only`, s.filters.cluster && `cluster ${s.filters.cluster}`,
    s.filters.namespace && `namespace ${s.filters.namespace}`, s.filters.service && `service ${s.filters.service}`, s.filters.host && `host ${s.filters.host}`].filter(Boolean).join(', ');
  return [
    s.topk ? `Top ${s.topk} ${by}s by ${d.name.toLowerCase()}` : `${fnWord} ${d.name.toLowerCase()} per ${by}`,
    s.op ? `only where ${s.op === '>' ? 'above' : 'below'} ${s.value}${d.unit === 'percent' ? '%' : ''}` : '',
    where ? `· ${where}` : '',
    `· ${rangeLabel.toLowerCase()}`,
  ].filter(Boolean).join(' ').replace(/^./, (c) => c.toUpperCase());
}

/** Ready-made templates shown on the Templates tab */
export interface Template { id: string; title: string; text: string; metric: string; by?: string; fn?: Combine; topk?: number; filters?: Filters; op?: '>' | '<'; value?: number; categories: Category[]; tags: string[] }
export const TEMPLATES: Template[] = [
  { id: 't-cpu', title: 'CPU usage', text: 'View CPU usage and top CPU consuming hosts', metric: 'cpu', categories: ['system', 'linux', 'windows'], tags: ['System', 'Linux', 'Windows'] },
  { id: 't-mem', title: 'Memory usage', text: 'Track memory utilization and available memory', metric: 'memory', categories: ['system', 'linux', 'windows'], tags: ['System', 'Linux', 'Windows'] },
  { id: 't-disk', title: 'Disk usage', text: 'Monitor disk space and the fullest volumes', metric: 'disk', fn: 'max', categories: ['system', 'linux', 'windows'], tags: ['System', 'Linux', 'Windows'] },
  { id: 't-net', title: 'Network usage', text: 'Monitor network traffic in and out', metric: 'network', categories: ['system', 'network'], tags: ['System', 'Network'] },
  { id: 't-proc', title: 'Processes', text: 'Top processes by CPU', metric: 'processes_cpu', topk: 10, fn: 'sum', categories: ['system', 'linux', 'windows'], tags: ['System', 'Linux', 'Windows'] },
  { id: 't-load', title: 'System load', text: '1-minute load average', metric: 'load', categories: ['linux', 'system'], tags: ['System', 'Linux'] },
  { id: 't-neterr', title: 'Network errors', text: 'Packets with errors per server', metric: 'net_errors', categories: ['network'], tags: ['Network', 'Linux', 'Windows'] },
  { id: 't-podcpu', title: 'Kubernetes pod CPU', text: 'CPU cores used per namespace', metric: 'pod_cpu', categories: ['kubernetes'], tags: ['Kubernetes', 'Pod'] },
  { id: 't-podmem', title: 'Kubernetes pod memory', text: 'Working-set memory per namespace', metric: 'pod_memory', categories: ['kubernetes'], tags: ['Kubernetes', 'Pod'] },
  { id: 't-restart', title: 'Restarting pods', text: 'Pods that restarted in the last hour', metric: 'pod_restarts', categories: ['kubernetes'], tags: ['Kubernetes', 'Pod'] },
  { id: 't-pods', title: 'Running pods', text: 'Running pods per namespace', metric: 'pods_running', categories: ['kubernetes'], tags: ['Kubernetes', 'Namespace'] },
  { id: 't-pvc', title: 'Volume usage', text: 'Persistent volumes filling up', metric: 'pvc_usage', categories: ['kubernetes'], tags: ['Kubernetes', 'Storage'] },
  { id: 't-rps', title: 'Requests per second', text: 'Traffic per service', metric: 'rps', categories: ['applications'], tags: ['Application', 'HTTP'] },
  { id: 't-err', title: 'Error rate', text: 'Failed requests (5xx) per service', metric: 'errors', categories: ['applications'], tags: ['Application', 'HTTP'] },
  { id: 't-lat', title: 'Latency (P95)', text: 'Slowest services', metric: 'latency', categories: ['applications'], tags: ['Application', 'HTTP'] },
  { id: 't-jvm', title: 'JVM memory', text: 'Heap used per Java and Mule service', metric: 'jvm_heap', categories: ['applications'], tags: ['Application', 'Java'] },
  { id: 't-dbconn', title: 'Database connections', text: 'Connections used against the maximum', metric: 'db_connections', categories: ['databases'], tags: ['PostgreSQL', 'MySQL'] },
  { id: 't-dbtps', title: 'Database transactions', text: 'Transactions or queries per second', metric: 'db_tps', categories: ['databases'], tags: ['PostgreSQL', 'MySQL'] },
  { id: 't-dbsize', title: 'Database size', text: 'Size of each database', metric: 'db_size', categories: ['databases'], tags: ['PostgreSQL'] },
  { id: 't-if', title: 'Interface traffic', text: 'Traffic per switch, router and firewall', metric: 'if_traffic', categories: ['network'], tags: ['Network', 'SNMP'] },
  { id: 't-ifdown', title: 'Interfaces down', text: 'Enabled ports that are down', metric: 'if_down', categories: ['network'], tags: ['Network', 'SNMP'] },
  { id: 't-esxicpu', title: 'ESXi host CPU', text: 'CPU used per ESXi host', metric: 'esxi_cpu', categories: ['vmware'], tags: ['VMware', 'ESXi'] },
  { id: 't-esximem', title: 'ESXi host memory', text: 'Memory used per ESXi host', metric: 'esxi_mem', categories: ['vmware'], tags: ['VMware', 'ESXi'] },
  { id: 't-vm', title: 'Busiest VMs', text: 'Top virtual machines by CPU', metric: 'vm_cpu', topk: 10, categories: ['vmware'], tags: ['VMware', 'VM'] },
  { id: 't-ds', title: 'Datastore usage', text: 'Space used per datastore', metric: 'datastore', categories: ['vmware'], tags: ['VMware', 'Storage'] },
];
