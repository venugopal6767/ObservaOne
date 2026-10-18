// Turns the demo model into Prometheus samples, using the real exporter metric names
// (node_exporter, windows_exporter, kube-state-metrics, cAdvisor, OpenTelemetry, postgres/mysql
// exporters, vmware_exporter, snmp_exporter), so every PromQL query in ObservaOne works unchanged.
import {
  STEP, DAY, MIN, HOSTS, CLUSTERS, SERVICES, DATABASES, ESXI, DATASTORES, NETDEV, BUCKETS,
  PROC, hash, noise, daily, burst, hostBusy, hostMem, diskUsed, traffic, svcRate, svcErr, svcSlow, lognCdf, lognMean,
} from './model.mjs';

const GB = 1024 ** 3;

/** time settings shared by the seeder and the live exporter */
export const clock = { t0: 0, ref: 0 };

// ---- counters: integrals of a rate on a fixed grid, cached so live scrapes stay cheap ----
const integrals = new Map();
function integ(key, rate) {
  let s = integrals.get(key);
  if (!s) integrals.set(key, (s = { rate, k: 0, sum: 0 }));
  return (t) => {
    const x = (t - clock.t0) / STEP;
    if (x <= 0) return 0;
    const kt = Math.floor(x);
    if (kt < s.k) { s.k = 0; s.sum = 0; }
    while (s.k < kt) { s.sum += s.rate(clock.t0 + s.k * STEP) * STEP; s.k++; }
    return s.sum + s.rate(clock.t0 + kt * STEP) * (t - (clock.t0 + kt * STEP));
  };
}

// ---- targets (what Prometheus scrapes; also returned by the /sd endpoint) ----
export function targets() {
  const out = [];
  for (const h of HOSTS) {
    out.push({
      id: `host/${h.host}`, h,
      labels: { job: h.job, instance: `${h.host}:${h.os === 'windows' ? 9182 : 9100}`, host: h.host, os: h.os, env: h.env, role: h.role, ...(h.cluster ? { cluster: h.cluster } : {}) },
    });
  }
  for (const c of CLUSTERS) {
    out.push({ id: `ksm/${c.cluster}`, c, labels: { job: 'kube-state-metrics', instance: `kube-state-metrics.${c.cluster}:8080`, cluster: c.cluster, env: c.env } });
    out.push({ id: `cadvisor/${c.cluster}`, c, labels: { job: 'kubelet', instance: `cadvisor.${c.cluster}:10250`, cluster: c.cluster, env: c.env } });
  }
  out.push({ id: 'apps', labels: { job: 'otel-collector', instance: 'otel-collector:8889' } });
  for (const d of DATABASES) out.push({ id: `db/${d.kind}`, d, labels: { job: d.kind, instance: d.instance, host: d.host, env: d.env } });
  out.push({ id: 'vmware', labels: { job: 'vmware', instance: 'vcenter-01:9272' } });
  for (const n of NETDEV) out.push({ id: `snmp/${n.device}`, n, labels: { job: 'snmp', instance: n.device, device: n.device, device_type: n.kind } });
  return out;
}

export function isDown(target, t) {
  return !!(target.h?.downFor && t >= clock.ref - target.h.downFor);
}

/** the samples one target exposes at time t: [name, labels, value][] */
export function collect(target, t) {
  const kind = target.id.split('/')[0];
  if (kind === 'host') return target.h.os === 'windows' ? windows(target.h, t) : linux(target.h, t);
  if (kind === 'ksm') return ksm(target.c, t);
  if (kind === 'cadvisor') return cadvisor(target.c, t);
  if (kind === 'apps') return apps(t);
  if (kind === 'db') return db(target.d, t);
  if (kind === 'vmware') return vmware(t);
  if (kind === 'snmp') return snmp(target.n, t);
  return [];
}

