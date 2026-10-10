// All /api routes.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';
import { config } from './config.js';
import { audit, readAudit } from './store.js';
import {
  login, logout, requireAuth, requirePerm, requireUser, requireAjaxHeader, changeOwnPassword, verifyMfaLogin,
  listUsers, createUser, updateUser, deleteUser, httpError, loadRoles, PERMISSIONS,
  listSessions, revokeSession, getPrefs, setPrefs, hasPerm,
} from './auth.js';
import { q, one } from './db.js';
import { ssoRouter } from './sso.js';
import { accessRouter } from './routes/access.js';
import { extraRouters } from './routes/index.js';
import { getDatasources, ds, updateDatasource, testDatasource, prom, promInstant, am, fetchJson } from './datasources.js';
import { demoServices, demoServiceSeries, demoLogs, demoTraceSearch, buildTrace } from './demo.js';
import { cpuByHost, memByHost, diskFreeByHost, SERVERS_UP } from './queries.js';

const APP_VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return ''; } })();

export const api = express.Router();
api.use(express.json({ limit: '200kb' }));
api.use(requireAjaxHeader);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const nowSec = () => Math.floor(Date.now() / 1000);

function timeRange(req, defRange = 3600) {
  const end = num(req.query.end, nowSec());
  const start = num(req.query.start, end - defRange);
  if (end <= start) throw httpError(400, 'end must be after start');
  if (end - start > 31 * 86400) throw httpError(400, 'Time range is limited to 31 days');
  const step = Math.max(15, num(req.query.step, Math.ceil((end - start) / 120)));
  return { start, end, step };
}

// ---------------- auth ----------------
api.get('/health', (req, res) => res.json({ ok: true }));
api.get('/brand', (req, res) => res.json({ brand: config.brand }));

// Data intake that authenticates itself (RUM beacons, Alertmanager webhook) - mounted before the login check
for (const r of extraRouters.public) api.use(r);

api.post('/login', wrap(async (req, res) => {
  res.json(await login(req, res)); // { user } or { mfaRequired, challenge }
}));

api.post('/login/mfa', wrap(async (req, res) => {
  res.json(await verifyMfaLogin(req, res, req.body || {}));
}));

api.use(ssoRouter); // /auth/providers, /auth/:provider/login, /auth/:provider/callback

api.use(requireAuth); // ---- everything below needs a session or an API key ----

api.post('/logout', wrap(async (req, res) => {
  audit(req, 'logout');
  await logout(req, res);
  res.json({ ok: true });
}));

api.get('/me', wrap(async (req, res) => {
  res.json({
    user: req.user,
    brand: config.brand,
    version: APP_VERSION,
    sessionIdleMinutes: config.sessionIdleMinutes,
    grafanaUrl: ds('grafana').publicUrl,
    rulesEditable: !!config.rulesFile,
    prefs: await getPrefs(req.userId),
    teams: await myTeams(req),
  });
}));

// per-user settings (time range, last queries, dashboard variables)
api.put('/me/prefs', requireUser, wrap(async (req, res) => {
  await setPrefs(req.userId, req.body);
  res.json({ ok: true });
}));

// my sign-ins (this and other browsers)
api.get('/me/sessions', requireUser, wrap(async (req, res) => {
  res.json(await listSessions({ userId: req.userId, currentHash: req.sessionHash }));
}));
api.delete('/me/sessions/:id', requireUser, wrap(async (req, res) => {
  await revokeSession({ shortId: req.params.id, userId: req.userId });
  audit(req, 'session.revoke', { session: req.params.id });
  res.json({ ok: true });
}));

api.post('/me/password', requireUser, wrap(async (req, res) => {
  await changeOwnPassword(req, req.body?.current, req.body?.next);
  audit(req, 'password.changed');
  res.json({ ok: true });
}));

// ---------------- Prometheus (read-only) ----------------
api.get('/prom/query', wrap(async (req, res) => {
  res.json(await prom('/api/v1/query', { query: req.query.query, time: req.query.time }));
}));

api.get('/prom/query_range', wrap(async (req, res) => {
  const { start, end, step } = timeRange(req);
  if (!req.query.query) throw httpError(400, 'query is required');
  res.json(await prom('/api/v1/query_range', { query: req.query.query, start, end, step }));
}));

let metricNamesCache = { at: 0, names: [] };
api.get('/prom/metric-names', wrap(async (req, res) => {
  if (Date.now() - metricNamesCache.at > 60_000) {
    metricNamesCache = { at: Date.now(), names: await prom('/api/v1/label/__name__/values') };
  }
  res.json(metricNamesCache.names);
}));

api.get('/prom/label-values', wrap(async (req, res) => {
  const label = String(req.query.label || '');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(label)) throw httpError(400, 'bad label name');
  const match = req.query.match ? [String(req.query.match)] : undefined;
  res.json(await prom(`/api/v1/label/${label}/values`, { 'match[]': match }));
}));

api.get('/prom/targets', wrap(async (req, res) => {
  const d = await prom('/api/v1/targets', { state: 'active' });
  const pulled = d.activeTargets.map((t) => ({
    job: t.labels.job, instance: t.labels.instance, host: t.labels.host || t.labels.instance,
    os: t.labels.os || '', env: t.labels.env || '', role: t.labels.role || '',
    health: t.health, lastScrape: t.lastScrape, durationMs: Math.round((t.lastScrapeDuration || 0) * 1000),
    lastError: t.lastError, source: 'scrape',
  }));
  // Servers that push through the ObservaOne Agent (they are not Prometheus scrape targets).
  // One row per job+host: the freshest label set wins (labels change when env/role are edited).
  const pushed = [];
  try {
    const sel = 'up{agent="observaone", job=~"linux|windows"}';
    const [vals, stamps] = await Promise.all([
      promInstant(`last_over_time(${sel}[1h])`),
      promInstant(`max_over_time(timestamp(${sel})[1h:15s])`),
    ]);
    const key = (m) => JSON.stringify(Object.entries(m).filter(([k]) => k !== '__name__').sort());
    const ts = new Map(stamps.map((x) => [key(x.metric), Number(x.value[1])]));
    const best = new Map();
    for (const x of vals) {
      const last = ts.get(key(x.metric)) || 0;
      const id = `${x.metric.job}|${x.metric.host}`;
      if (!best.has(id) || best.get(id).last < last) best.set(id, { m: x.metric, up: Number(x.value[1]) === 1, last });
    }
    const now = Date.now() / 1000;
    for (const { m, up, last } of best.values()) {
      const stale = now - last > config.agent.onlineSeconds;
      pushed.push({
        job: m.job, instance: 'agent', host: m.host || m.instance, os: m.os || '', env: m.env || '', role: m.role || '',
        health: !stale && up ? 'up' : 'down', lastScrape: last ? new Date(last * 1000).toISOString() : null, durationMs: 0,
        lastError: stale ? 'The agent stopped sending data' : up ? '' : 'The agent cannot read the local exporter',
        source: 'agent', platform: m.platform || '',
      });
    }
  } catch { /* Prometheus without agent data */ }
  res.json([...pulled, ...pushed]);
}));

