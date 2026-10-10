// Sample data for the Kubernetes dashboard: clusters, nodes, namespaces, workloads, pods and events.
// Seeded by name, so a pod has the same numbers wherever you open it.
import { rng, hash, between, int, pick, series, CLUSTERS, clustersFor } from './mock.js';

const NAMESPACES = {
  production: ['shop', 'payments', 'identity', 'search', 'platform', 'monitoring', 'kube-system', 'ingress-nginx'],
  staging: ['shop', 'payments', 'identity', 'platform', 'kube-system', 'ingress-nginx'],
  development: ['dev-team-a', 'dev-team-b', 'platform', 'kube-system'],
};
const WORKLOADS = {
  shop: [['checkout', 'Deployment', 4], ['cart', 'Deployment', 3], ['catalog', 'Deployment', 3], ['orders', 'Deployment', 3], ['redis-cart', 'StatefulSet', 1]],
  payments: [['payments-api', 'Deployment', 4], ['ledger', 'StatefulSet', 3], ['fraud-check', 'Deployment', 2]],
  identity: [['auth', 'Deployment', 3], ['sessions', 'StatefulSet', 2]],
  search: [['search', 'Deployment', 3], ['indexer', 'Deployment', 1], ['opensearch', 'StatefulSet', 3]],
  platform: [['api-gateway', 'Deployment', 3], ['notifications', 'Deployment', 2], ['nightly-report', 'CronJob', 1]],
  monitoring: [['observaone-agent', 'DaemonSet', 0], ['observaone-cluster-agent', 'Deployment', 1], ['kube-state-metrics', 'Deployment', 1]],
  'kube-system': [['coredns', 'Deployment', 2], ['kube-proxy', 'DaemonSet', 0], ['metrics-server', 'Deployment', 1]],
  'ingress-nginx': [['ingress-nginx-controller', 'Deployment', 2]],
  'dev-team-a': [['web', 'Deployment', 1], ['api', 'Deployment', 1]],
  'dev-team-b': [['worker', 'Deployment', 1], ['postgres', 'StatefulSet', 1]],
};
const IMAGES = { checkout: 'registry.example.local/shop/checkout', cart: 'registry.example.local/shop/cart', 'payments-api': 'registry.example.local/pay/payments-api', postgres: 'postgres', redis: 'redis', opensearch: 'opensearchproject/opensearch', coredns: 'registry.k8s.io/coredns/coredns' };
const REASONS = ['CrashLoopBackOff', 'OOMKilled', 'ImagePullBackOff', 'Pending: Insufficient cpu', 'Error'];

function envOf(c) { return CLUSTERS.find((x) => x.name === c)?.env || 'production'; }

export function nodesOf(cluster) {
  const c = CLUSTERS.find((x) => x.name === cluster);
  if (!c) return [];
  const r = rng(`k8s|nodes|${cluster}`);
  return Array.from({ length: Math.min(c.nodes, 12) }, (_, i) => {
    const ready = !(i === 3 && r() < 0.6);
    const cpu = between(r, 22, i === 1 ? 93 : 78), mem = between(r, 35, i === 5 ? 91 : 80);
    const pressure = mem > 88 ? 'MemoryPressure' : null;
    return {
      name: `${cluster}-node-${String(i + 1).padStart(2, '0')}`, cluster, ready, cpu, mem, pressure, pods: int(r, 14, 58), podCapacity: 110,
      cpuCores: pick(r, [8, 16, 16, 32]), memGb: pick(r, [32, 64, 64, 128]), kubelet: pick(r, ['v1.33.4', 'v1.33.4', 'v1.32.8']), zone: `${c.region}${'abc'[i % 3]}`,
      os: 'Ubuntu 24.04', runtime: 'containerd 2.1', age: int(r, 3, 220),
    };
  });
}