// ---------------- servers ----------------
function linux(h, t) {
  const S = [];
  const add = (n, l, v) => S.push([n, l, v]);
  const memTotal = h.memGB * GB;
  let busyAll = 0;
  for (let c = 0; c < h.cores; c++) {
    const busy = integ(`${h.host}/cpu${c}`, (x) => hostBusy(h, x, c))(t);
    busyAll += busy;
    const elapsed = t - clock.t0;
    add('node_cpu_seconds_total', { cpu: String(c), mode: 'idle' }, elapsed - busy);
    add('node_cpu_seconds_total', { cpu: String(c), mode: 'user' }, busy * 0.7);
    add('node_cpu_seconds_total', { cpu: String(c), mode: 'system' }, busy * 0.25);
    add('node_cpu_seconds_total', { cpu: String(c), mode: 'iowait' }, busy * 0.05);
  }
  const used = hostMem(h, t);
  const cached = memTotal * 0.12 * (1 - used + 0.3);
  add('node_memory_MemTotal_bytes', {}, memTotal);
  add('node_memory_MemAvailable_bytes', {}, memTotal * (1 - used));
  add('node_memory_MemFree_bytes', {}, Math.max(0, memTotal * (1 - used) - cached * 0.6));
  add('node_memory_Cached_bytes', {}, cached);
  add('node_memory_Buffers_bytes', {}, memTotal * 0.02);
  add('node_memory_SwapTotal_bytes', {}, 4 * GB);
  add('node_memory_SwapFree_bytes', {}, 4 * GB * (used > 0.85 ? 0.7 : 0.97));
  for (const d of h.disks) {
    const size = d[1] * GB, u = diskUsed(h, d, t, clock.ref);
    const dev = d[0] === '/' ? '/dev/sda1' : `/dev/sd${String.fromCharCode(98 + h.disks.indexOf(d))}1`;
    const lb = { mountpoint: d[0], device: dev, fstype: 'ext4' };
    add('node_filesystem_size_bytes', lb, size);
    add('node_filesystem_avail_bytes', lb, size * (1 - u));
    add('node_filesystem_free_bytes', lb, size * (1 - u) + size * 0.03);
  }
  const net = h.role === 'database' ? 3.2e7 : h.role === 'web' ? 1.8e7 : h.role === 'k8s-node' ? 2.4e7 : 9e6;
  add('node_network_receive_bytes_total', { device: 'eth0' }, integ(`${h.host}/rx`, (x) => net * traffic(h.seed + 1, x))(t));
  add('node_network_transmit_bytes_total', { device: 'eth0' }, integ(`${h.host}/tx`, (x) => net * 0.7 * traffic(h.seed + 2, x))(t));
  add('node_network_receive_packets_total', { device: 'eth0' }, integ(`${h.host}/rxp`, (x) => (net / 900) * traffic(h.seed + 1, x))(t));
  add('node_network_transmit_packets_total', { device: 'eth0' }, integ(`${h.host}/txp`, (x) => (net / 1100) * traffic(h.seed + 2, x))(t));
  add('node_network_receive_errs_total', { device: 'eth0' }, integ(`${h.host}/rxe`, (x) => (h.host === 'prod-web-01' ? 0.4 : 0.01) * (1 + noise(h.seed + 3, x)))(t));
  add('node_network_transmit_errs_total', { device: 'eth0' }, integ(`${h.host}/txe`, () => 0.002)(t));
  const io = h.role === 'database' ? 2.5e7 : 4e6;
  add('node_disk_read_bytes_total', { device: 'sda' }, integ(`${h.host}/dr`, (x) => io * traffic(h.seed + 4, x))(t));
  add('node_disk_written_bytes_total', { device: 'sda' }, integ(`${h.host}/dw`, (x) => io * 0.6 * traffic(h.seed + 5, x))(t));
  add('node_disk_reads_completed_total', { device: 'sda' }, integ(`${h.host}/drc`, (x) => (io / 16384) * traffic(h.seed + 4, x))(t));
  add('node_disk_writes_completed_total', { device: 'sda' }, integ(`${h.host}/dwc`, (x) => (io / 32768) * traffic(h.seed + 5, x))(t));
  add('node_disk_io_time_seconds_total', { device: 'sda' }, integ(`${h.host}/dio`, (x) => Math.min(0.95, 0.1 + 0.5 * hostBusy(h, x)))(t));
  const avgBusy = hostBusy(h, t);
  add('node_load1', {}, h.cores * avgBusy * (1 + 0.1 * noise(h.seed + 6, t)));
  add('node_load5', {}, h.cores * avgBusy);
  add('node_load15', {}, h.cores * hostBusy(h, t - 600));
  add('node_boot_time_seconds', {}, clock.t0 - (3 + (h.seed % 40)) * DAY);
  add('node_time_seconds', {}, t);
  add('node_uname_info', { nodename: h.host, release: '6.8.0-45-generic', sysname: 'Linux', machine: 'x86_64' }, 1);
  add('node_os_info', { name: h.role === 'k8s-node' ? 'Ubuntu' : 'Red Hat Enterprise Linux', version_id: h.role === 'k8s-node' ? '24.04' : '9.4', pretty_name: h.role === 'k8s-node' ? 'Ubuntu 24.04.1 LTS' : 'Red Hat Enterprise Linux 9.4 (Plow)' }, 1);
  for (const p of h.procs) {
    const share = shareOf(p, h);
    add('namedprocess_namegroup_cpu_seconds_total', { groupname: p, mode: 'user' }, busyAll * share * 0.8);
    add('namedprocess_namegroup_cpu_seconds_total', { groupname: p, mode: 'system' }, busyAll * share * 0.2);
    add('namedprocess_namegroup_memory_bytes', { groupname: p, memtype: 'resident' }, procMem(p, h, t));
    add('namedprocess_namegroup_num_procs', { groupname: p }, p === 'postgres' ? 42 : p === 'nginx' ? 9 : p === 'java' ? 1 : 2);
  }
  for (const u of unitsOf(h)) {
    const failed = u === 'filebeat.service' && h.host === 'prod-app-02';
    add('node_systemd_unit_state', { name: u, state: 'active', type: 'service' }, failed ? 0 : 1);
    add('node_systemd_unit_state', { name: u, state: 'failed', type: 'service' }, failed ? 1 : 0);
  }
  return S;
}

