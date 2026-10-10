// Sample data for the IT / Platform Administrator dashboard: agents, platform components,
// data sources, ingestion against the licence, storage growth, users and access hygiene.
import { rng, between, int, pick, series } from './mock.js';

const LATEST = '1.4.0';
const HOSTS = [
  ['web-01', 'linux'], ['web-02', 'linux'], ['web-07', 'linux'], ['api-03', 'linux'], ['db-01', 'linux'], ['db-02', 'windows'], ['cache-01', 'linux'],
  ['bastion-01', 'linux'], ['app-win-01', 'windows'], ['app-win-02', 'windows'], ['k8s-node-04', 'kubernetes'], ['k8s-node-07', 'kubernetes'], ['k8s-node-11', 'kubernetes'],
  ['build-01', 'docker'], ['build-02', 'docker'], ['report-01', 'linux'], ['mail-01', 'linux'], ['files-01', 'windows'],
];
export const COMPONENTS = [
  { id: 'prometheus', name: 'Prometheus', role: 'Metrics store', version: 'v3.15.0', store: true, capGb: 500 },
  { id: 'loki', name: 'Loki', role: 'Log store', version: '3.7.8', store: true, capGb: 1500 },
  { id: 'tempo', name: 'Tempo', role: 'Trace store', version: '2.10.8', store: true, capGb: 400 },
  { id: 'postgres', name: 'PostgreSQL', role: 'App database', version: '17', store: true, capGb: 50 },
  { id: 'grafana', name: 'Grafana', role: 'Dashboards', version: '12.4.12' },
  { id: 'alertmanager', name: 'Alertmanager', role: 'Alert routing', version: '0.34.1' },
  { id: 'nginx', name: 'Nginx', role: 'HTTPS front door', version: '1.30' },
  { id: 'observa-ui', name: 'ObservaOne UI', role: 'This app', version: '1.8.5' },
];
export const PLATFORMS = [['linux', 'Linux'], ['windows', 'Windows'], ['kubernetes', 'Kubernetes'], ['docker', 'Docker']];
const LICENCE_GB_DAY = 120;

function agents(env) {
  const now = Date.now();
  return HOSTS.map(([host, platform]) => {
    const r = rng(`adm|agent|${env}|${host}`);
    const roll = r();
    const status = roll < 0.1 ? 'offline' : roll < 0.18 ? 'degraded' : 'online';
    const version = r() < 0.3 ? pick(r, ['1.2.1', '1.3.0', '1.3.2']) : LATEST;
    return {
      host, platform, status, version, outdated: version !== LATEST, env: env || pick(r, ['production', 'production', 'staging']),
      lastSeen: status === 'offline' ? now - between(r, 0.3, 30) * 3600_000 : now - between(r, 5, 55) * 1000,
      samples: status === 'offline' ? 0 : between(r, 800, 6000), logs: status === 'offline' ? 0 : between(r, 5, 240), queue: status === 'degraded' ? int(r, 40, 95) : int(r, 0, 8),
      sendErrors: status === 'degraded' ? int(r, 20, 400) : 0, uptimeDays: int(r, 1, 120), ip: `10.20.${int(r, 1, 9)}.${int(r, 10, 250)}`,
    };
  }).sort((a, b) => ({ offline: 0, degraded: 1, online: 2 }[a.status] - { offline: 0, degraded: 1, online: 2 }[b.status]) || Number(b.outdated) - Number(a.outdated));
}

function components(env, start, end) {
  return COMPONENTS.map((c) => {
    const r = rng(`adm|comp|${env}|${c.id}`);
    const cpu = between(r, 4, c.id === 'prometheus' ? 70 : 40), mem = between(r, 15, 80);
    const usedGb = c.store ? c.capGb * between(r, 0.35, 0.82) : 0;
    const growthGbDay = c.store ? c.capGb * between(r, 0.002, 0.012) : 0;
    const status = c.id === 'loki' && r() < 0.5 ? 'degraded' : 'healthy';
    return {
      ...c, cpu, mem, usedGb, growthGbDay, status, uptimeDays: int(r, 2, 90), retentionDays: c.store ? pick(r, [15, 30, 30, 90]) : null,
      daysToFull: c.store ? (c.capGb - usedGb) / growthGbDay : null,
      cpuSeries: series(r, { start, end, base: cpu, amp: cpu * 0.3, noise: cpu * 0.1, min: 0, max: 100 }),
      memSeries: series(r, { start, end, base: mem, amp: 4, noise: 1.5, min: 0, max: 100 }),
      note: status === 'degraded' ? 'Ingestion is being rate-limited for 2 tenants' : null,
    };
  });
}