function podsOf(cluster, ns, w, r0) {
  const [name, kind, replicas] = w;
  const nodes = nodesOf(cluster);
  const n = kind === 'DaemonSet' ? nodes.length : kind === 'CronJob' ? 1 : replicas;
  const r = rng(`k8s|pods|${cluster}|${ns}|${name}`);
  const unlucky = r() < 0.18;
  return Array.from({ length: n }, (_, i) => {
    const suffix = kind === 'StatefulSet' ? String(i) : kind === 'DaemonSet' ? Math.floor(r() * 0xfffff).toString(36).slice(0, 5) : `${(hash(name) % 0xffffff).toString(16).slice(0, 6)}-${Math.floor(r() * 0xfffff).toString(36).slice(0, 5)}`;
    const bad = unlucky && i === n - 1;
    const reason = bad ? pick(r, REASONS) : null;
    const phase = reason?.startsWith('Pending') ? 'Pending' : kind === 'CronJob' ? 'Succeeded' : 'Running';
    const cpuReq = pick(r, [0.1, 0.25, 0.5, 1]), memReqMb = pick(r, [128, 256, 512, 1024]);
    const memLimitMb = memReqMb * 2;
    const memMb = reason === 'OOMKilled' ? memLimitMb * 0.98 : memReqMb * between(r, 0.4, 1.5);
    return {
      name: `${name}-${suffix}`, workload: name, kind, ns, cluster, node: phase === 'Pending' ? null : nodes[(i + hash(name)) % nodes.length]?.name,
      phase, ready: !reason && phase === 'Running', reason, restarts: reason === 'CrashLoopBackOff' ? int(r, 12, 140) : reason === 'OOMKilled' ? int(r, 3, 20) : r() < 0.1 ? int(r, 1, 3) : 0,
      cpu: phase === 'Pending' ? 0 : cpuReq * between(r, 0.2, 1.4), cpuReq, cpuLimit: cpuReq * 2, memMb: phase === 'Pending' ? 0 : memMb, memReqMb, memLimitMb,
      ageH: between(r, 0.3, 24 * 30), ip: phase === 'Pending' ? null : `10.244.${int(r, 0, 40)}.${int(r, 2, 250)}`,
      image: `${IMAGES[name] || `registry.example.local/${ns}/${name}`}:${pick(r, ['1.8.2', '2.3.0', '2.4.1', '3.0.5'])}`,
      containers: [name, ...(r() < 0.3 ? ['istio-proxy'] : [])],
    };
  });
}

