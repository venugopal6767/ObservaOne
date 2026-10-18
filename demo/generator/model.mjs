// ObservaOne DEMO DATA model: a made-up company (servers, Kubernetes clusters, services, databases,
// VMware, network devices). Everything here is deterministic: the same time always gives the same value,
// so the history written at start-up and the live scrapes line up exactly.
// TEST DATA ONLY. Remove the whole demo/ folder to get rid of it (see demo/README.md).

export const MIN = 60, HOUR = 3600, DAY = 86400;
export const STEP = 60; // counters are integrated on a 60 s grid

// ---------------- deterministic noise ----------------
export function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function rnd(seed, i) {
  let x = (seed ^ Math.imul(i | 0, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
/** smooth value noise in [-1, 1] */
function sn(seed, t, period) {
  const x = t / period, k = Math.floor(x), f = x - k, s = f * f * (3 - 2 * f);
  const a = rnd(seed, k), b = rnd(seed, k + 1);
  return 2 * (a + (b - a) * s) - 1;
}
/** layered noise in about [-1, 1] */
export function noise(seed, t) {
  return 0.55 * sn(seed, t, 1800) + 0.3 * sn(seed + 7, t, 300) + 0.15 * sn(seed + 13, t, 90);
}
/** 0..1, highest in the Indian afternoon, lower at weekends */
export function daily(t) {
  const local = t + 19800; // IST
  const x = (local % DAY) / DAY;
  const d = 0.5 + 0.5 * Math.cos(2 * Math.PI * (x - 14 / 24));
  const dow = (Math.floor(local / DAY) + 4) % 7; // 1970-01-01 was a Thursday
  return dow === 0 || dow === 6 ? d * 0.55 : d;
}
/** 0..1 during a repeating incident window (smooth edges), 0 otherwise */
export function burst(seed, t, period, dur) {
  const ph = (t + rnd(seed, 1) * period) % period;
  if (ph > dur) return 0;
  const edge = Math.min(ph, dur - ph) / Math.min(240, dur / 3);
  return Math.min(1, edge);
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// ---------------- the made-up estate ----------------
const GB = 1024 ** 3;
const lin = (host, env, role, o) => ({ host, os: 'linux', job: 'linux', env, role, cores: 4, memGB: 16, ...o });
const win = (host, env, role, o) => ({ host, os: 'windows', job: 'windows', env, role, cores: 4, memGB: 16, ...o });

export const HOSTS = [
  lin('prod-app-01', 'prod', 'app', { cores: 8, memGB: 32, cpu: 0.8, mem: 0.66, disks: [['/', 100, 0.55, 0.002], ['/var', 200, 0.63, 0.006], ['/data', 500, 0.44, 0.004]], procs: ['java', 'nginx', 'node_exporter', 'filebeat', 'sshd'] }),
  lin('prod-app-02', 'prod', 'app', { cores: 8, memGB: 32, cpu: 0.46, mem: 0.58, burst: [3 * HOUR, 40 * MIN, 0.35], disks: [['/', 100, 0.49, 0.002], ['/var', 200, 0.58, 0.005]], procs: ['java', 'nginx', 'node_exporter', 'filebeat', 'sshd'] }),
  lin('prod-web-01', 'prod', 'web', { cpu: 0.34, mem: 0.47, disks: [['/', 80, 0.42, 0.001], ['/var', 120, 0.51, 0.004]], procs: ['nginx', 'node', 'node_exporter', 'filebeat', 'sshd'] }),
  lin('prod-db-01', 'prod', 'database', { cores: 8, memGB: 64, cpu: 0.55, mem: 0.81, burst: [6 * HOUR, 45 * MIN, 0.3], disks: [['/', 100, 0.47, 0.001], ['/var/lib/postgresql', 1000, 0.78, 0.012], ['/backup', 2000, 0.69, 0.02]], procs: ['postgres', 'pgbouncer', 'node_exporter', 'postgres_exporter', 'sshd'] }),
  lin('uat-app-01', 'uat', 'app', { cpu: 0.31, mem: 0.55, disks: [['/', 100, 0.61, 0.002], ['/data', 250, 0.37, 0.003]], procs: ['java', 'nginx', 'node_exporter', 'mysqld', 'sshd'] }),
  lin('uat-web-01', 'uat', 'web', { cpu: 0.22, mem: 0.41, disks: [['/', 80, 0.39, 0.001]], procs: ['nginx', 'node', 'node_exporter', 'sshd', 'cron'] }),
  lin('dev-app-01', 'dev', 'app', { cpu: 0.18, mem: 0.52, disks: [['/', 100, 0.71, 0.003]], procs: ['java', 'docker', 'node_exporter', 'sshd', 'cron'] }),
  lin('dev-app-02', 'dev', 'app', { cpu: 0.2, mem: 0.45, disks: [['/', 100, 0.66, 0.002]], procs: ['java', 'docker', 'node_exporter', 'sshd', 'cron'], downFor: 50 * MIN }),
  // Kubernetes nodes (also scraped by node_exporter, so they are servers too)
  lin('k8s-node-01', 'prod', 'k8s-node', { cluster: 'prod-cluster', cpu: 0.52, mem: 0.71, disks: [['/', 120, 0.58, 0.003], ['/var/lib/containerd', 200, 0.66, 0.008]], procs: ['kubelet', 'containerd', 'node_exporter', 'kube-proxy', 'sshd'] }),
  lin('k8s-node-02', 'prod', 'k8s-node', { cluster: 'prod-cluster', cpu: 0.58, mem: 0.91, disks: [['/', 120, 0.61, 0.003], ['/var/lib/containerd', 200, 0.72, 0.009]], procs: ['kubelet', 'containerd', 'node_exporter', 'kube-proxy', 'sshd'] }),
  lin('k8s-node-03', 'prod', 'k8s-node', { cluster: 'prod-cluster', cpu: 0.47, mem: 0.64, disks: [['/', 120, 0.55, 0.003], ['/var/lib/containerd', 200, 0.6, 0.008]], procs: ['kubelet', 'containerd', 'node_exporter', 'kube-proxy', 'sshd'] }),
  lin('k8s-node-04', 'prod', 'k8s-node', { cluster: 'prod-cluster', cpu: 0.43, mem: 0.69, burst: [4 * HOUR, 30 * MIN, 0.4], disks: [['/', 120, 0.52, 0.003], ['/var/lib/containerd', 200, 0.57, 0.008]], procs: ['kubelet', 'containerd', 'node_exporter', 'kube-proxy', 'sshd'] }),
  lin('uat-node-01', 'uat', 'k8s-node', { cluster: 'uat-cluster', cpu: 0.33, mem: 0.62, disks: [['/', 120, 0.48, 0.002]], procs: ['kubelet', 'containerd', 'node_exporter', 'kube-proxy', 'sshd'] }),
  lin('uat-node-02', 'uat', 'k8s-node', { cluster: 'uat-cluster', cpu: 0.29, mem: 0.58, disks: [['/', 120, 0.45, 0.002]], procs: ['kubelet', 'containerd', 'node_exporter', 'kube-proxy', 'sshd'] }),
  lin('dev-node-01', 'dev', 'k8s-node', { cluster: 'dev-cluster', cpu: 0.27, mem: 0.6, disks: [['/', 100, 0.74, 0.004]], procs: ['kubelet', 'containerd', 'node_exporter', 'kube-proxy', 'sshd'] }),
  lin('dev-node-02', 'dev', 'k8s-node', { cluster: 'dev-cluster', cpu: 0.12, mem: 0.38, disks: [['/', 100, 0.93, 0.004]], procs: ['kubelet', 'containerd', 'node_exporter', 'kube-proxy', 'sshd'] }),
  win('win-srv-01', 'prod', 'ad', { cpu: 0.38, mem: 0.72, disks: [['C:', 120, 0.86, 0.004], ['D:', 500, 0.52, 0.004]], procs: ['lsass', 'dns', 'svchost', 'MsMpEng', 'windows_exporter'] }),
  win('win-srv-02', 'prod', 'iis', { cpu: 0.49, mem: 0.63, burst: [5 * HOUR, 35 * MIN, 0.35], disks: [['C:', 120, 0.64, 0.003], ['D:', 300, 0.41, 0.005]], procs: ['w3wp', 'sqlservr', 'svchost', 'MsMpEng', 'windows_exporter'] }),
  win('win-app-01', 'uat', 'app', { cpu: 0.26, mem: 0.55, disks: [['C:', 120, 0.58, 0.002]], procs: ['java', 'svchost', 'MsMpEng', 'w3wp', 'windows_exporter'] }),
];
for (const h of HOSTS) h.seed = hash(h.host);

const PROC_SHARE = { java: 0.42, postgres: 0.5, w3wp: 0.38, sqlservr: 0.3, nginx: 0.12, node: 0.15, kubelet: 0.1, containerd: 0.08, mysqld: 0.2, docker: 0.1, pgbouncer: 0.04, lsass: 0.06, dns: 0.05, svchost: 0.12, MsMpEng: 0.06, filebeat: 0.03, 'kube-proxy': 0.02, node_exporter: 0.01, postgres_exporter: 0.01, windows_exporter: 0.01, sshd: 0.005, cron: 0.003 };
const PROC_MEM = { java: 4.5 * GB, postgres: 12 * GB, w3wp: 1.8 * GB, sqlservr: 6 * GB, nginx: 0.25 * GB, node: 0.6 * GB, kubelet: 0.18 * GB, containerd: 0.12 * GB, mysqld: 2.2 * GB, docker: 0.2 * GB, pgbouncer: 0.03 * GB, lsass: 0.12 * GB, dns: 0.15 * GB, svchost: 0.4 * GB, MsMpEng: 0.35 * GB, filebeat: 0.09 * GB, 'kube-proxy': 0.05 * GB, node_exporter: 0.03 * GB, postgres_exporter: 0.02 * GB, windows_exporter: 0.04 * GB, sshd: 0.01 * GB, cron: 0.005 * GB };

export const PROC = { share: PROC_SHARE, mem: PROC_MEM };

/** CPU busy fraction (0..1) of a host, one core or the average */
export function hostBusy(h, t, core = -1) {
  let b = h.cpu * (0.82 + 0.3 * daily(t)) + 0.07 * noise(h.seed, t);
  if (h.burst) b += h.burst[2] * burst(h.seed, t, h.burst[0], h.burst[1]);
  if (core >= 0) b += 0.06 * noise(h.seed + 31 * (core + 1), t);
  return clamp(b, 0.02, 0.985);
}
export function hostMem(h, t) {
  return clamp(h.mem + 0.03 * noise(h.seed + 5, t) + 0.02 * daily(t), 0.05, 0.985);
}
/** fraction of a disk used: grows slowly every day (good for "time until full" later) */
export function diskUsed(h, d, t, ref) {
  const [, , used, growth] = d;
  return clamp(used + growth * ((t - ref) / DAY) + 0.004 * noise(h.seed + hash(d[0]), t), 0.01, 0.985);
}
export const traffic = (seed, t) => (0.35 + 0.65 * daily(t)) * (1 + 0.25 * noise(seed, t));

// ---------------- Kubernetes ----------------
const W = (ns, kind, name, replicas, cpu, memGB, o = {}) => ({ ns, kind, name, replicas, cpu, mem: memGB * GB, ...o });
export const CLUSTERS = [
  {
    cluster: 'prod-cluster', env: 'prod', version: 'v1.31.2', nodes: ['k8s-node-01', 'k8s-node-02', 'k8s-node-03', 'k8s-node-04'],
    workloads: [
      W('mule', 'Deployment', 'mule-runtime', 3, 0.45, 1.6), W('mule', 'Deployment', 'mule-gateway', 2, 0.25, 0.9),
      W('observability', 'Deployment', 'grafana', 1, 0.05, 0.25), W('observability', 'StatefulSet', 'prometheus', 1, 0.35, 2.4),
      W('observability', 'StatefulSet', 'loki', 1, 0.2, 1.1), W('observability', 'DaemonSet', 'otel-collector', 4, 0.06, 0.18),
      W('payments', 'Deployment', 'payments-api', 3, 0.3, 1.2), W('payments', 'Deployment', 'payments-worker', 2, 0.12, 0.5, { crash: 1 }),
      W('shop', 'Deployment', 'checkout', 3, 0.22, 0.6), W('shop', 'Deployment', 'inventory', 2, 0.18, 0.7),
      W('shop', 'Deployment', 'orders', 2, 0.16, 0.9), W('shop', 'Deployment', 'search', 1, 0.28, 1.4), W('shop', 'Deployment', 'cart', 2, 0.08, 0.3),
      W('ingress-nginx', 'Deployment', 'ingress-nginx-controller', 2, 0.15, 0.3),
      W('kube-system', 'Deployment', 'coredns', 2, 0.02, 0.07), W('kube-system', 'DaemonSet', 'kube-proxy', 4, 0.01, 0.05),
      W('default', 'Deployment', 'notification', 1, 0.04, 0.2),
    ],
    pvcs: [['observability', 'prometheus-data', 100, 0.64], ['observability', 'loki-data', 200, 0.47], ['shop', 'search-index', 50, 0.81], ['payments', 'ledger-archive', 20, 0.33]],
  },
  {
    cluster: 'uat-cluster', env: 'uat', version: 'v1.31.2', nodes: ['uat-node-01', 'uat-node-02'],
    workloads: [
      W('mule', 'Deployment', 'mule-runtime', 1, 0.2, 1.2), W('mule', 'Deployment', 'mule-gateway', 1, 0.1, 0.6),
      W('shop', 'Deployment', 'checkout', 1, 0.08, 0.4), W('shop', 'Deployment', 'inventory', 1, 0.06, 0.4), W('shop', 'Deployment', 'orders', 1, 0.05, 0.5),
      W('payments', 'Deployment', 'payments-api', 1, 0.1, 0.8), W('observability', 'DaemonSet', 'otel-collector', 2, 0.04, 0.15),
      W('kube-system', 'Deployment', 'coredns', 1, 0.02, 0.06), W('kube-system', 'DaemonSet', 'kube-proxy', 2, 0.01, 0.04),
    ],
    pvcs: [['shop', 'search-index', 20, 0.42]],
  },
  {
    cluster: 'dev-cluster', env: 'dev', version: 'v1.30.5', nodes: ['dev-node-01', 'dev-node-02'], notReady: ['dev-node-02'],
    workloads: [
      W('shop', 'Deployment', 'checkout', 1, 0.05, 0.3), W('shop', 'StatefulSet', 'search-indexer', 1, 0.2, 1, { phase: 'Pending' }),
      W('shop', 'Job', 'batch-report', 1, 0.1, 0.5, { phase: 'Failed' }), W('payments', 'Deployment', 'payments-api', 1, 0.08, 0.6),
      W('kube-system', 'Deployment', 'coredns', 1, 0.02, 0.06), W('kube-system', 'DaemonSet', 'kube-proxy', 2, 0.01, 0.04),
    ],
    pvcs: [['shop', 'indexer-data', 30, 0.9]],
  },
];
const sfx = (s, n) => Array.from({ length: n }, (_, i) => 'bcdfghjklmnpqrstvwxz2456789'[hash(`${s}${i}`) % 27]).join('');
for (const c of CLUSTERS) {
  c.pods = [];
  const ready = c.nodes.filter((n) => !(c.notReady || []).includes(n));
  let k = 0;
  for (const w of c.workloads) {
    const rs = sfx(`${c.cluster}${w.name}`, 10);
    for (let i = 0; i < w.replicas; i++) {
      const pod = w.kind === 'StatefulSet' ? `${w.name}-${i}` : w.kind === 'DaemonSet' ? `${w.name}-${sfx(`${c.cluster}${w.name}${i}`, 5)}` : w.kind === 'Job' ? `${w.name}-${sfx(`${c.cluster}${w.name}`, 5)}` : `${w.name}-${rs}-${sfx(`${c.cluster}${w.name}${i}`, 5)}`;
      const node = w.kind === 'DaemonSet' ? c.nodes[i % c.nodes.length] : w.phase === 'Pending' ? '' : ready[k++ % ready.length];
      c.pods.push({ pod, node, w, i, rs, phase: w.phase || 'Running', crash: w.crash && i === 0, seed: hash(`${c.cluster}/${pod}`) });
    }
  }
}

// ---------------- applications (OpenTelemetry HTTP server metrics) ----------------
const S = (name, ns, rps, p50, err, o = {}) => ({ name, ns, rps, p50, err, cluster: 'prod-cluster', env: 'prod', ...o, seed: hash(name) });
export const SERVICES = [
  S('checkout', 'shop', 120, 0.09, 0.003, { route: '/api/checkout', method: 'POST' }),
  S('payments-api', 'payments', 65, 0.14, 0.024, { route: '/api/payments/charge', method: 'POST', jvm: true }),
  S('inventory', 'shop', 40, 0.06, 0.005, { route: '/api/inventory/reserve', method: 'POST', jvm: true, errBurst: [2 * HOUR, 20 * MIN, 0.14], slowBurst: [2 * HOUR, 20 * MIN, 0.5] }),
  S('auth', 'shop', 220, 0.025, 0.001, { route: '/api/auth/validate', method: 'GET' }),
  S('orders', 'shop', 30, 0.11, 0.004, { route: '/api/orders', method: 'POST', jvm: true }),
  S('search', 'shop', 55, 0.18, 0.006, { route: '/api/search', method: 'GET', slowBurst: [3 * HOUR, 30 * MIN, 0.45] }),
  S('notification', 'default', 12, 0.04, 0.002, { route: '/api/notify', method: 'POST' }),
  S('mule-gateway', 'mule', 85, 0.07, 0.004, { route: '/api/v1/accounts', method: 'GET', jvm: true }),
  S('mule-runtime', 'mule', 85, 0.16, 0.007, { route: '/flows/account-sync', method: 'POST', jvm: true }),
];
export const svcRate = (s, t) => s.rps * (0.3 + 0.7 * daily(t)) * (1 + 0.15 * noise(s.seed, t));
export const svcErr = (s, t) => clamp(s.err * (1 + 0.4 * noise(s.seed + 3, t)) + (s.errBurst ? s.errBurst[2] * burst(s.seed + 9, t, s.errBurst[0], s.errBurst[1]) : 0), 0, 0.9);
export const svcSlow = (s, t) => clamp(0.012 + 0.008 * noise(s.seed + 4, t) + (s.slowBurst ? s.slowBurst[2] * burst(s.seed + 9, t, s.slowBurst[0], s.slowBurst[1]) : 0), 0, 0.95);
export const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];
const SIGMA = 0.55;
function erf(x) {
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
}
export const lognCdf = (x, median) => 0.5 * (1 + erf(Math.log(x / median) / (SIGMA * Math.SQRT2)));
export const lognMean = (median) => median * Math.exp((SIGMA * SIGMA) / 2);

// ---------------- databases, VMware, network devices ----------------
export const DATABASES = [
  { kind: 'postgres', host: 'prod-db-01', env: 'prod', instance: 'prod-db-01:9187', dbs: ['payments', 'orders', 'inventory', 'keycloak'], max: 300, base: 120 },
  { kind: 'mysql', host: 'uat-app-01', env: 'uat', instance: 'uat-app-01:9104', dbs: ['shop_uat'], max: 151, base: 38 },
];
export const ESXI = [
  { host: 'esxi-host-01', cluster: 'dc1-compute', mem: 0.82, cpu: 0.55, vms: ['prod-app-01', 'prod-app-02', 'prod-web-01', 'win-srv-01'] },
  { host: 'esxi-host-02', cluster: 'dc1-compute', mem: 0.64, cpu: 0.48, vms: ['prod-db-01', 'win-srv-02', 'uat-app-01', 'uat-web-01'] },
  { host: 'esxi-host-03', cluster: 'dc1-dev', mem: 0.51, cpu: 0.31, vms: ['dev-app-01', 'dev-app-02', 'win-app-01', 'jenkins-01'] },
];
export const DATASTORES = [['ds-prod-ssd-01', 4096, 0.71], ['ds-prod-ssd-02', 4096, 0.58], ['ds-dev-hdd-01', 8192, 0.88]];
export const NETDEV = [
  { device: 'core-sw-01', kind: 'switch', ifs: ['Gi1/0/1', 'Gi1/0/2', 'Gi1/0/3', 'Gi1/0/4', 'Te1/1/1', 'Te1/1/2'], down: ['Gi1/0/4'] },
  { device: 'edge-rtr-01', kind: 'router', ifs: ['Gi0/0/0', 'Gi0/0/1', 'Gi0/0/2'] },
  { device: 'fw-01', kind: 'firewall', ifs: ['ethernet1/1', 'ethernet1/2', 'ethernet1/3'] },
];