function datasources(env) {
  const r = rng(`adm|ds|${env}`);
  return [['Prometheus', 'metrics'], ['Loki', 'logs'], ['Tempo', 'traces'], ['Alertmanager', 'alerts'], ['Grafana', 'dashboards'], ['LDAP directory', 'sign-in'], ['PostgreSQL', 'app data']]
    .map(([name, kind]) => ({ name, kind, status: name === 'LDAP directory' && r() < 0.5 ? 'down' : (r(), 'connected'), latency: between(r, 3, 90), checked: Date.now() - between(r, 10, 300) * 1000 }));
}

export function adminData({ env, start, end, platform, empty = false }) {
  if (empty) return { agents: [], components: [], datasources: [], days: [], kpi: {} };
  const ag = agents(env).filter((a) => !platform || a.platform === platform);
  const comps = components(env, start, end);
  const ds = datasources(env);
  const r = rng(`adm|ingest|${env}`);
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (13 - i));
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const k = weekend ? 0.7 : 1;
    return { day: d.getTime(), metrics: between(r, 22, 30) * k, logs: between(r, 48, 78) * k * (i === 10 ? 1.6 : 1), traces: between(r, 9, 16) * k };
  });
  const today = days[days.length - 1];
  const r2 = rng(`adm|users|${env}`);
  return {
    agents: ag, components: comps, datasources: ds, days, licenceGbDay: LICENCE_GB_DAY,
    users: { total: int(r2, 60, 140), active24h: int(r2, 25, 55), admins: int(r2, 3, 7), mfaPct: between(r2, 72, 96), keysExpiring: int(r2, 0, 4), neverSignedIn: int(r2, 2, 9), ssoPct: between(r2, 55, 85) },
    kpi: {
      online: ag.filter((a) => a.status === 'online').length, agents: ag.length, offline: ag.filter((a) => a.status === 'offline').length, outdated: ag.filter((a) => a.outdated).length,
      dsOk: ds.filter((d) => d.status === 'connected').length, ds: ds.length,
      ingestToday: today.metrics + today.logs + today.traces,
      storageUsed: comps.filter((c) => c.store).reduce((s, c) => s + c.usedGb, 0), storageCap: comps.filter((c) => c.store).reduce((s, c) => s + c.capGb, 0),
      soonestFull: comps.filter((c) => c.store).sort((a, b) => a.daysToFull - b.daysToFull)[0],
    },
  };
}

export function agentDetail({ env, start, end }, host) {
  const a = agents(env).find((x) => x.host === host);
  if (!a) return null;
  const r = rng(`adm|agentd|${host}`);
  return {
    a,
    samples: series(r, { start, end, base: a.samples, amp: a.samples * 0.15, noise: a.samples * 0.05, min: 0 }).map(([t, v], i, arr) => [t, a.status === 'offline' && i > arr.length * 0.7 ? 0 : v]),
    queue: series(r, { start, end, base: a.queue, amp: a.queue * 0.5 + 1, noise: 1, min: 0, max: 100 }),
    receivers: a.platform === 'windows' ? ['windows_exporter (CPU, memory, disks, services)', 'Windows event log'] : a.platform === 'kubernetes' ? ['kubelet stats', 'container logs', 'kube-state-metrics'] : a.platform === 'docker' ? ['docker stats', 'container logs'] : ['node_exporter (CPU, memory, disks, network)', 'journald and /var/log'],
    config: `server: https://observa.example.local\nenvironment: ${a.env}\nhost: ${a.host}\nmetrics_interval: 15s\nlogs: true\nqueue_size: 10000`,
  };
}

export function componentDetail({ env, start, end }, id) { return components(env, start, end).find((c) => c.id === id) || null; }

export function ingestionDetail({ env, start, end }, day) {
  const d = adminData({ env, start, end });
  const pickDay = d.days.find((x) => String(x.day) === String(day)) || d.days[d.days.length - 1];
  const r = rng(`adm|ingd|${env}|${pickDay.day}`);
  const total = pickDay.metrics + pickDay.logs + pickDay.traces;
  const sources = ['checkout', 'payments-api', 'orders', 'api-gateway', 'search', 'k8s-node-04', 'web-01', 'db-01', 'auth', 'notifications']
    .map((s) => ({ name: s, logs: between(r, 0.5, 14), metrics: between(r, 0.3, 4), traces: between(r, 0, 3) }))
    .map((s) => ({ ...s, total: s.logs + s.metrics + s.traces })).sort((a, b) => b.total - a.total);
  return { day: pickDay, total, days: d.days, sources, licence: LICENCE_GB_DAY };
}