function windows(h, t) {
  const S = [];
  const add = (n, l, v) => S.push([n, l, v]);
  let busyAll = 0;
  for (let c = 0; c < h.cores; c++) {
    const busy = integ(`${h.host}/cpu${c}`, (x) => hostBusy(h, x, c))(t);
    busyAll += busy;
    const core = `0,${c}`;
    add('windows_cpu_time_total', { core, mode: 'idle' }, t - clock.t0 - busy);
    add('windows_cpu_time_total', { core, mode: 'user' }, busy * 0.62);
    add('windows_cpu_time_total', { core, mode: 'privileged' }, busy * 0.33);
    add('windows_cpu_time_total', { core, mode: 'interrupt' }, busy * 0.03);
    add('windows_cpu_time_total', { core, mode: 'dpc' }, busy * 0.02);
  }
  const total = h.memGB * GB, used = hostMem(h, t);
  add('windows_memory_physical_total_bytes', {}, total);
  add('windows_memory_available_bytes', {}, total * (1 - used));
  add('windows_memory_physical_free_bytes', {}, total * (1 - used) * 0.6);
  add('windows_memory_commit_limit', {}, total * 1.5);
  for (const d of h.disks) {
    const size = d[1] * GB, u = diskUsed(h, d, t, clock.ref), lb = { volume: d[0] };
    add('windows_logical_disk_size_bytes', lb, size);
    add('windows_logical_disk_free_bytes', lb, size * (1 - u));
    add('windows_logical_disk_read_bytes_total', lb, integ(`${h.host}/${d[0]}r`, (x) => 3e6 * traffic(h.seed + 4, x))(t));
    add('windows_logical_disk_write_bytes_total', lb, integ(`${h.host}/${d[0]}w`, (x) => 2e6 * traffic(h.seed + 5, x))(t));
    add('windows_logical_disk_reads_total', lb, integ(`${h.host}/${d[0]}rc`, (x) => 180 * traffic(h.seed + 4, x))(t));
    add('windows_logical_disk_writes_total', lb, integ(`${h.host}/${d[0]}wc`, (x) => 90 * traffic(h.seed + 5, x))(t));
    add('windows_logical_disk_read_seconds_total', lb, integ(`${h.host}/${d[0]}rs`, (x) => 0.04 * traffic(h.seed + 4, x))(t));
  }
  const nic = { nic: 'Intel_R_ Ethernet Connection' }, net = h.role === 'iis' ? 2.2e7 : 8e6;
  const rx = integ(`${h.host}/rx`, (x) => net * traffic(h.seed + 1, x))(t), tx = integ(`${h.host}/tx`, (x) => net * 0.8 * traffic(h.seed + 2, x))(t);
  add('windows_net_bytes_received_total', nic, rx);
  add('windows_net_bytes_sent_total', nic, tx);
  add('windows_net_bytes_total', nic, rx + tx);
  add('windows_net_packets_received_errors_total', nic, integ(`${h.host}/rxe`, () => 0.01)(t));
  add('windows_net_packets_outbound_errors_total', nic, integ(`${h.host}/txe`, () => 0.003)(t));
  const boot = clock.t0 - (3 + (h.seed % 40)) * DAY;
  add('windows_system_boot_time_timestamp', {}, boot);
  add('windows_system_system_up_time', {}, boot);
  add('windows_os_info', { product: h.role === 'app' ? 'Windows Server 2019 Standard' : 'Windows Server 2022 Datacenter', version: '10.0.20348' }, 1);
  for (const p of h.procs) {
    const share = shareOf(p, h);
    add('windows_process_cpu_time_total', { process: p, mode: 'user' }, busyAll * share * 0.75);
    add('windows_process_cpu_time_total', { process: p, mode: 'privileged' }, busyAll * share * 0.25);
    add('windows_process_working_set_private_bytes', { process: p }, procMem(p, h, t));
  }
  for (const s of h.role === 'ad' ? ['NTDS', 'DNS', 'Netlogon', 'W32Time', 'WinRM'] : h.role === 'iis' ? ['W3SVC', 'MSSQLSERVER', 'WAS', 'WinRM', 'Spooler'] : ['W3SVC', 'WinRM', 'Tomcat9', 'Spooler', 'BITS']) {
    const stopped = s === 'Spooler';
    add('windows_service_state', { name: s.toLowerCase(), state: 'running' }, stopped ? 0 : 1);
    add('windows_service_state', { name: s.toLowerCase(), state: 'stopped' }, stopped ? 1 : 0);
  }
  return S;
}