export function k8sData({ env, cluster, namespace, start, end, empty = false }) {
  if (empty) return { clusters: [], nodes: [], namespaces: [], workloads: [], pods: [], events: [], kpi: {} };
  const clusters = clustersFor(env).filter((c) => !cluster || c.name === cluster);
  const nodes = clusters.flatMap((c) => nodesOf(c.name));
  const workloads = [];
  const pods = [];
  for (const c of clusters) {
    for (const ns of NAMESPACES[envOf(c.name)] || []) {
      if (namespace && ns !== namespace) continue;
      for (const w of WORKLOADS[ns] || []) {
        const p = podsOf(c.name, ns, w);
        pods.push(...p);
        const desired = w[1] === 'DaemonSet' ? p.length : w[1] === 'CronJob' ? 1 : w[2];
        workloads.push({
          id: `${c.name}~${ns}~${w[0]}`, cluster: c.name, ns, name: w[0], kind: w[1], desired, ready: p.filter((x) => x.ready || x.phase === 'Succeeded').length,
          restarts: p.reduce((s, x) => s + x.restarts, 0), cpu: p.reduce((s, x) => s + x.cpu, 0), memMb: p.reduce((s, x) => s + x.memMb, 0),
          cpuReq: p.reduce((s, x) => s + x.cpuReq, 0), memReqMb: p.reduce((s, x) => s + x.memReqMb, 0), image: p[0]?.image,
        });
      }
    }
  }
  const nsList = [...new Set(workloads.map((w) => `${w.cluster}~${w.ns}`))].map((k) => {
    const [cl, ns] = k.split('~');
    const ws = workloads.filter((w) => w.cluster === cl && w.ns === ns);
    const ps = pods.filter((p) => p.cluster === cl && p.ns === ns);
    const r = rng(`k8s|quota|${k}`);
    return { cluster: cl, ns, workloads: ws.length, pods: ps.length, notReady: ps.filter((p) => !p.ready && p.phase !== 'Succeeded').length, cpu: ws.reduce((s, w) => s + w.cpu, 0), memMb: ws.reduce((s, w) => s + w.memMb, 0), cpuQuota: r() < 0.6 ? int(r, 8, 40) : null, restarts: ws.reduce((s, w) => s + w.restarts, 0) };
  });
  const allocCpu = nodes.reduce((s, n) => s + n.cpuCores, 0), allocMemGb = nodes.reduce((s, n) => s + n.memGb, 0);
  const now = (end || Math.floor(Date.now() / 1000)) * 1000;
  const bad = pods.filter((p) => p.reason);
  const re = rng(`k8s|events|${env}|${cluster}|${namespace}`);
  const events = [
    ...bad.map((p) => ({ type: 'Warning', reason: p.reason.split(':')[0] === 'Pending' ? 'FailedScheduling' : p.reason === 'CrashLoopBackOff' ? 'BackOff' : p.reason === 'ImagePullBackOff' ? 'Failed' : p.reason === 'OOMKilled' ? 'OOMKilling' : 'Unhealthy',
      object: `Pod/${p.name}`, ns: p.ns, cluster: p.cluster, at: now - between(re, 1, 50) * 60_000,
      note: p.reason.startsWith('Pending') ? '0/18 nodes are available: 18 Insufficient cpu.' : p.reason === 'CrashLoopBackOff' ? 'Back-off restarting failed container' : p.reason === 'ImagePullBackOff' ? `Failed to pull image "${p.image}": not found` : p.reason === 'OOMKilled' ? 'Memory cgroup out of memory: Killed process' : 'Readiness probe failed: HTTP probe failed with statuscode: 503' })),
    ...Array.from({ length: 6 }, () => { const w = pick(re, workloads.length ? workloads : [{ name: 'app', ns: 'default', cluster: '-' }]); return { type: 'Normal', reason: pick(re, ['ScalingReplicaSet', 'Pulled', 'Created', 'Started', 'SuccessfulCreate']), object: `${w.kind || 'Deployment'}/${w.name}`, ns: w.ns, cluster: w.cluster, at: now - between(re, 1, 180) * 60_000, note: 'Scaled up replica set to 3' }; }),
  ].sort((a, b) => b.at - a.at);
  const rs = rng(`k8s|series|${env}|${cluster}|${namespace}|${start - (start % 60)}`);
  const usedCpu = pods.reduce((s, p) => s + p.cpu, 0), reqCpu = pods.reduce((s, p) => s + p.cpuReq, 0);
  return {
    clusters, nodes, namespaces: nsList, workloads, pods, events,
    kpi: {
      nodesReady: nodes.filter((n) => n.ready).length, nodes: nodes.length,
      podsRunning: pods.filter((p) => p.phase === 'Running' && p.ready).length, pods: pods.length,
      podsBad: bad.length, pending: pods.filter((p) => p.phase === 'Pending').length,
      restarts: pods.reduce((s, p) => s + p.restarts, 0),
      cpuReqPct: allocCpu ? (reqCpu / allocCpu) * 100 * (namespace ? 1 : 3.2) : 0, memReqPct: allocMemGb ? (pods.reduce((s, p) => s + p.memReqMb, 0) / 1024 / allocMemGb) * 100 * (namespace ? 1 : 3.4) : 0,
      unavailable: workloads.filter((w) => w.ready < w.desired).length,
    },
    cpuSeries: start ? [
      { label: 'Used', points: series(rs, { start, end, base: usedCpu, amp: usedCpu * 0.2, noise: usedCpu * 0.05, min: 0 }), color: '#3b82f6' },
      { label: 'Requested', points: series(rs, { start, end, base: reqCpu, amp: 0, noise: 0.01, min: 0 }), color: '#a855f7' },
      ...(namespace ? [] : [{ label: 'Allocatable', points: series(rs, { start, end, base: allocCpu / 3.2, amp: 0, noise: 0, min: 0 }), color: '#64748b' }]),
    ] : [],
  };
}

