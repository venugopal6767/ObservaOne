// Insights: forecasts ("disk full in 3 days") and anomalies ("CPU unusual for this hour") from Prometheus data.
import express from 'express';
import { requirePerm, httpError } from '../auth.js';
import { prom } from '../datasources.js';
import { forecast, detectAnomalies, downsample } from '../insights.js';
import { cpuByHost, memByHost } from '../queries.js';

export const insightsRouter = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const DAY = 86400;
const LNX_FS = 'fstype!~"tmpfs|overlay|squashfs|ramfs|nsfs|fuse.*|autofs|devtmpfs",mountpoint!~"/boot.*|/run.*|/var/lib/docker/.+|/var/lib/kubelet/.+"';
const WIN_DISK = 'volume!~"HarddiskVolume.*"';
const NET_DEV = 'device!~"lo|veth.*|docker.*|br-.*|cali.*|flannel.*|cni.*|virbr.*"';

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const c = cache.get(key);
  if (c && c.exp > Date.now()) return c.value;
  const value = await fn();
  cache.set(key, { value, exp: Date.now() + ttlMs });
  return value;
}

async function rangeOnce(query, seconds, points) {
  const end = Math.floor(Date.now() / 1000);
  const step = Math.max(60, Math.ceil(seconds / points));
  const d = await prom('/api/v1/query_range', { query, start: end - seconds, end, step });
  return { step, result: d.result.map((r) => ({ metric: r.metric, points: r.values.map(([t, v]) => [Number(t), Number(v)]) })) };
}

// Asks for the full window first; when Prometheus holds less history than that (new install), asks again for a
// shorter window so the step stays fine enough to see a trend.
async function range(query, seconds, points = 400) {
  const most = (o) => Math.max(0, ...o.result.map((r) => r.points.length));
  let best = await rangeOnce(query, seconds, points);
  for (const shorter of [2 * DAY, 12 * 3600, 3 * 3600]) {
    if (most(best) >= 60 || shorter >= seconds) break;
    const next = await rangeOnce(query, shorter, points);
    if (most(next) > most(best)) best = next; // keep the window that shows the most (gaps in history happen)
  }
  return best;
}

// ---------------- forecasts ----------------
const FORECASTS = [
  {
    kind: 'disk', label: 'Disk', unit: 'percent', threshold: 100, direction: 'up', minNow: 0,
    query: `max by (host, mountpoint) (100 * (1 - node_filesystem_avail_bytes{${LNX_FS}} / node_filesystem_size_bytes{${LNX_FS}}))`,
    name: (m) => `Disk ${m.mountpoint}`,
  },
  {
    kind: 'disk', label: 'Disk', unit: 'percent', threshold: 100, direction: 'up', minNow: 0,
    query: `max by (host, volume) (100 * (1 - windows_logical_disk_free_bytes{${WIN_DISK}} / windows_logical_disk_size_bytes{${WIN_DISK}}))`,
    name: (m) => `Disk ${m.volume}`,
  },
  { kind: 'memory', label: 'Memory', unit: 'percent', threshold: 98, direction: 'up', minNow: 40, query: memByHost(), name: () => 'Memory' },
];

insightsRouter.get('/insights/forecasts', requirePerm('view'), wrap(async (req, res) => {
  const lookback = Math.min(30 * DAY, Math.max(6 * 3600, Number(req.query.lookbackHours || 168) * 3600));
  const horizonDays = Math.min(365, Math.max(1, Number(req.query.horizonDays) || 30));
  const items = await cached(`fc|${lookback}|${horizonDays}`, 60_000, async () => {
    const out = [];
    for (const def of FORECASTS) {
      let data;
      try { data = await range(def.query, lookback); } catch (e) { console.warn('[insights] forecast query failed:', e.message); continue; }
      for (const s of data.result.slice(0, 200)) {
        const f = forecast(s.points, { threshold: def.threshold, direction: def.direction, horizonDays });
        if (f.status === 'not-enough-data' || f.current < def.minNow) continue;
        // when it reaches 90 % as an earlier warning
        const warn = def.kind === 'disk' ? forecast(s.points, { threshold: 90, direction: 'up', horizonDays }) : null;
        out.push({
          kind: def.kind, host: s.metric.host || '', resource: def.name(s.metric), unit: def.unit, threshold: def.threshold,
          ...f, daysTo90: warn && ['will-cross', 'far', 'crossed'].includes(warn.status) ? warn.daysLeft : null,
          history: downsample(s.points, 160),
        });
      }
    }
    const order = { crossed: 0, 'will-cross': 1, far: 2, stable: 3 };
    return out.sort((a, b) => (order[a.status] - order[b.status]) || ((a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9)));
  });
  res.json({
    items, horizonDays,
    summary: {
      within1d: items.filter((x) => x.daysLeft !== null && x.daysLeft <= 1).length,
      within7d: items.filter((x) => x.daysLeft !== null && x.daysLeft <= 7).length,
      within30d: items.filter((x) => x.daysLeft !== null && x.daysLeft <= 30).length,
      watched: items.length,
    },
  });
}));