const shareOf = (p, h) => {
  const raw = h.procs.reduce((a, x) => a + (PROC.share[x] || 0.02), 0);
  return ((PROC.share[p] || 0.02) / raw) * 0.9;
};
const procMem = (p, h, t) => (PROC.mem[p] || 0.1 * GB) * (h.memGB / 32 + 0.5) * (1 + 0.05 * noise(h.seed + hash(p), t));
const unitsOf = (h) => [...h.procs.filter((p) => !p.includes('exporter')).map((p) => `${p}.service`), 'node_exporter.service', 'chronyd.service'];

// ---------------- Kubernetes ----------------
const POD_CPU = 3.5; // workload CPU in the model is per "unit"; this makes the cluster about as busy as its nodes
function ksm(c, t) {
  const S = [];
  const add = (n, l, v) => S.push([n, l, v]);
  for (const n of c.nodes) {
    const ready = !(c.notReady || []).includes(n);
    add('kube_node_info', { node: n, kubelet_version: c.version, container_runtime_version: 'containerd://1.7.22', os_image: 'Ubuntu 24.04.1 LTS', internal_ip: `10.${hash(c.cluster) % 200}.0.${c.nodes.indexOf(n) + 11}` }, 1);
    for (const st of ['true', 'false', 'unknown']) add('kube_node_status_condition', { node: n, condition: 'Ready', status: st }, (st === 'true') === ready && st !== 'unknown' ? 1 : st === 'unknown' ? 0 : 0);
    add('kube_node_spec_unschedulable', { node: n }, 0);
    for (const kind of ['allocatable', 'capacity']) {
      add(`kube_node_status_${kind}`, { node: n, resource: 'cpu', unit: 'core' }, kind === 'capacity' ? 4 : 3.92);
      add(`kube_node_status_${kind}`, { node: n, resource: 'memory', unit: 'byte' }, (kind === 'capacity' ? 16 : 15.2) * GB);
      add(`kube_node_status_${kind}`, { node: n, resource: 'pods', unit: 'integer' }, 110);
    }
  }
  for (const ns of [...new Set(c.workloads.map((w) => w.ns))]) add('kube_namespace_status_phase', { namespace: ns, phase: 'Active' }, 1);
  for (const p of c.pods) {
    const { w } = p, base = { namespace: w.ns, pod: p.pod };
    const owner = w.kind === 'Deployment' ? `${w.name}-${p.rs}` : w.name; // a Deployment's pods belong to its ReplicaSet
    add('kube_pod_info', { ...base, node: p.node, created_by_kind: w.kind === 'Deployment' ? 'ReplicaSet' : w.kind, created_by_name: owner, host_ip: '', pod_ip: `10.244.${hash(p.pod) % 250}.${hash(p.pod + 'x') % 250}`, uid: `uid-${p.seed}` }, 1);
    add('kube_pod_owner', { ...base, owner_kind: w.kind === 'Deployment' ? 'ReplicaSet' : w.kind, owner_name: owner }, 1);
    for (const ph of ['Pending', 'Running', 'Succeeded', 'Failed', 'Unknown']) add('kube_pod_status_phase', { ...base, phase: ph }, ph === p.phase ? 1 : 0);
    add('kube_pod_status_ready', { ...base, condition: 'true' }, p.phase === 'Running' && !(p.crash && Math.floor((t - clock.t0) / 300) % 6 === 0) ? 1 : 0);
    const restarts = p.crash ? Math.floor((t - clock.t0) / (25 * MIN)) : w.name === 'search' ? Math.floor((t - clock.t0) / (2 * DAY)) : 0;
    add('kube_pod_container_status_restarts_total', { ...base, container: w.name }, restarts);
    if (p.crash) add('kube_pod_container_status_waiting_reason', { ...base, container: w.name, reason: 'CrashLoopBackOff' }, Math.floor((t - clock.t0) / 300) % 6 === 0 ? 1 : 0);
    add('kube_pod_container_resource_requests', { ...base, container: w.name, node: p.node, resource: 'cpu', unit: 'core' }, Math.max(0.05, Math.round(w.cpu * POD_CPU * 1.2 * 20) / 20));
    add('kube_pod_container_resource_requests', { ...base, container: w.name, node: p.node, resource: 'memory', unit: 'byte' }, w.mem * 1.1);
    add('kube_pod_container_resource_limits', { ...base, container: w.name, node: p.node, resource: 'memory', unit: 'byte' }, w.mem * 1.6);
  }
  const groups = new Map();
  for (const p of c.pods) { const k = `${p.w.ns}/${p.w.name}`; if (!groups.has(k)) groups.set(k, { w: p.w, pods: [] }); groups.get(k).pods.push(p); }
  for (const { w, pods } of groups.values()) {
    const ok = pods.filter((p) => p.phase === 'Running' && !p.crash).length;
    if (w.kind === 'Deployment') {
      add('kube_deployment_spec_replicas', { namespace: w.ns, deployment: w.name }, w.replicas);
      add('kube_deployment_status_replicas_available', { namespace: w.ns, deployment: w.name }, ok);
      add('kube_deployment_status_replicas_updated', { namespace: w.ns, deployment: w.name }, w.replicas);
    } else if (w.kind === 'StatefulSet') {
      add('kube_statefulset_replicas', { namespace: w.ns, statefulset: w.name }, w.replicas);
      add('kube_statefulset_status_replicas_ready', { namespace: w.ns, statefulset: w.name }, ok);
    } else if (w.kind === 'DaemonSet') {
      add('kube_daemonset_status_desired_number_scheduled', { namespace: w.ns, daemonset: w.name }, w.replicas);
      add('kube_daemonset_status_number_ready', { namespace: w.ns, daemonset: w.name }, pods.filter((p) => !(c.notReady || []).includes(p.node)).length);
    } else if (w.kind === 'Job') {
      add('kube_job_status_failed', { namespace: w.ns, job_name: w.name }, 1);
      add('kube_job_status_succeeded', { namespace: w.ns, job_name: w.name }, 0);
    }
    if (w.kind !== 'Job' && w.kind !== 'DaemonSet') {
      const type = w.name.includes('ingress') ? 'LoadBalancer' : 'ClusterIP';
      add('kube_service_info', { namespace: w.ns, service: w.name, cluster_ip: `10.96.${hash(w.name) % 250}.${hash(w.name + c.cluster) % 250}` }, 1);
      add('kube_service_spec_type', { namespace: w.ns, service: w.name, type }, 1);
    }
  }
  for (const [ns, name, sizeGB, used] of c.pvcs) {
    const lb = { namespace: ns, persistentvolumeclaim: name };
    add('kube_persistentvolumeclaim_info', { ...lb, storageclass: c.env === 'prod' ? 'managed-premium' : 'standard', volumename: `pvc-${hash(name + c.cluster).toString(16)}` }, 1);
    add('kube_persistentvolumeclaim_status_phase', { ...lb, phase: 'Bound' }, 1);
    add('kube_persistentvolumeclaim_resource_requests_storage_bytes', lb, sizeGB * GB);
    add('kubelet_volume_stats_capacity_bytes', lb, sizeGB * GB);
    add('kubelet_volume_stats_used_bytes', lb, sizeGB * GB * Math.min(0.99, used + 0.002 * ((t - clock.ref) / DAY)));
  }
  return S;
}