// ---------------- Overview (one call for the whole page) ----------------
const NET_DEV = 'device!~"lo|veth.*|docker.*|br-.*|cali.*|flannel.*|cni.*|virbr.*"';
const NET_BPS = `(sum(rate(node_network_receive_bytes_total{${NET_DEV}}[5m])) + sum(rate(node_network_transmit_bytes_total{${NET_DEV}}[5m]))) * 8`;
const scalarOf = (r) => (r && r[0] ? Number(r[0].value[1]) : null);
const lastOf = (series) => { const v = series?.[0]?.values; return v && v.length ? Number(v[v.length - 1][1]) : null; };

// error rate (weighted by traffic) and P95 across all services, over time
async function servicesKpiSeries(start, end, step) {
  if (ds('services').mode === 'demo') {
    const err = [], p95 = [], rps = [];
    for (let t = start; t <= end; t += step) {
      const now = demoServices(t);
      const total = now.reduce((a, x) => a + x.rps, 0) || 1;
      err.push([t, now.reduce((a, x) => a + x.rps * x.errorRate, 0) / total]);
      const live = now.filter((x) => x.p95 !== null);
      p95.push([t, live.reduce((a, x) => a + x.rps * x.p95, 0) / (live.reduce((a, x) => a + x.rps, 0) || 1)]);
      rps.push([t, total]);
    }
    return { demo: true, errorRate: err, p95, rps };
  }
  const c = servicesCfg();
  const [e, p, r] = await Promise.all([
    prom('/api/v1/query_range', { query: `avg(${c.errorRate})`, start, end, step }).catch(() => ({ result: [] })),
    prom('/api/v1/query_range', { query: `avg(${c.p95})`, start, end, step }).catch(() => ({ result: [] })),
    prom('/api/v1/query_range', { query: `sum(${c.rps})`, start, end, step }).catch(() => ({ result: [] })),
  ]);
  const vals = (d) => (d.result[0]?.values || []).map(([t, v]) => [t, Number(v)]);
  return { demo: false, errorRate: vals(e), p95: vals(p), rps: vals(r) };
}

api.get('/overview', wrap(async (req, res) => {
  const { start, end, step } = timeRange(req);
  const range = (query) => prom('/api/v1/query_range', { query, start, end, step });
  // optional environment filter: only hosts whose "env" label matches
  const env = String(req.query.env || '').replace(/[^\w.-]/g, '');
  const scope = (expr) => (env ? `((${expr}) and on(host) group by (host) (up{job=~"windows|linux",env="${env}"}))` : expr);
  const upSel = env ? `up{job=~"windows|linux",env="${env}"}` : SERVERS_UP;
  const net = env
    ? `sum(${scope(`sum by (host) (rate(node_network_receive_bytes_total{${NET_DEV}}[5m])) + sum by (host) (rate(node_network_transmit_bytes_total{${NET_DEV}}[5m]))`)}) * 8`
    : NET_BPS;
  const settled = await Promise.allSettled([
    range(`avg(${scope(cpuByHost())})`),                  // 0
    range(`avg(${scope(memByHost())})`),                  // 1
    range(`100 - avg(${scope(diskFreeByHost())})`),       // 2
    range(net),                                           // 3
    range(`count(${upSel} == 1)`),                           // 4
    promInstant(`count(${upSel} == 1)`),                     // 5
    promInstant(`count(${upSel} == 0)`),                     // 6
    am('/api/v2/alerts?active=true&silenced=false&inhibited=false'), // 7
    servicesNow(),                                        // 8
    servicesNow(3600),                                    // 9
    servicesKpiSeries(start, end, step),                  // 10
    promInstant(`avg(${scope(cpuByHost('1h'))})`),        // 11
    promInstant(`avg(${scope(memByHost('1h'))})`),        // 12
    env ? Promise.resolve({ rows: [{ n: 0 }] }) : q(`SELECT count(*)::int AS n FROM agents WHERE NOT blocked AND last_seen < now() - make_interval(secs => $1)`, [config.agent.onlineSeconds]), // 13
    promInstant(`count(${upSel} == 1 offset 1h)`),           // 14
    promInstant(`group by (env) (${SERVERS_UP.replace('}', ',env!=""}')})`), // 15
    promInstant(`(100 - (${scope(diskFreeByHost())})) > 90`),   // 16 hosts with a disk over 90% full
    promInstant(`${upSel} == 0`),                            // 17 hosts not answering
  ]);
  const v = (i) => (settled[i].status === 'fulfilled' ? settled[i].value : null);
  const err = (i) => (settled[i].status === 'rejected' ? settled[i].reason.message : null);
  const series = (i) => (v(i)?.result?.[0]?.values || []).map(([t, x]) => [t, Number(x)]);
  const svc = v(8), before = v(9), kpi = v(10);
  const up = scalarOf(v(5)) || 0, down = scalarOf(v(6)) || 0, unknown = v(13)?.rows?.[0]?.n || 0;
  const lastPoint = (arr) => (arr?.length ? arr[arr.length - 1][1] : null);
  const firstPoint = (arr) => (arr?.length ? arr[0][1] : null);
  res.json({
    hosts: { total: up + down + unknown, healthy: up, unhealthy: down, unknown, before: scalarOf(v(14)), series: series(4), error: err(5) },
    cpu: { now: lastOf(v(0)?.result), before: scalarOf(v(11)), series: series(0), error: err(0) },
    mem: { now: lastOf(v(1)?.result), before: scalarOf(v(12)), series: series(1), error: err(1) },
    disk: { now: lastOf(v(2)?.result), series: series(2), error: err(2) },
    net: { now: lastOf(v(3)?.result), series: series(3), error: err(3) },
    alerts: { active: v(7) ? v(7).length : null, critical: v(7) ? v(7).filter((a) => a.labels.severity === 'critical').length : null, error: err(7) },
    services: svc,
    servicesBefore: before?.summary || null,
    servicesError: err(8),
    kpi: kpi ? {
      demo: kpi.demo,
      errorRate: { now: lastPoint(kpi.errorRate), before: firstPoint(kpi.errorRate), series: kpi.errorRate },
      p95: { now: lastPoint(kpi.p95), before: firstPoint(kpi.p95), series: kpi.p95 },
      rps: { series: kpi.rps },
    } : null,
    topErrors: svc ? [...svc.list].filter((x) => x.rps > 0).sort((a, b) => b.errorRate - a.errorRate).slice(0, 5) : [],
    env, envs: (v(15) || []).map((r) => r.metric.env).filter(Boolean).sort(),
    // for "Needs your attention": real hosts only, null when the query failed (shown as unavailable, never as zero)
    diskHot: v(16) ? v(16).map((r) => ({ host: r.metric.host || r.metric.instance || 'unknown', usedPct: Number(r.value?.[1]) })).sort((x, y) => y.usedPct - x.usedPct) : null,
    hostsDown: v(17) ? v(17).map((r) => r.metric.host || r.metric.instance || 'unknown') : null,
  });
}));