export function podDetail(args, cluster, ns, name) {
  const d = k8sData({ ...args, cluster, namespace: ns, env: '' });
  const p = d.pods.find((x) => x.name === name);
  if (!p) return null;
  const r = rng(`k8s|podd|${name}`);
  const { start, end } = args;
  return {
    p, events: d.events.filter((e) => e.object === `Pod/${name}`),
    cpu: [{ label: 'Used (cores)', points: series(r, { start, end, base: p.cpu, amp: p.cpu * 0.3, noise: p.cpu * 0.1, min: 0 }), color: '#3b82f6' }, { label: 'Limit', points: series(r, { start, end, base: p.cpuLimit, amp: 0, noise: 0 }), color: '#ef4444' }],
    mem: [{ label: 'Used (MB)', points: series(r, { start, end, base: p.memMb, amp: p.memMb * 0.08, noise: p.memMb * 0.03, min: 0, max: p.memLimitMb }), color: '#a855f7' }, { label: 'Limit', points: series(r, { start, end, base: p.memLimitMb, amp: 0, noise: 0 }), color: '#ef4444' }],
    sameWorkload: d.pods.filter((x) => x.workload === p.workload && x.name !== p.name),
  };
}

export function workloadDetail(args, cluster, ns, name) {
  const d = k8sData({ ...args, cluster, namespace: ns, env: '' });
  const w = d.workloads.find((x) => x.name === name);
  if (!w) return null;
  const r = rng(`k8s|wl|${cluster}|${ns}|${name}`);
  const revs = Array.from({ length: 4 }, (_, i) => ({ rev: 12 - i, image: w.image.replace(/:[^:]+$/, `:${['2.4.1', '2.4.0', '2.3.2', '2.3.0'][i]}`), at: Date.now() - (i * between(r, 1, 6) + between(r, 0.1, 0.9)) * 86400_000, current: i === 0 }));
  const { start, end } = args;
  return {
    w, pods: d.pods.filter((p) => p.workload === name), events: d.events.filter((e) => e.object.endsWith(`/${name}`) || d.pods.some((p) => p.workload === name && e.object === `Pod/${p.name}`)), revs,
    cpu: [{ label: 'Used', points: series(r, { start, end, base: w.cpu, amp: w.cpu * 0.25, noise: w.cpu * 0.06, min: 0 }), color: '#3b82f6' }, { label: 'Requested', points: series(r, { start, end, base: w.cpuReq, amp: 0, noise: 0 }), color: '#a855f7' }],
    mem: [{ label: 'Used (MB)', points: series(r, { start, end, base: w.memMb, amp: w.memMb * 0.1, noise: w.memMb * 0.03, min: 0 }), color: '#a855f7' }, { label: 'Requested', points: series(r, { start, end, base: w.memReqMb, amp: 0, noise: 0 }), color: '#64748b' }],
  };
}

export function nodeDetail(args, name) {
  const cluster = name.replace(/-node-\d+$/, '');
  const node = nodesOf(cluster).find((n) => n.name === name);
  if (!node) return null;
  const d = k8sData({ ...args, cluster, env: '' });
  const r = rng(`k8s|node|${name}`);
  const { start, end } = args;
  return {
    node, pods: d.pods.filter((p) => p.node === name),
    cpu: series(r, { start, end, base: node.cpu, amp: 8, noise: 3, min: 0, max: 100 }), mem: series(r, { start, end, base: node.mem, amp: 3, noise: 1, min: 0, max: 100 }),
    conditions: [['Ready', node.ready ? 'True' : 'False'], ['MemoryPressure', node.pressure === 'MemoryPressure' ? 'True' : 'False'], ['DiskPressure', 'False'], ['PIDPressure', 'False'], ['NetworkUnavailable', 'False']],
  };
}

export function namespacesFor(env) { return [...new Set(clustersFor(env).flatMap((c) => NAMESPACES[envOf(c.name)] || []))].sort(); }