function cadvisor(c, t) {
  const S = [];
  for (const p of c.pods) {
    if (p.phase !== 'Running') continue;
    const { w } = p, lb = { namespace: w.ns, pod: p.pod, container: w.name, node: p.node, image: `registry.local/${w.name}:1.${hash(w.name) % 20}` };
    const load = (x) => w.cpu * POD_CPU * (0.45 + 0.75 * daily(x)) * (1 + 0.25 * noise(p.seed, x)) * (w.name === 'search' ? 1 + 1.5 * burst(hash('search') + 9, x, 3 * 3600, 1800) : 1);
    S.push(['container_cpu_usage_seconds_total', lb, integ(`${c.cluster}/${p.pod}/cpu`, load)(t)]);
    S.push(['container_memory_working_set_bytes', lb, w.mem * (0.78 + 0.1 * noise(p.seed + 1, t) + (p.crash ? 0.25 * (((t - clock.t0) % 1500) / 1500) : 0))]);
    S.push(['container_network_receive_bytes_total', { namespace: w.ns, pod: p.pod, node: p.node, interface: 'eth0' }, integ(`${c.cluster}/${p.pod}/rx`, (x) => 2e5 * w.cpu * 10 * traffic(p.seed, x))(t)]);
    S.push(['container_network_transmit_bytes_total', { namespace: w.ns, pod: p.pod, node: p.node, interface: 'eth0' }, integ(`${c.cluster}/${p.pod}/tx`, (x) => 1.5e5 * w.cpu * 10 * traffic(p.seed + 1, x))(t)]);
  }
  return S;
}

