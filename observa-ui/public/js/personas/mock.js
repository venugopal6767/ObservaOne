// Mock data for the role-based dashboards (frontend only, no backend yet).
// Everything is generated from a seed made of (dataset, environment, time range, filters),
// so numbers are stable while you click around and change when a filter changes.

export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function rng(seed) {
  let a = typeof seed === 'number' ? seed : hash(String(seed));
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
export const between = (r, lo, hi) => lo + r() * (hi - lo);
export const int = (r, lo, hi) => Math.floor(between(r, lo, hi + 1));

// [[unixSeconds, value], ...] with a smooth wave, noise and optional spikes
export function series(r, { start, end, points = 60, base = 50, amp = 10, noise = 3, min = 0, max = Infinity, spikes = 0, trend = 0 }) {
  const step = (end - start) / (points - 1);
  const phase = r() * Math.PI * 2;
  const spikeAt = new Set(Array.from({ length: spikes }, () => Math.floor(r() * points)));
  return Array.from({ length: points }, (_, i) => {
    let v = base + Math.sin(phase + (i / points) * Math.PI * 3) * amp + (r() - 0.5) * 2 * noise + trend * (i / points);
    if (spikeAt.has(i)) v += amp * 3;
    return [Math.round(start + i * step), Math.min(max, Math.max(min, Number(v.toFixed(2))))];
  });
}

export const ENVIRONMENTS = [['', 'All environments'], ['production', 'Production'], ['staging', 'Staging'], ['development', 'Development']];

export const SERVICES = [
  { name: 'checkout', team: 'Payments', lang: 'Java', tier: 1 },
  { name: 'payments-api', team: 'Payments', lang: 'Go', tier: 1 },
  { name: 'orders', team: 'Commerce', lang: 'Node.js', tier: 1 },
  { name: 'catalog', team: 'Commerce', lang: 'Python', tier: 2 },
  { name: 'search', team: 'Discovery', lang: 'Go', tier: 2 },
  { name: 'recommendations', team: 'Discovery', lang: 'Python', tier: 3 },
  { name: 'auth', team: 'Identity', lang: 'Go', tier: 1 },
  { name: 'notifications', team: 'Platform', lang: 'Node.js', tier: 3 },
  { name: 'inventory', team: 'Commerce', lang: 'Java', tier: 2 },
  { name: 'api-gateway', team: 'Platform', lang: 'Go', tier: 1 },
];
export const TEAMS = [...new Set(SERVICES.map((s) => s.team))].sort();
export const CLUSTERS = [
  { name: 'prod-eu-1', env: 'production', region: 'eu-west-1', nodes: 18 },
  { name: 'prod-us-1', env: 'production', region: 'us-east-1', nodes: 24 },
  { name: 'stage-eu-1', env: 'staging', region: 'eu-west-1', nodes: 8 },
  { name: 'dev-shared', env: 'development', region: 'eu-west-1', nodes: 6 },
];
const PEOPLE = ['a.kumar', 'j.smith', 'm.garcia', 'l.chen', 'r.patel', 's.okafor', 'e.novak', 'deploy-bot'];
const PIPELINE_STAGES = ['Checkout', 'Build', 'Unit tests', 'Security scan', 'Integration tests', 'Deploy', 'Smoke tests'];

export function clustersFor(env) { return CLUSTERS.filter((c) => !env || c.env === env); }

// ---------------- DevOps ----------------
export function devopsData({ env, rangeSeconds, start, end, cluster, team, service, empty = false }) {
  const r = rng(`devops|${env}|${rangeSeconds}|${cluster}|${team}|${service}`);
  const now = end * 1000;
  const envs = env ? [env] : ['production', 'staging', 'development'];
  const svcs = empty ? [] : SERVICES.filter((s) => (!team || s.team === team) && (!service || s.name === service));
  const clusters = empty ? [] : clustersFor(env).filter((c) => !cluster || c.name === cluster);

  // deployments in the selected range (at least the last 7 days so the frequency chart is never empty)
  const span = Math.max(rangeSeconds, 7 * 86400);
  const nDeploy = svcs.length ? int(r, 18, 40) * (envs.length === 1 ? 1 : 2) : 0;
  const deployments = Array.from({ length: nDeploy }, (_, i) => {
    const s = pick(r, svcs);
    const e = pick(r, envs);
    const roll = r();
    const status = roll < 0.07 ? 'failed' : roll < 0.11 ? 'rolled_back' : roll < 0.14 && i < 3 ? 'in_progress' : 'succeeded';
    const at = now - (i === 0 ? 0.03 : r()) * span * 1000;
    const major = int(r, 1, 4), minor = int(r, 0, 30), patch = int(r, 0, 12);
    return {
      id: `dep-${(hash(`${s.name}|${i}|${env}`) % 900000) + 100000}`,
      service: s.name, team: s.team, env: e, cluster: pick(r, clustersFor(e).length ? clustersFor(e) : CLUSTERS).name,
      version: `v${major}.${minor}.${patch}`, previous: `v${major}.${minor}.${Math.max(0, patch - 1)}`,
      status, at, durationSec: int(r, 95, 900), by: pick(r, PEOPLE), commit: Math.floor(r() * 0xfffffff).toString(16).padStart(7, '0'),
      changes: int(r, 1, 24),
    };
  }).sort((a, b) => b.at - a.at);

  const pipelines = Array.from({ length: svcs.length ? int(r, 10, 16) : 0 }, (_, i) => {
    const s = pick(r, svcs);
    const failAt = r() < 0.18 ? int(r, 1, PIPELINE_STAGES.length - 1) : -1;
    const running = i < 2 && r() < 0.6;
    const stages = PIPELINE_STAGES.map((name, k) => ({
      name, durationSec: int(r, 8, k === 4 ? 420 : 160),
      status: running && k === PIPELINE_STAGES.length - 2 ? 'running' : running && k > PIPELINE_STAGES.length - 2 ? 'pending'
        : failAt === -1 || k < failAt ? 'passed' : k === failAt ? 'failed' : 'skipped',
    }));
    return {
      id: `run-${4000 + int(r, 0, 5000)}`, service: s.name, team: s.team, branch: pick(r, ['main', 'main', 'main', 'release/2026.10', 'feature/cart-v2']),
      status: running ? 'running' : failAt >= 0 ? 'failed' : 'passed', at: now - r() * span * 1000, stages,
      durationSec: stages.reduce((a, x) => a + (x.status === 'skipped' || x.status === 'pending' ? 0 : x.durationSec), 0), by: pick(r, PEOPLE),
    };
  }).sort((a, b) => b.at - a.at);

  const clusterRows = clusters.map((c) => {
    const cpu = between(r, 35, 88), mem = between(r, 40, 86);
    const notReady = r() < 0.2 ? int(r, 1, 2) : 0;
    return {
      ...c, cpu, mem, pods: c.nodes * int(r, 18, 30), restarts: int(r, 0, 40), notReady,
      status: notReady || cpu > 85 ? 'degraded' : 'healthy',
      cpuSeries: series(r, { start, end, base: cpu, amp: 8, noise: 3, max: 100 }),
      memSeries: series(r, { start, end, base: mem, amp: 4, noise: 1.5, max: 100 }),
    };
  });

  const alertNames = ['HighErrorRate', 'PodCrashLooping', 'HostDiskFilling', 'HighLatencyP95', 'DeploymentReplicasMismatch', 'CertificateExpiringSoon', 'NodeNotReady'];
  const alerts = Array.from({ length: svcs.length ? int(r, 2, 7) : 0 }, () => {
    const s = pick(r, svcs);
    return { name: pick(r, alertNames), service: s.name, severity: r() < 0.3 ? 'critical' : 'warning', since: now - r() * 6 * 3600_000, cluster: pick(r, clusters.length ? clusters : CLUSTERS).name };
  }).sort((a, b) => (a.severity === b.severity ? b.since - a.since : a.severity === 'critical' ? -1 : 1));

  // deployments per day, last 14 days
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(now - (13 - i) * 86400_000);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  });
  const perDay = days.map((d) => {
    const total = svcs.length ? int(r, 3, 14) : 0;
    const failed = Math.min(total, r() < 0.4 ? int(r, 1, 2) : 0);
    return { day: d, succeeded: total - failed, failed };
  });

  const done = deployments.filter((d) => d.status !== 'in_progress');
  const failed = done.filter((d) => d.status !== 'succeeded');
  return {
    deployments, pipelines, clusters: clusterRows, alerts, perDay,
    kpi: {
      deploys: deployments.length,
      deploysBefore: Math.max(0, deployments.length + int(r, -6, 6)),
      changeFailure: done.length ? (failed.length / done.length) * 100 : 0,
      leadTimeH: between(r, 2.5, 9),
      mttrMin: between(r, 18, 75),
      pipelineSuccess: pipelines.length ? (pipelines.filter((p) => p.status === 'passed').length / Math.max(1, pipelines.filter((p) => p.status !== 'running').length)) * 100 : 0,
      activeAlerts: alerts.length, critical: alerts.filter((a) => a.severity === 'critical').length,
      cpu: clusterRows.length ? clusterRows.reduce((a, c) => a + c.cpu, 0) / clusterRows.length : 0,
      mem: clusterRows.length ? clusterRows.reduce((a, c) => a + c.mem, 0) / clusterRows.length : 0,
    },
    pipelineDuration: [
      { label: 'p50', points: series(r, { start, end, base: 540, amp: 60, noise: 30 }) },
      { label: 'p95', points: series(r, { start, end, base: 980, amp: 120, noise: 60, spikes: 2 }) },
    ],
    errorAfterDeploy: series(r, { start, end, base: 0.8, amp: 0.4, noise: 0.15, spikes: 1 }),
  };
}

// Pretend network: a short delay so loading states are visible; `?mock=error` / `?mock=empty` force those states.
export function mockFetch(build, { delay = 350 } = {}) {
  const mode = new URLSearchParams(location.search).get('mock');
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (mode === 'error') return reject(new Error('Could not load data (simulated error). Try again.'));
      try { resolve(build(mode === 'empty')); } catch (e) { reject(e); }
    }, delay + Math.random() * 250);
  });
}