// ---------------- Service detail ----------------
const DEMO_DEPS = {
  'api-gateway': ['mule-app', 'user-service', 'cart-service', 'catalog-service', 'search-service'],
  'mule-app': ['payment-service', 'order-service', 'notification'],
  'payment-service': ['auth-service', 'database'],
  'order-service': ['inventory', 'shipping-service', 'notification', 'database'],
  'cart-service': ['pricing-service', 'catalog-service'],
  'catalog-service': ['pricing-service', 'review-service', 'recommendation'],
  'notification': ['email-service'],
  'user-service': ['auth-service', 'database'],
};

api.get('/services/:name', wrap(async (req, res) => {
  const name = String(req.params.name);
  if (!/^[\w.:-]{1,128}$/.test(name)) throw httpError(400, 'Bad service name');
  const { start, end, step } = timeRange(req);
  const now = await servicesNow();
  const svc = now.list.find((x) => x.name === name);
  if (!svc) throw httpError(404, `Service "${name}" not found`);
  const [rps, errorRate, p95] = await Promise.all(['rps', 'errorRate', 'p95'].map((m) => servicesSeries(m, start, end, step, [name]).catch(() => ({ result: [] }))));
  const pts = (d) => (d.result?.[0]?.values || []).map(([t, x]) => [t, x === null ? null : Number(x)]);
  const errPts = pts(errorRate);
  const okShare = errPts.length ? (errPts.filter(([, x]) => x !== null && x < 5).length / errPts.length) * 100 : null;
  let calls = [], calledBy = [];
  if (now.demo) {
    calls = DEMO_DEPS[name] || [];
    calledBy = Object.entries(DEMO_DEPS).filter(([, list]) => list.includes(name)).map(([k]) => k);
  }
  const stat = (n) => { const x = now.list.find((s) => s.name === n); return { name: n, status: x?.status || 'external', errorRate: x?.errorRate ?? null, rps: x?.rps ?? null }; };
  res.json({
    demo: now.demo, service: svc, uptime: svc.status === 'down' ? 0 : okShare,
    series: { rps: pts(rps), errorRate: errPts, p95: pts(p95) },
    dependencies: { calls: calls.map(stat), calledBy: calledBy.map(stat), known: now.demo },
  });
}));

// ---------------- Services ----------------
function servicesCfg() {
  return JSON.parse(fs.readFileSync(path.join(config.configDir, 'services.json'), 'utf8'));
}

function summarize(list) {
  const totalRps = list.reduce((a, s) => a + (s.rps || 0), 0);
  const weightedErr = totalRps ? list.reduce((a, s) => a + (s.rps || 0) * (s.errorRate || 0), 0) / totalRps : 0;
  return {
    total: list.length,
    healthy: list.filter((s) => s.status === 'healthy').length,
    degraded: list.filter((s) => s.status === 'degraded').length,
    down: list.filter((s) => s.status === 'down').length,
    totalRps,
    errorRate: weightedErr,
  };
}

async function servicesNow(offsetSec = 0) {
  const mode = ds('services').mode;
  if (mode === 'demo') {
    const list = demoServices(nowSec() - offsetSec);
    return { demo: true, list, summary: summarize(list) };
  }
  const c = servicesCfg();
  const L = c.serviceLabel;
  const [rps, err, p95] = await Promise.all([promInstant(c.rps), promInstant(c.errorRate).catch(() => []), promInstant(c.p95).catch(() => [])]);
  const map = new Map();
  const get = (name) => map.get(name) || map.set(name, { name, namespace: '', rps: 0, errorRate: 0, p95: null }).get(name);
  rps.forEach((r) => (get(r.metric[L] || '(none)').rps = Number(r.value[1])));
  err.forEach((r) => { const x = Number(r.value[1]); get(r.metric[L] || '(none)').errorRate = Number.isFinite(x) ? x : 0; });
  p95.forEach((r) => { const x = Number(r.value[1]); get(r.metric[L] || '(none)').p95 = Number.isFinite(x) ? x : null; });
  const t = c.thresholds;
  const list = [...map.values()].map((s) => ({
    ...s,
    status: s.rps === 0 || s.errorRate >= t.downErrorRate || (s.p95 ?? 0) >= t.downP95Ms ? 'down'
      : s.errorRate >= t.degradedErrorRate || (s.p95 ?? 0) >= t.degradedP95Ms ? 'degraded' : 'healthy',
  }));
  return { demo: false, list, summary: summarize(list) };
}

async function servicesSeries(metric, start, end, step, names) {
  if (ds('services').mode === 'demo') return { demo: true, result: demoServiceSeries(metric, start, end, step, names) };
  const c = servicesCfg();
  const q = metric === 'rps' ? c.rps : metric === 'p95' ? c.p95 : c.errorRate;
  const top = names?.length ? `{${c.serviceLabel}=~"${names.map((n) => n.replace(/[^\w.-]/g, '')).join('|')}"}` : '';
  const query = top ? `(${q}) and on(${c.serviceLabel}) (group by (${c.serviceLabel}) (${q}))` : `topk(5, ${q})`;
  const d = await prom('/api/v1/query_range', { query, start, end, step });
  return { demo: false, label: c.serviceLabel, result: d.result.map((r) => ({ metric: { service: r.metric[c.serviceLabel] }, values: r.values })) };
}