// ---------------- applications ----------------
function apps(t) {
  const S = [];
  for (const s of SERVICES) {
    const R = integ(`svc/${s.name}/R`, (x) => svcRate(s, x))(t);
    const E = integ(`svc/${s.name}/E`, (x) => svcRate(s, x) * svcErr(s, x))(t);
    const SL = integ(`svc/${s.name}/S`, (x) => svcRate(s, x) * svcSlow(s, x))(t);
    const SE = integ(`svc/${s.name}/SE`, (x) => svcRate(s, x) * svcErr(s, x) * svcSlow(s, x))(t);
    const codes = [
      ['200', R - E - 0.015 * R, SL - SE - 0.015 * SL],
      ['404', 0.015 * R, 0.015 * SL],
      ['500', E, SE],
    ];
    const slowMedian = s.p50 * 5;
    for (const [code, count, slow] of codes) {
      const fast = count - slow;
      const lb = { service_name: s.name, http_route: s.route, http_request_method: s.method, http_response_status_code: code, env: s.env, namespace: s.ns, cluster: s.cluster };
      for (const le of BUCKETS) S.push(['http_server_request_duration_seconds_bucket', { ...lb, le: String(le) }, fast * lognCdf(le, s.p50) + slow * lognCdf(le, slowMedian)]);
      S.push(['http_server_request_duration_seconds_bucket', { ...lb, le: '+Inf' }, count]);
      S.push(['http_server_request_duration_seconds_count', lb, count]);
      S.push(['http_server_request_duration_seconds_sum', lb, fast * lognMean(s.p50) + slow * lognMean(slowMedian)]);
    }
    if (s.jvm) {
      const heapMax = (s.name.startsWith('mule') ? 2 : 1) * GB;
      const saw = ((t - clock.t0) % 420) / 420; // allocate, then garbage collect
      const lb = { service_name: s.name, env: s.env, namespace: s.ns };
      S.push(['jvm_memory_used_bytes', { ...lb, jvm_memory_type: 'heap' }, heapMax * (0.35 + 0.35 * saw + 0.05 * noise(s.seed + 8, t) + (s.name === 'payments-api' ? 0.18 : 0))]);
      S.push(['jvm_memory_limit_bytes', { ...lb, jvm_memory_type: 'heap' }, heapMax]);
      S.push(['jvm_memory_used_bytes', { ...lb, jvm_memory_type: 'non_heap' }, 180e6 + 10e6 * noise(s.seed + 9, t)]);
      S.push(['jvm_thread_count', lb, 60 + Math.round(30 * daily(t))]);
      S.push(['jvm_gc_duration_seconds_count', lb, integ(`svc/${s.name}/gc`, (x) => 0.25 * (0.4 + daily(x)))(t)]);
      S.push(['jvm_gc_duration_seconds_sum', lb, integ(`svc/${s.name}/gcs`, (x) => 0.004 * (0.4 + daily(x)))(t)]);
    }
  }
  return S;
}