// ---------------- anomalies ----------------
const ANOMALIES = [
  { metric: 'cpu', label: 'CPU used', unit: 'percent', minDelta: 10, query: cpuByHost() },
  { metric: 'memory', label: 'Memory used', unit: 'percent', minDelta: 5, query: memByHost() },
  { metric: 'net_in', label: 'Network in', unit: 'Bps', minDelta: 100e3, query: `sum by (host) (rate(node_network_receive_bytes_total{${NET_DEV}}[5m])) or sum by (host) (rate(windows_net_bytes_received_total[5m]))` },
  { metric: 'net_out', label: 'Network out', unit: 'Bps', minDelta: 100e3, query: `sum by (host) (rate(node_network_transmit_bytes_total{${NET_DEV}}[5m])) or sum by (host) (rate(windows_net_bytes_sent_total[5m]))` },
];

insightsRouter.get('/insights/anomalies', requirePerm('view'), wrap(async (req, res) => {
  const sensitivity = ['low', 'medium', 'high'].includes(req.query.sensitivity) ? req.query.sensitivity : 'medium';
  const windowSec = Math.min(24, Math.max(1, Number(req.query.windowHours) || 6)) * 3600;
  const result = await cached(`an|${sensitivity}|${windowSec}`, 60_000, async () => {
    const items = [];
    for (const def of ANOMALIES) {
      let data;
      try { data = await range(def.query, 22 * DAY, 3200); } catch (e) { console.warn('[insights] anomaly query failed:', e.message); continue; }
      for (const s of data.result.slice(0, 100)) {
        const a = detectAnomalies(s.points, { step: data.step, window: windowSec, sensitivity, minDelta: def.minDelta });
        if (a.status === 'not-enough-data') continue;
        items.push({ metric: def.metric, label: def.label, unit: def.unit, host: s.metric.host || '', ...a });
      }
    }
    return items.sort((a, b) => (b.status === 'anomaly') - (a.status === 'anomaly') || Math.abs(b.score) - Math.abs(a.score));
  });
  res.json({
    sensitivity, items: result,
    summary: { anomalies: result.filter((x) => x.status === 'anomaly').length, watched: result.length, seasons: [...new Set(result.map((x) => x.season))] },
  });
}));

// ---------------- explore any PromQL ----------------
insightsRouter.post('/insights/explore', requirePerm('view'), wrap(async (req, res) => {
  const { query, mode = 'forecast', threshold, direction = 'up', lookbackHours = 168, sensitivity = 'medium', minDelta = 0 } = req.body || {};
  if (!query || String(query).length > 2000) throw httpError(400, 'Query is required.');
  if (mode === 'forecast') {
    const t = Number(threshold);
    if (!Number.isFinite(t)) throw httpError(400, 'Threshold must be a number.');
    const data = await range(String(query), Math.min(30 * DAY, Math.max(3600, Number(lookbackHours) * 3600))).catch((e) => { throw httpError(400, e.message); });
    return res.json({ mode, items: data.result.slice(0, 20).map((s) => ({ metric: s.metric, ...forecast(s.points, { threshold: t, direction }), history: downsample(s.points, 160) })) });
  }
  const data = await range(String(query), 22 * DAY, 3200).catch((e) => { throw httpError(400, e.message); });
  return res.json({ mode: 'anomaly', items: data.result.slice(0, 20).map((s) => ({ metric: s.metric, ...detectAnomalies(s.points, { step: data.step, sensitivity, minDelta: Number(minDelta) || 0 }) })) });
}));