api.get('/services', wrap(async (req, res) => {
  res.json(await servicesNow());
}));

// ---------------- Logs ----------------
function normLevel(labels, line) {
  const l = (labels.level || labels.detected_level || labels.severity || '').toUpperCase();
  if (l) return l.startsWith('WARN') ? 'WARN' : l.startsWith('ERR') || l === 'CRITICAL' || l === 'FATAL' ? 'ERROR' : l;
  const m = /\b(ERROR|ERR|FATAL|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/i.exec(line);
  if (!m) return 'INFO';
  const x = m[1].toUpperCase();
  return x.startsWith('WARN') ? 'WARN' : x === 'ERR' || x === 'FATAL' ? 'ERROR' : x;
}

api.get('/logs', wrap(async (req, res) => {
  const { start, end } = timeRange(req);
  const query = String(req.query.query || '{service_name=~".+"}');
  const limit = Math.min(2000, num(req.query.limit, 500));
  const d = ds('loki');
  let entries, demo = false;
  if (d.mode === 'demo') {
    entries = demoLogs({ query, start, end, limit });
    demo = true;
  } else {
    const params = new URLSearchParams({ query, start: `${start}000000000`, end: `${end}000000000`, limit: String(limit), direction: 'backward' });
    const r = await fetchJson(`${d.url}/loki/api/v1/query_range?${params}`);
    entries = [];
    for (const s of r.data?.result || []) {
      const lb = s.stream || {};
      for (const [ns, line] of s.values) {
        entries.push({
          ts: Math.floor(Number(ns) / 1e6),
          level: normLevel(lb, line),
          service: lb.service_name || lb.app || lb.service || lb.job || lb.container || '',
          namespace: lb.namespace || lb.k8s_namespace_name || '',
          pod: lb.pod || lb.k8s_pod_name || lb.host || lb.host_name || lb.instance || '',
          message: line,
          labels: lb,
          id: `${ns}-${lb.service_name || ''}`,
          traceId: lb.trace_id || lb.traceid || lb.traceID || (/trace_?id["'=:\s]+([0-9a-f]{16,32})/i.exec(line) || [])[1] || null,
        });
      }
    }
    entries.sort((a, b) => b.ts - a.ts);
    entries = entries.slice(0, limit);
  }
  const counts = { ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0 };
  for (const e of entries) counts[e.level] = (counts[e.level] || 0) + 1;
  res.json({ demo, entries, counts });
}));

// lines just before and after one log line, same service (Log details > Context)
api.get('/logs/context', wrap(async (req, res) => {
  const ts = num(req.query.ts, 0);
  const service = String(req.query.service || '').replace(/[^\w.:-]/g, '');
  if (!ts || !service) throw httpError(400, 'ts and service are required');
  const start = Math.floor(ts / 1000) - 60, end = Math.floor(ts / 1000) + 60;
  const d = ds('loki');
  let entries;
  if (d.mode === 'demo') entries = demoLogs({ query: `{service_name="${service}"}`, start, end, limit: 200 });
  else {
    const params = new URLSearchParams({ query: `{service_name="${service}"}`, start: `${start}000000000`, end: `${end}000000000`, limit: '200', direction: 'backward' });
    const r = await fetchJson(`${d.url}/loki/api/v1/query_range?${params}`);
    entries = [];
    for (const st of r.data?.result || []) for (const [ns, line] of st.values) entries.push({ ts: Math.floor(Number(ns) / 1e6), level: normLevel(st.stream || {}, line), service, message: line });
  }
  entries.sort((a, b) => a.ts - b.ts);
  const i = entries.findIndex((e) => e.ts >= ts);
  const at = i < 0 ? entries.length - 1 : i;
  res.json({ demo: d.mode === 'demo', entries: entries.slice(Math.max(0, at - 10), at + 11) });
}));

// ---------------- Traces ----------------
function parseTraceQuery(q) {
  const tags = {};
  for (const m of String(q || '').matchAll(/([\w.]+)\s*=\s*("[^"]*"|\S+)/g)) tags[m[1]] = m[2].replace(/^"|"$/g, '');
  return tags;
}

function attr(attrs, key) {
  const a = (attrs || []).find((x) => x.key === key);
  if (!a) return undefined;
  const v = a.value || {};
  return v.stringValue ?? v.intValue ?? v.boolValue ?? v.doubleValue;
}

api.get('/traces', wrap(async (req, res) => {
  const { start, end } = timeRange(req);
  const tags = parseTraceQuery(req.query.query);
  const limit = Math.min(100, num(req.query.limit, 20));
  const minDur = num(req.query.minDurationMs, 0);
  const d = ds('tempo');
  if (d.mode === 'demo') {
    return res.json({ demo: true, traces: demoTraceSearch({ service: tags['service.name'], start, end, limit, minDurationMs: minDur }) });
  }
  const p = new URLSearchParams({ limit: String(limit), start: String(start), end: String(end) });
  const tagStr = Object.entries(tags).map(([k, v]) => `${k}=${/\s/.test(v) ? `"${v}"` : v}`).join(' ');
  if (tagStr) p.set('tags', tagStr);
  if (minDur) p.set('minDuration', `${minDur}ms`);
  const r = await fetchJson(`${d.url}/api/search?${p}`);
  res.json({
    demo: false,
    traces: (r.traces || []).map((t) => ({
      traceId: t.traceID, rootService: t.rootServiceName, rootName: t.rootTraceName,
      startMs: Math.floor(Number(t.startTimeUnixNano) / 1e6), durationMs: t.durationMs ?? 0, error: null,
      spanCount: t.spanSet?.matched ?? null,
    })),
  });
}));

api.get('/traces/:id', wrap(async (req, res) => {
  const id = String(req.params.id);
  if (!/^[0-9a-fA-F]{8,64}$/.test(id)) throw httpError(400, 'Bad trace id');
  const d = ds('tempo');
  if (d.mode === 'demo') return res.json({ demo: true, ...buildTrace(id) });
  const r = await fetchJson(`${d.url}/api/traces/${id}`);
  const batches = r.batches || r.resourceSpans || r.trace?.resourceSpans || [];
  const spans = [];
  for (const b of batches) {
    const svc = attr(b.resource?.attributes, 'service.name') || 'unknown';
    for (const ss of b.scopeSpans || b.instrumentationLibrarySpans || []) {
      for (const s of ss.spans || []) {
        const st = Number(s.startTimeUnixNano) / 1e6;
        spans.push({
          spanId: s.spanId, parentId: s.parentSpanId || null, service: svc, name: s.name,
          startMs: st, durationMs: Number(s.endTimeUnixNano) / 1e6 - st,
          error: s.status?.code === 2 || s.status?.code === 'STATUS_CODE_ERROR',
          statusMessage: s.status?.message,
        });
      }
    }
  }
  if (!spans.length) throw httpError(404, 'Trace not found');
  spans.sort((a, b) => a.startMs - b.startMs);
  const startMs = spans[0].startMs;
  const durationMs = Math.max(...spans.map((s) => s.startMs + s.durationMs)) - startMs;
  res.json({ demo: false, traceId: id, startMs, durationMs, error: spans.some((s) => s.error), spans });
}));

// ---------------- Alerts ----------------
api.get('/alerts', wrap(async (req, res) => {
  const [alerts, silences] = await Promise.all([am('/api/v2/alerts'), am('/api/v2/silences')]);
  res.json({
    alerts: alerts.map((a) => ({
      fingerprint: a.fingerprint, name: a.labels.alertname, severity: a.labels.severity || 'none',
      state: a.status.state, silencedBy: a.status.silencedBy, inhibitedBy: a.status.inhibitedBy,
      startsAt: a.startsAt, summary: a.annotations.summary || '', description: a.annotations.description || '',
      labels: a.labels,
    })).sort((a, b) => (b.startsAt || '').localeCompare(a.startsAt || '')),
    silences: silences.filter((s) => s.status.state !== 'expired' || Date.now() - Date.parse(s.endsAt) < 86400_000)
      .map((s) => ({ id: s.id, state: s.status.state, matchers: s.matchers, createdBy: s.createdBy, comment: s.comment, startsAt: s.startsAt, endsAt: s.endsAt }))
      .sort((a, b) => b.startsAt.localeCompare(a.startsAt)),
  });
}));

api.get('/alerts/count', wrap(async (req, res) => {
  const a = await am('/api/v2/alerts?active=true&silenced=false&inhibited=false');
  res.json({ active: a.length, critical: a.filter((x) => x.labels.severity === 'critical').length });
}));

api.get('/rules', wrap(async (req, res) => {
  const d = await prom('/api/v1/rules', { type: 'alert' });
  const custom = new Set(readUiRules().map((r) => r.alert));
  const rules = [];
  for (const g of d.groups) {
    for (const r of g.rules) {
      rules.push({
        group: g.name, name: r.name, query: r.query, duration: r.duration, state: r.state,
        severity: r.labels?.severity || 'none', summary: r.annotations?.summary || '',
        firing: (r.alerts || []).filter((a) => a.state === 'firing').length,
        lastEvaluation: r.lastEvaluation, health: r.health, lastError: r.lastError,
        custom: g.name === 'ui-rules' && custom.has(r.name),
      });
    }
  }
  res.json({ rules, editable: !!config.rulesFile });
}));

api.post('/silences', requirePerm('alerts.silence'), wrap(async (req, res) => {
  const { matchers, hours = 2, comment } = req.body || {};
  if (!Array.isArray(matchers) || !matchers.length) throw httpError(400, 'matchers required');
  const h = Math.min(168, Math.max(0.25, Number(hours) || 2));
  const body = {
    matchers: matchers.map((m) => ({ name: String(m.name), value: String(m.value), isRegex: false, isEqual: true })),
    startsAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + h * 3600_000).toISOString(),
    createdBy: req.user.username,
    comment: String(comment || 'Silenced from ObservaOne').slice(0, 500),
  };
  const r = await am('/api/v2/silences', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  audit(req, 'silence.create', { matchers: body.matchers, hours: h, id: r.silenceID });
  res.json({ id: r.silenceID });
}));

api.delete('/silences/:id', requirePerm('alerts.silence'), wrap(async (req, res) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw httpError(400, 'bad id');
  await am(`/api/v2/silence/${id}`, { method: 'DELETE' });
  audit(req, 'silence.expire', { id });
  res.json({ ok: true });
}));

api.get('/notifications', wrap(async (req, res) => {
  const s = await am('/api/v2/status');
  const cfg = YAML.parse(s.config?.original || '') || {};
  const receivers = (cfg.receivers || []).map((r) => ({
    name: r.name,
    channels: Object.keys(r).filter((k) => k.endsWith('_configs')).map((k) => ({
      type: k.replace('_configs', ''),
      targets: (r[k] || []).map((c) => c.to || c.channel || c.url || c.api_url || '(configured)'),
    })),
  }));
  res.json({ receivers, route: { receiver: cfg.route?.receiver, groupBy: cfg.route?.group_by, repeat: cfg.route?.repeat_interval } });
}));

// --- alert rules created in the UI (written to a rules file, Prometheus reloads it) ---
function readUiRules() {
  if (!config.rulesFile || !fs.existsSync(config.rulesFile)) return [];
  const doc = YAML.parse(fs.readFileSync(config.rulesFile, 'utf8')) || {};
  return doc.groups?.find((g) => g.name === 'ui-rules')?.rules || [];
}

async function writeUiRulesAndReload(rules) {
  const old = fs.existsSync(config.rulesFile) ? fs.readFileSync(config.rulesFile, 'utf8') : null;
  const text = '# Managed by ObservaOne UI - edits here may be overwritten\n' + YAML.stringify({ groups: [{ name: 'ui-rules', rules }] });
  fs.writeFileSync(config.rulesFile, text);
  const reload = async () => {
    const r = await fetch(`${ds('prometheus').url}/-/reload`, { method: 'POST' });
    if (!r.ok) throw httpError(400, `Prometheus rejected the rule: ${(await r.text()).slice(0, 300)}`);
  };
  try {
    await reload();
  } catch (e) {
    if (old === null) fs.unlinkSync(config.rulesFile);
    else fs.writeFileSync(config.rulesFile, old);
    await reload().catch(() => {});
    throw e;
  }
}

api.post('/rules', requirePerm('alerts.rules'), wrap(async (req, res) => {
  if (!config.rulesFile) throw httpError(400, 'Rule editing is off (UI_RULES_FILE not set).');
  const { name, expr, forMinutes = 5, severity = 'warning', summary = '', description = '' } = req.body || {};
  if (!/^[A-Za-z][A-Za-z0-9_]{2,63}$/.test(name || '')) throw httpError(400, 'Name: 3-64 letters, numbers or _ , starting with a letter (e.g. HighCpuAppServers).');
  if (!['critical', 'warning', 'info'].includes(severity)) throw httpError(400, 'Severity must be critical, warning or info.');
  if (!expr || String(expr).length > 2000) throw httpError(400, 'Query is required.');
  await prom('/api/v1/query', { query: expr }).catch((e) => { throw httpError(400, `Query error: ${e.message}`); });
  const rules = readUiRules();
  if (rules.some((r) => r.alert === name)) throw httpError(409, 'A rule with this name already exists.');
  rules.push({
    alert: name, expr: String(expr), for: `${Math.max(0, Math.min(1440, Number(forMinutes) || 0))}m`,
    labels: { severity, created_by: req.user.username },
    annotations: { summary: String(summary).slice(0, 300) || name, description: String(description).slice(0, 1000) },
  });
  await writeUiRulesAndReload(rules);
  audit(req, 'rule.create', { name, expr, severity });
  res.json({ ok: true });
}));

api.delete('/rules/:name', requirePerm('alerts.rules'), wrap(async (req, res) => {
  if (!config.rulesFile) throw httpError(400, 'Rule editing is off.');
  const rules = readUiRules();
  const left = rules.filter((r) => r.alert !== req.params.name);
  if (left.length === rules.length) throw httpError(404, 'Only rules created in this UI can be deleted here.');
  await writeUiRulesAndReload(left);
  audit(req, 'rule.delete', { name: req.params.name });
  res.json({ ok: true });
}));

// ---------------- Dashboards ----------------
// System dashboards are JSON files (config/dashboards); custom ones live in PostgreSQL.
function builtinDashboards() {
  const dir = path.join(config.configDir, 'dashboards');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({
    ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), kind: 'system',
  }));
}

// Who can see a custom dashboard:
//   private  -> only the owner
//   team     -> owner + members of the chosen team
//   everyone -> every signed-in user
// Admins (users.manage) see and manage all of them. Only the owner or an admin can change one.
const VISIBILITY = ['private', 'team', 'everyone'];
const isAdmin = (req) => hasPerm(req.user, 'users.manage');
const sameUser = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

async function myTeams(req) {
  if (!req.userId) return [];
  const { rows } = await q(`SELECT t.id, t.name FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = $1 ORDER BY lower(t.name)`, [req.userId]);
  return rows.map((t) => ({ id: Number(t.id), name: t.name }));
}

function rowToDash(r, req) {
  const mine = sameUser(r.owner, req?.user?.username);
  return {
    id: r.id, title: r.title, description: r.description, owner: r.owner, tags: r.tags,
    variables: r.variables, panels: r.panels, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(), kind: 'custom',
    visibility: r.visibility, teamId: r.team_id === null || r.team_id === undefined ? null : Number(r.team_id), teamName: r.team_name || null,
    copiedFrom: r.copied_from || null,
    mine, editable: !!req && hasPerm(req.user, 'dashboards.edit') && (mine || isAdmin(req)),
  };
}

// SQL filter for "dashboards this user may see"; $1 = username, $2 = user id
const VISIBLE_SQL = `(lower(d.owner) = lower($1) OR d.visibility = 'everyone'
  OR (d.visibility = 'team' AND d.team_id IN (SELECT team_id FROM team_members WHERE user_id = $2)))`;
const DASH_SELECT = 'SELECT d.*, t.name AS team_name FROM dashboards d LEFT JOIN teams t ON t.id = d.team_id';

async function customDashboards(req) {
  const { rows } = isAdmin(req)
    ? await q(`${DASH_SELECT} ORDER BY lower(d.title)`)
    : await q(`${DASH_SELECT} WHERE ${VISIBLE_SQL} ORDER BY lower(d.title)`, [req.user.username, req.userId ?? -1]);
  return rows.map((r) => rowToDash(r, req));
}

async function findDashboard(id, req) {
  const b = builtinDashboards().find((x) => x.id === id);
  if (b) return { ...b, editable: false, mine: false, visibility: 'everyone' };
  const r = isAdmin(req)
    ? await one(`${DASH_SELECT} WHERE d.id = $1`, [id])
    : await one(`${DASH_SELECT} WHERE d.id = $3 AND ${VISIBLE_SQL}`, [req.user.username, req.userId ?? -1, id]);
  return r ? rowToDash(r, req) : null;
}

// the dashboard, if this user may change it (404 when they cannot even see it, 403 when read-only for them)
async function editableDashboard(id, req) {
  const d = await findDashboard(id, req);
  if (!d) throw httpError(404, 'Dashboard not found');
  if (d.kind === 'system') throw httpError(403, 'System dashboards are read-only. Use "Copy" to make your own version.');
  if (!d.editable) throw httpError(403, `Only the owner (${d.owner}) or an admin can change this dashboard. Use "Copy" to make your own version.`);
  return d;
}

async function favoriteIds(req) {
  if (!req.userId) return new Set();
  const { rows } = await q('SELECT dashboard_id FROM dashboard_favorites WHERE user_id = $1', [req.userId]);
  return new Set(rows.map((r) => r.dashboard_id));
}

async function checkSharing(req, visibility, teamId) {
  if (!VISIBILITY.includes(visibility)) throw httpError(400, `Visibility must be one of: ${VISIBILITY.join(', ')}`);
  if (visibility !== 'team') return null;
  const id = Number(teamId);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'Pick a team to share with.');
  const t = await one('SELECT id FROM teams WHERE id = $1', [id]);
  if (!t) throw httpError(400, 'That team does not exist.');
  if (!isAdmin(req) && !(await myTeams(req)).some((x) => x.id === id)) throw httpError(403, 'You can only share with teams you are a member of.');
  return id;
}

api.get('/dashboards', wrap(async (req, res) => {
  const favs = await favoriteIds(req);
  const all = [
    ...builtinDashboards().map((d) => ({ ...d, editable: false, mine: false, visibility: 'everyone' })),
    ...(await customDashboards(req)),
  ];
  res.json(all.map(({ panels, ...d }) => ({ ...d, favorite: favs.has(d.id), panelCount: panels?.length || 0, preview: panels?.find((p) => p.type !== 'stat' && p.type !== 'table') || panels?.[0] || null })));
}));

api.get('/dashboards/:id', wrap(async (req, res) => {
  const d = await findDashboard(req.params.id, req);
  if (!d) return res.status(404).json({ error: 'Dashboard not found' });
  d.favorite = (await favoriteIds(req)).has(d.id);
  res.json(d);
}));

const PANEL_TYPES = ['line', 'area', 'bar', 'stat', 'gauge', 'table'];
const UNITS = ['none', 'percent', 'bytes', 'bps', 'Bps', 's', 'ms', 'reqps', 'iops', 'short'];
function cleanPanel(p) {
  if (!p || typeof p.query !== 'string' || !p.query.trim()) throw httpError(400, 'Panel query is required');
  return {
    title: String(p.title || 'New panel').slice(0, 80),
    type: PANEL_TYPES.includes(p.type) ? p.type : 'line',
    query: p.query.slice(0, 2000),
    legend: String(p.legend || '').slice(0, 100),
    unit: UNITS.includes(p.unit) ? p.unit : 'none',
    w: [3, 4, 6, 8, 12].includes(Number(p.w)) ? Number(p.w) : 6,
  };
}

function cleanTitle(title) {
  const t = String(title || '').trim();
  if (!t || t.length > 60) throw httpError(400, 'Title is required (max 60 chars).');
  return t;
}

async function insertDashboard(req, { title, description = '', visibility = 'private', teamId = null, tags, variables = [], panels = [], copiedFrom = null }) {
  const team = await checkSharing(req, visibility, teamId);
  const id = `c-${crypto.randomBytes(5).toString('hex')}`;
  await q(`INSERT INTO dashboards (id, title, description, owner, visibility, team_id, tags, variables, panels, copied_from)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
  [id, cleanTitle(title), String(description).slice(0, 200), req.user.username, visibility, team,
    JSON.stringify(tags || ['custom']), JSON.stringify(variables), JSON.stringify(panels), copiedFrom]);
  return findDashboard(id, req);
}

api.post('/dashboards', requirePerm('dashboards.edit'), wrap(async (req, res) => {
  const b = req.body || {};
  const d = await insertDashboard(req, { title: b.title, description: b.description, visibility: b.visibility || 'private', teamId: b.teamId });
  audit(req, 'dashboard.create', { id: d.id, title: d.title, visibility: d.visibility });
  res.json(d);
}));

// copy any dashboard you can see (system ones included) into a new one you own
api.post('/dashboards/:id/copy', requirePerm('dashboards.edit'), wrap(async (req, res) => {
  const src = await findDashboard(req.params.id, req);
  if (!src) throw httpError(404, 'Dashboard not found');
  const b = req.body || {};
  const d = await insertDashboard(req, {
    title: b.title || `${src.title} (my copy)`.slice(0, 60), description: src.description || '',
    visibility: b.visibility || 'private', teamId: b.teamId,
    tags: [...new Set([...(src.tags || []).filter((t) => t !== 'system'), 'custom'])],
    variables: src.variables || [], panels: (src.panels || []).map(cleanPanel), copiedFrom: src.id,
  });
  audit(req, 'dashboard.copy', { id: d.id, from: src.id });
  res.json(d);
}));

// rename / change description / change who can see it
api.put('/dashboards/:id', requirePerm('dashboards.edit'), wrap(async (req, res) => {
  const cur = await editableDashboard(req.params.id, req);
  const b = req.body || {};
  const visibility = b.visibility ?? cur.visibility;
  const team = await checkSharing(req, visibility, b.teamId ?? cur.teamId);
  await q(`UPDATE dashboards SET title = $2, description = $3, visibility = $4, team_id = $5, updated_at = now() WHERE id = $1`,
    [cur.id, b.title !== undefined ? cleanTitle(b.title) : cur.title, String(b.description ?? cur.description).slice(0, 200), visibility, team]);
  // an admin can hand a dashboard to someone else
  if (b.owner && isAdmin(req) && !sameUser(b.owner, cur.owner)) {
    const u = await one('SELECT username FROM users WHERE lower(username) = lower($1)', [String(b.owner)]);
    if (!u) throw httpError(400, 'No such user.');
    await q('UPDATE dashboards SET owner = $2 WHERE id = $1', [cur.id, u.username]);
  }
  audit(req, 'dashboard.update', { id: cur.id, visibility, teamId: team });
  res.json(await findDashboard(cur.id, req));
}));

// panels: add, change, move, remove
api.post('/dashboards/:id/panels', requirePerm('dashboards.edit'), wrap(async (req, res) => {
  const cur = await editableDashboard(req.params.id, req);
  const panel = cleanPanel(req.body);
  await q('UPDATE dashboards SET panels = panels || $2::jsonb, updated_at = now() WHERE id = $1', [cur.id, JSON.stringify([panel])]);
  audit(req, 'dashboard.panel.add', { id: cur.id, title: panel.title });
  res.json(await findDashboard(cur.id, req));
}));

// replace the full panel list (used for reorder, resize and edit)
api.put('/dashboards/:id/panels', requirePerm('dashboards.edit'), wrap(async (req, res) => {
  const cur = await editableDashboard(req.params.id, req);
  if (!Array.isArray(req.body?.panels) || req.body.panels.length > 60) throw httpError(400, 'panels must be a list (max 60).');
  const panels = req.body.panels.map(cleanPanel);
  await q('UPDATE dashboards SET panels = $2::jsonb, updated_at = now() WHERE id = $1', [cur.id, JSON.stringify(panels)]);
  audit(req, 'dashboard.panels.update', { id: cur.id, count: panels.length });
  res.json(await findDashboard(cur.id, req));
}));

api.delete('/dashboards/:id/panels/:idx', requirePerm('dashboards.edit'), wrap(async (req, res) => {
  const idx = Number(req.params.idx);
  if (!Number.isInteger(idx) || idx < 0) throw httpError(400, 'Bad panel index');
  const cur = await editableDashboard(req.params.id, req);
  await q('UPDATE dashboards SET panels = panels - $2::int, updated_at = now() WHERE id = $1', [cur.id, idx]);
  audit(req, 'dashboard.panel.delete', { id: cur.id, idx });
  res.json(await findDashboard(cur.id, req));
}));

api.delete('/dashboards/:id', requirePerm('dashboards.edit'), wrap(async (req, res) => {
  const cur = await editableDashboard(req.params.id, req);
  await q('DELETE FROM dashboards WHERE id = $1', [cur.id]);
  await q('DELETE FROM dashboard_favorites WHERE dashboard_id = $1', [cur.id]);
  audit(req, 'dashboard.delete', { id: cur.id });
  res.json({ ok: true });
}));

// star / unstar (any signed-in user, any dashboard they can see)
api.put('/dashboards/:id/favorite', requireUser, wrap(async (req, res) => {
  const d = await findDashboard(req.params.id, req);
  if (!d) throw httpError(404, 'Dashboard not found');
  if (req.body?.favorite === false) await q('DELETE FROM dashboard_favorites WHERE user_id = $1 AND dashboard_id = $2', [req.userId, d.id]);
  else await q('INSERT INTO dashboard_favorites (user_id, dashboard_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.userId, d.id]);
  res.json({ ok: true, favorite: req.body?.favorite !== false });
}));

// ---------------- Data sources ----------------
api.get('/datasources', (req, res) => {
  res.json(Object.values(getDatasources()).map(({ id, name, kind, url, mode, modes, publicUrl }) => ({ id, name, kind, url, mode, modes, publicUrl })));
});

api.post('/datasources/:id/test', wrap(async (req, res) => {
  res.json(await testDatasource(req.params.id));
}));

api.put('/datasources/:id', requirePerm('integrations.manage'), wrap(async (req, res) => {
  await updateDatasource(req.params.id, req.body || {}, req.user.username);
  audit(req, 'datasource.update', { id: req.params.id, url: req.body?.url, mode: req.body?.mode });
  res.json(await testDatasource(req.params.id));
}));

// ---------------- Users & audit (admin) ----------------
// short list of usernames for pickers (teams, on-call, incident owner) - any signed-in user
api.get('/users/names', wrap(async (req, res) => {
  const { rows } = await q('SELECT username, display_name FROM users WHERE NOT disabled ORDER BY lower(username)');
  res.json(rows.map((r) => ({ username: r.username, displayName: r.display_name })));
}));

api.get('/users', requirePerm('users.manage'), wrap(async (req, res) => {
  const roles = await loadRoles();
  res.json({ users: await listUsers(), roles: [...roles.keys()] });
}));

api.post('/users', requirePerm('users.manage'), wrap(async (req, res) => {
  await createUser(req.body || {}, req.user.permissions);
  audit(req, 'user.create', { target: req.body?.username, role: req.body?.role });
  res.json({ ok: true });
}));

api.put('/users/:username', requirePerm('users.manage'), wrap(async (req, res) => {
  const { role, password, disabled, email, displayName, phone, resetMfa } = req.body || {};
  if (req.params.username === req.user.username && (disabled || (role && role !== req.user.role))) {
    throw httpError(400, 'You cannot disable yourself or change your own role.');
  }
  await updateUser(req.params.username, { role, password, disabled, email, displayName, phone, resetMfa: !!resetMfa }, req.user.permissions);
  audit(req, 'user.update', { target: req.params.username, role, disabled, passwordReset: password !== undefined, mfaReset: !!resetMfa });
  res.json({ ok: true });
}));

api.delete('/users/:username', requirePerm('users.manage'), wrap(async (req, res) => {
  if (req.params.username === req.user.username) throw httpError(400, 'You cannot delete yourself.');
  await deleteUser(req.params.username);
  audit(req, 'user.delete', { target: req.params.username });
  res.json({ ok: true });
}));

// all active sign-ins (admin can end any of them)
api.get('/sessions', requirePerm('users.manage'), wrap(async (req, res) => {
  res.json(await listSessions({ userId: null, currentHash: req.sessionHash }));
}));
api.delete('/sessions/:id', requirePerm('users.manage'), wrap(async (req, res) => {
  await revokeSession({ shortId: req.params.id, userId: null });
  audit(req, 'session.revoke', { session: req.params.id, byAdmin: true });
  res.json({ ok: true });
}));

api.get('/audit', requirePerm('audit.read'), wrap(async (req, res) => {
  res.json(await readAudit({ limit: num(req.query.limit, 300), user: req.query.user, action: req.query.action, before: req.query.before }));
}));

api.use(accessRouter);
for (const r of extraRouters.private) api.use(r);

// ---------------- API reference (built from the routes themselves) ----------------
const DOCS = {
  'GET /prom/query': 'Run a PromQL instant query. ?query=',
  'GET /prom/query_range': 'Run a PromQL range query. ?query=&start=&end=&step=',
  'GET /alerts': 'Current alerts and silences',
  'POST /silences': 'Silence alerts. {matchers:[{name,value}], hours, comment}',
  'GET /services': 'Service health list',
  'GET /logs': 'Search logs. ?query=<LogQL>&start=&end=&limit=',
  'GET /traces': 'Search traces. ?query=service.name=x',
  'GET /dashboards': 'List dashboards',
};
function collectRoutes(router, out = []) {
  for (const layer of router.stack || []) {
    if (layer.route) {
      const perm = layer.route.stack.map((l) => l.handle?._perm).find(Boolean) || 'signed-in';
      for (const m of Object.keys(layer.route.methods)) {
        if (m === '_all') continue;
        const key = `${m.toUpperCase()} ${layer.route.path}`;
        out.push({ method: m.toUpperCase(), path: `/api${layer.route.path}`, permission: perm, description: DOCS[key] || '' });
      }
    } else if (layer.handle?.stack) {
      collectRoutes(layer.handle, out);
    }
  }
  return out;
}
api.get('/docs', (req, res) => {
  const seen = new Set();
  const routes = collectRoutes(api).filter((r) => {
    const k = `${r.method} ${r.path}`;
    if (seen.has(k) || /\/(login|auth)\b/.test(r.path)) return false;
    seen.add(k);
    return true;
  });
  res.json({ permissions: PERMISSIONS, auth: 'Send "Authorization: Bearer <api key>". Create keys in Settings > API keys.', routes });
});

// ---------------- errors ----------------
api.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(`[api] ${req.method} ${req.originalUrl}: ${err.stack || err.message}`);
  res.status(status).json({ error: status >= 500 && !err.status ? 'Internal error' : err.message, ...(err.extra || {}) });
});