// ---------------- databases, VMware, network devices ----------------
function db(d, t) {
  const S = [];
  const tr = (x) => 0.35 + 0.65 * daily(x);
  if (d.kind === 'postgres') {
    S.push(['pg_up', {}, 1]);
    S.push(['pg_settings_max_connections', {}, d.max]);
    d.dbs.forEach((name, i) => {
      const lb = { datname: name };
      S.push(['pg_stat_database_numbackends', lb, Math.round((d.base / d.dbs.length) * tr(t) * (1 + 0.2 * noise(hash(name), t)) + (i === 0 ? 40 * burst(hash(name), t, 6 * 3600, 2700) : 0))]);
      S.push(['pg_stat_database_xact_commit', lb, integ(`db/${name}/c`, (x) => 300 / (i + 1) * tr(x))(t)]);
      S.push(['pg_stat_database_xact_rollback', lb, integ(`db/${name}/r`, (x) => 2 / (i + 1) * tr(x))(t)]);
      S.push(['pg_stat_database_deadlocks', lb, integ(`db/${name}/d`, () => 0.0002)(t)]);
      S.push(['pg_database_size_bytes', lb, (40 - i * 8) * GB * (1 + 0.01 * ((t - clock.ref) / DAY))]);
    });
    S.push(['pg_replication_lag_seconds', {}, Math.max(0, 0.4 + 0.3 * noise(7, t) + 6 * burst(hash('lag'), t, 6 * 3600, 900))]);
  } else {
    S.push(['mysql_up', {}, 1]);
    S.push(['mysql_global_variables_max_connections', {}, d.max]);
    S.push(['mysql_global_status_threads_connected', {}, Math.round(d.base * tr(t) * (1 + 0.2 * noise(11, t)))]);
    S.push(['mysql_global_status_threads_running', {}, Math.max(1, Math.round(6 * tr(t)))]);
    S.push(['mysql_global_status_queries', {}, integ('db/mysql/q', (x) => 140 * tr(x))(t)]);
    S.push(['mysql_global_status_slow_queries', {}, integ('db/mysql/s', (x) => 0.05 * tr(x))(t)]);
  }
  return S;
}

