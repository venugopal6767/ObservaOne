// Metric catalogue: friendly metrics people pick instead of writing PromQL.
// Each entry builds its PromQL from the global filters (env, platform, cluster, service, host),
// a "one line per" label and an optional "combine" function. Linux (node_exporter), Windows
// (windows_exporter), Kubernetes (cAdvisor + kube-state-metrics) and application (OpenTelemetry
// HTTP) metric names are covered; a query only returns what your Prometheus actually has.
import type { Unit } from './format';

export type Platform = 'linux' | 'windows' | 'kubernetes';
export interface Filters { env?: string; platform?: Platform | ''; cluster?: string; namespace?: string; service?: string; host?: string }
export type Combine = 'avg' | 'max' | 'min' | 'sum';

export type Category = 'system' | 'kubernetes' | 'applications' | 'network' | 'windows' | 'linux';
export const CATEGORIES: { id: Category; name: string; hint: string }[] = [
  { id: 'system', name: 'System metrics', hint: 'CPU, memory, disk and load for servers and VMs' },
  { id: 'kubernetes', name: 'Kubernetes', hint: 'Pods, nodes, namespaces, restarts' },
  { id: 'applications', name: 'Applications', hint: 'Requests, errors and latency per service' },
  { id: 'network', name: 'Network', hint: 'Traffic in and out, errors' },
  { id: 'linux', name: 'Linux', hint: 'node_exporter metrics' },
  { id: 'windows', name: 'Windows', hint: 'windows_exporter metrics' },
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

export const METRICS: MetricDef[] = [
  {
    id: 'cpu', name: 'CPU usage', category: 'system', also: ['linux', 'windows'], unit: 'percent', by: 'host', byOptions: ['host', 'env', 'role'],
    description: 'How busy the processors are, as a percentage of all cores.', normal: 'Under 70% most of the time. Sustained above 90% slows everything on the server.',
    warn: 80, crit: 90, keywords: ['cpu', 'processor', 'busy', 'utilization', 'utilisation', 'load'],
    raw: ['node_cpu_seconds_total', 'windows_cpu_time_total'],
    expr: (m, by, fn) => either(m,
      `clamp(${fn} by (${by}) (100 - avg by (instance, ${by}) (rate(node_cpu_seconds_total{mode="idle"${m.host}}[5m])) * 100), 0, 100)`,
      `clamp(${fn} by (${by}) (100 - avg by (instance, ${by}) (rate(windows_cpu_time_total{mode="idle"${m.host}}[5m])) * 100), 0, 100)`),
  },
  {
    id: 'memory', name: 'Memory usage', category: 'system', also: ['linux', 'windows'], unit: 'percent', by: 'host', byOptions: ['host', 'env', 'role'],
    description: 'Memory in use, as a percentage of the total.', normal: 'Up to 85% is usual for servers that cache files. Above 95% risks swapping or out-of-memory kills.',
    warn: 85, crit: 95, keywords: ['memory', 'ram', 'mem'],
    raw: ['node_memory_MemAvailable_bytes', 'windows_memory_available_bytes'],
    expr: (m, by, fn) => either(m,
      `${fn} by (${by}) (100 * (1 - node_memory_MemAvailable_bytes${sel(m.host)} / node_memory_MemTotal_bytes${sel(m.host)}))`,
      `${fn} by (${by}) (100 * (1 - windows_memory_available_bytes${sel(m.host)} / windows_memory_physical_total_bytes${sel(m.host)}))`),
  },
  {
    id: 'disk', name: 'Disk usage', category: 'system', also: ['linux', 'windows'], unit: 'percent', by: 'host', byOptions: ['host', 'env'],
    description: 'Space used on the fullest disk or volume of each server.', normal: 'Below 80%. Above 90% needs action before it fills up.',
    warn: 80, crit: 90, keywords: ['disk', 'storage', 'space', 'volume', 'filesystem'],
    raw: ['node_filesystem_avail_bytes', 'windows_logical_disk_free_bytes'],
    expr: (m, by, fn) => either(m,
      `${fn} by (${by}) (100 - 100 * node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs|ramfs|nsfs|fuse.*"${m.host}} / node_filesystem_size_bytes{fstype!~"tmpfs|overlay|squashfs|ramfs|nsfs|fuse.*"${m.host}})`,
      `${fn} by (${by}) (100 - 100 * windows_logical_disk_free_bytes{volume!~"HarddiskVolume.*"${m.host}} / windows_logical_disk_size_bytes{volume!~"HarddiskVolume.*"${m.host}})`),
  },
  {
    id: 'network', name: 'Network traffic', category: 'network', also: ['system'], unit: 'Bps', by: 'host', byOptions: ['host', 'env'],
    description: 'Bytes received plus sent per second, all network cards.', normal: 'Depends on the server; watch for sudden jumps or drops to zero.',
    keywords: ['network', 'traffic', 'bandwidth', 'throughput', 'mbps', 'io'],
    raw: ['node_network_receive_bytes_total', 'windows_net_bytes_total'],
    expr: (m, by, fn) => either(m,
      `${fn} by (${by}) (sum by (instance, ${by}) (rate(node_network_receive_bytes_total{device!~"lo|veth.*|docker.*|br-.*"${m.host}}[5m]) + rate(node_network_transmit_bytes_total{device!~"lo|veth.*|docker.*|br-.*"${m.host}}[5m])))`,
      `${fn} by (${by}) (sum by (instance, ${by}) (rate(windows_net_bytes_total${sel(m.host)}[5m])))`),
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
    description: 'CPU used by each process (needs the process collector).', normal: 'One process using most of the CPU for a long time is worth a look.',
    keywords: ['process', 'processes', 'top processes', 'java', 'nginx'],
    raw: ['namedprocess_namegroup_cpu_seconds_total', 'windows_process_cpu_time_total'],
    expr: (m, by, fn) => either(m,
      `${fn} by (${by === 'process' ? 'groupname' : by}) (rate(namedprocess_namegroup_cpu_seconds_total${sel(m.host)}[5m]) * 100)`,
      `${fn} by (${by}) (rate(windows_process_cpu_time_total${sel(m.host)}[5m]) * 100)`),
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
];
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
export interface Template { id: string; title: string; text: string; metric: string; by?: string; fn?: Combine; topk?: number; filters?: Filters; op?: '>' | '<'; value?: number; categories: Category[] }
export const TEMPLATES: Template[] = [
  { id: 't-cpu', title: 'CPU usage', text: 'View CPU usage and top CPU hosts', metric: 'cpu', categories: ['system', 'linux', 'windows'] },
  { id: 't-mem', title: 'Memory usage', text: 'Track memory utilization and available memory', metric: 'memory', categories: ['system', 'linux', 'windows'] },
  { id: 't-disk', title: 'Disk usage', text: 'Monitor disk space on every server', metric: 'disk', fn: 'max', categories: ['system', 'linux', 'windows'] },
  { id: 't-net', title: 'Network usage', text: 'Monitor network traffic in and out', metric: 'network', categories: ['system', 'network'] },
  { id: 't-neterr', title: 'Network errors', text: 'Packets with errors per server', metric: 'net_errors', categories: ['network'] },
  { id: 't-proc', title: 'Processes', text: 'Top processes by CPU', metric: 'processes_cpu', topk: 10, fn: 'sum', categories: ['system', 'linux', 'windows'] },
  { id: 't-load', title: 'System load', text: '1-minute load average (Linux)', metric: 'load', categories: ['linux', 'system'] },
  { id: 't-podcpu', title: 'Namespace CPU', text: 'CPU cores used per namespace', metric: 'pod_cpu', categories: ['kubernetes'] },
  { id: 't-podmem', title: 'Namespace memory', text: 'Working-set memory per namespace', metric: 'pod_memory', categories: ['kubernetes'] },
  { id: 't-restart', title: 'Restarting pods', text: 'Pods that restarted in the last hour', metric: 'pod_restarts', categories: ['kubernetes'] },
  { id: 't-pods', title: 'Running pods', text: 'Running pods per namespace', metric: 'pods_running', categories: ['kubernetes'] },
  { id: 't-rps', title: 'Requests per second', text: 'Traffic per service', metric: 'rps', categories: ['applications'] },
  { id: 't-err', title: 'Error rate', text: 'Failed requests (5xx) per service', metric: 'errors', categories: ['applications'] },
  { id: 't-lat', title: 'Latency (P95)', text: 'Slowest services', metric: 'latency', categories: ['applications'] },
];