function vmware(t) {
  const S = [];
  for (const e of ESXI) {
    const lb = { host_name: e.host, cluster_name: e.cluster, dc_name: 'dc1' }, seed = hash(e.host);
    S.push(['vmware_host_power_state', lb, 1]);
    S.push(['vmware_host_cpu_max', lb, 64000]);
    S.push(['vmware_host_cpu_usage', lb, 64000 * Math.min(0.97, e.cpu * (0.8 + 0.3 * daily(t)) + 0.05 * noise(seed, t))]);
    S.push(['vmware_host_memory_max', lb, 524288]);
    S.push(['vmware_host_memory_usage', lb, 524288 * Math.min(0.98, e.mem + 0.02 * noise(seed + 1, t))]);
    S.push(['vmware_host_num_cpu', lb, 32]);
    for (const vm of e.vms) {
      const vl = { vm_name: vm, host_name: e.host, cluster_name: e.cluster, dc_name: 'dc1' }, vs = hash(vm);
      const off = vm === 'jenkins-01';
      S.push(['vmware_vm_power_state', vl, off ? 0 : 1]);
      S.push(['vmware_vm_num_cpu', vl, 4]);
      S.push(['vmware_vm_cpu_usage_average', vl, off ? 0 : 1800 * (0.6 + 0.6 * daily(t)) * (1 + 0.2 * noise(vs, t))]);
      S.push(['vmware_vm_mem_usage_average', vl, off ? 0 : 100 * Math.min(0.97, 0.45 + 0.25 * daily(t) + 0.05 * noise(vs + 1, t))]);
    }
  }
  for (const [ds, sizeGB, used] of DATASTORES) {
    const lb = { ds_name: ds, dc_name: 'dc1' };
    S.push(['vmware_datastore_capacity_size', lb, sizeGB * GB]);
    S.push(['vmware_datastore_freespace_size', lb, sizeGB * GB * (1 - Math.min(0.99, used + 0.003 * ((t - clock.ref) / DAY)))]);
  }
  return S;
}

function snmp(n, t) {
  const S = [];
  const seed = hash(n.device);
  S.push(['sysUpTime', {}, ((t - clock.t0) + (seed % 90) * DAY) * 100]);
  n.ifs.forEach((ifName, i) => {
    const down = (n.down || []).includes(ifName);
    const speed = ifName.startsWith('Te') ? 1e10 : 1e9;
    const lb = { ifName, ifDescr: ifName, ifIndex: String(i + 1), ifAlias: i === 0 ? 'uplink' : `port-${i + 1}` };
    S.push(['ifOperStatus', lb, down ? 2 : 1]);
    S.push(['ifAdminStatus', lb, 1]);
    S.push(['ifHighSpeed', lb, speed / 1e6]);
    S.push(['ifHCInOctets', lb, down ? 1e9 : integ(`snmp/${n.device}/${ifName}/in`, (x) => (speed / 8) * 0.12 * traffic(seed + i, x))(t)]);
    S.push(['ifHCOutOctets', lb, down ? 1e9 : integ(`snmp/${n.device}/${ifName}/out`, (x) => (speed / 8) * 0.09 * traffic(seed + i + 50, x))(t)]);
    S.push(['ifInErrors', lb, integ(`snmp/${n.device}/${ifName}/err`, () => (i === 1 && n.kind === 'router' ? 0.3 : 0.001))(t)]);
  });
  return S;
}
