// All /api routes.
import { tenantContext } from './tenancy.js';
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
  listSessions, revokeSession, getPrefs, setPrefs,
} from './auth.js';
import { q, one } from './db.js';
import { ssoRouter } from './sso.js';
import { accessRouter } from './routes/access.js';
import { extraRouters } from './routes/index.js';
import { getDatasources, ds, requireConfigured, updateDatasource, testDatasource, prom, promInstant, am, fetchJson } from './datasources.js';
import { cpuByHost, memByHost, diskFreeByHost, SERVERS_UP } from './queries.js';
import { classifyService, summarizeServices, agentHostHealth } from './health.js';
import { MODULES, enabledModules, moduleSettings, setEnabledModules, requireModule } from './modules.js';
import { describeAgent } from './routes/agent-control.js';
import { currentTenant, isScoped, scopePromQL } from './tenancy.js';
import { buildExpr } from './routes/alerting.js';

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
api.use(tenantContext); // the user's tenant scopes agent lists and every Prometheus query (tenancy.js)

// ---- module guards: a disabled module's API answers 404, whatever the user's role ----
// (role permissions are still checked on each route below; both must allow the request)
api.use('/prom/targets', requireModule('infrastructure'));
api.use('/prom', requireModule('metrics', 'infrastructure', 'dashboards')); // shared Prometheus queries
api.use('/logs', requireModule('logs'));
api.use('/traces', requireModule('traces'));
api.use('/services', requireModule('services'));
for (const p of ['/alerts', '/rules', '/silences', '/notifications']) api.use(p, requireModule('alerting'));
api.use('/dashboards', requireModule('dashboards'));
for (const p of ['/agents', '/agent-tokens', '/agent-config', '/targets', '/gateways']) api.use(p, requireModule('agents'));

api.post('/logout', wrap(async (req, res) => {
  audit(req, 'logout');
  await logout(req, res);
  res.json({ ok: true });
}));

api.get('/me', wrap(async (req, res) => {
  res.json({
    user: req.user,
    brand: config.brand,
    sessionIdleMinutes: config.sessionIdleMinutes,
    rulesEditable: !!config.rulesFile,
    demoData: config.demoData,
    modules: await enabledModules(), // what this deployment shows; the UI also checks permissions
    prefs: await getPrefs(req.userId),
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

// Caches are kept per tenant: prom() scopes each tenant's lookup, so one tenant's answer is never served to another.
const metricNamesCache = new Map(); // tenant -> { at, names }
api.get('/prom/metric-names', wrap(async (req, res) => {
  const t = currentTenant();
  let c = metricNamesCache.get(t);
  if (!c || Date.now() - c.at > 60_000) {
    c = { at: Date.now(), names: await prom('/api/v1/label/__name__/values') };
    metricNamesCache.set(t, c);
  }
  res.json(c.names);
}));

// Every metric seen in the last hour, with its type and description when Prometheus knows them
// (scraped data has them; pushed data often does not: the type is then guessed from the name).
const metricCatalogCache = new Map(); // tenant -> { at, list }
api.get('/prom/metric-catalog', wrap(async (req, res) => {
  const t = currentTenant();
  if (!metricCatalogCache.has(t) || Date.now() - metricCatalogCache.get(t).at > 60_000) {
    const end = nowSec();
    const [names, meta] = await Promise.all([
      prom('/api/v1/label/__name__/values', { start: end - 3600, end }),
      prom('/api/v1/metadata').catch(() => ({})),
    ]);
    metricCatalogCache.set(t, {
      at: Date.now(),
      list: names.map((name) => {
        const m = meta?.[name]?.[0] || {};
        return { name, type: m.type || (/_total$/.test(name) ? 'counter' : /_bucket$/.test(name) ? 'histogram' : 'gauge'), help: m.help || '' };
      }),
    });
  }
  res.set('Cache-Control', 'no-store');
  res.json(metricCatalogCache.get(t).list);
}));

api.get('/prom/label-values', wrap(async (req, res) => {
  const label = String(req.query.label || '');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(label)) throw httpError(400, 'bad label name');
  const match = req.query.match ? [String(req.query.match)] : undefined;
  // only values seen recently (Prometheus would otherwise list every value it ever stored)
  const end = nowSec(), start = end - 3600;
  let values = await prom(`/api/v1/label/${label}/values`, { 'match[]': match, start, end });
  if (label === 'host') {
    // hosts that only exist because of agents removed on the Agents page are not offered any more
    try {
      const known = new Set((await q('SELECT id FROM agents')).rows.map((r) => r.id));
      // a host is offered when a server reported "up" in the last hour (scraped, or an agent that still exists)
      const series = await prom('/api/v1/series', { 'match[]': ['up{job=~"linux|windows"}'], start, end });
      const live = new Set(series.filter((s) => !s.agent_id || known.has(s.agent_id)).map((s) => s.host));
      values = values.filter((h) => live.has(h));
    } catch { /* keep the unfiltered list */ }
  }
  res.json(values);
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
      // silent agent = "not_reporting", never "down" (rules in health.js)
      const hh = agentHostHealth({ nowSec: now, lastSeenSec: last, upValue: up, onlineSeconds: config.agent.onlineSeconds });
      pushed.push({
        job: m.job, instance: 'agent', host: m.host || m.instance, os: m.os || '', env: m.env || '', role: m.role || '',
        health: hh.health, lastScrape: last ? new Date(last * 1000).toISOString() : null, durationMs: 0,
        lastError: hh.reason,
        source: 'agent', platform: m.platform || '', agentId: m.agent_id || null,
      });
    }
  } catch { /* Prometheus without agent data */ }

  // One row per server, whatever collects it (Prometheus scrape, ObservaOne Agent, or both).
  // Enrolled agents also bring their heartbeat state, so "the agent stopped reporting" is told apart
  // from "Prometheus cannot scrape the host". Agents enrolled but without data yet are listed too.
  let enrolled = [], known = null;
  try {
    const t = req.user?.tenant || 't_default';
    enrolled = (await q(`SELECT * FROM agents WHERE platform IN ('linux', 'windows') AND ($1 = 't_default' OR tenant_id = $1)`, [t])).rows;
    known = new Set((await q('SELECT id FROM agents')).rows.map((r) => r.id));
  } catch { /* database problem: show what Prometheus knows */ }
  const now = Date.now();
  const servers = new Map(); // host (lower case) -> merged row
  const isServer = (t) => t.job === 'linux' || t.job === 'windows';
  const merge = (t) => {
    const k = String(t.host).toLowerCase();
    const cur = servers.get(k);
    if (!cur) { servers.set(k, { ...t, collection: [t.source] }); return; }
    if (!cur.collection.includes(t.source)) cur.collection.push(t.source);
    if (t.source === 'scrape') { cur.scrapeHealth = t.health; cur.scrapeError = t.lastError; cur.instance = t.instance; }
    else Object.assign(cur, { ...t, collection: cur.collection, scrapeHealth: cur.scrapeHealth ?? (cur.source === 'scrape' ? cur.health : undefined), scrapeError: cur.scrapeError ?? (cur.source === 'scrape' ? cur.lastError : undefined) });
  };
  // data from an agent that was removed on the Agents page stays in Prometheus for a while: do not show it
  const removed = (t) => t.source === 'agent' && t.agentId && known && !known.has(t.agentId);
  for (const t of [...pulled.filter(isServer), ...pushed]) if (!removed(t)) merge(t);
  for (const a of enrolled) {
    const k = a.host.toLowerCase();
    const d = describeAgent(a, now);
    const health = { online: 'up', attention: 'up', not_reporting: 'not_reporting', offline: 'not_reporting', pending: 'unknown', blocked: 'unknown' }[d.status] || 'unknown';
    const agentInfo = { agentId: a.id, agentStatus: d.status, agentReason: d.reason || d.problems.join(' '), lastHeartbeat: a.last_heartbeat };
    const cur = servers.get(k);
    if (cur) {
      if (!cur.collection.includes('agent')) cur.collection.push('agent');
      Object.assign(cur, agentInfo);
      if (a.credential_hash) { // enrolled agent: its heartbeat decides; keep a scrape failure visible separately
        if (cur.source === 'scrape' && cur.scrapeHealth === undefined) { cur.scrapeHealth = cur.health; cur.scrapeError = cur.lastError; }
        cur.health = health;
        cur.lastError = agentInfo.agentReason;
        cur.source = 'agent';
      }
    } else if (a.credential_hash) {
      servers.set(k, {
        job: a.platform, instance: 'agent', host: a.host, os: a.platform, env: a.env, role: a.role, platform: a.platform,
        health, lastScrape: null, durationMs: 0, source: 'agent', collection: ['agent'],
        lastError: agentInfo.agentReason || 'Enrolled; no metrics received yet.', ...agentInfo,
      });
    }
  }
  // blackbox probes of agent hosts feed the Agents page diagnosis; they are not monitored components
  const probe = (t) => /^observaone-agent-(ping|port)$/.test(t.job);
  res.json([...servers.values(), ...pulled.filter((t) => !isServer(t) && !probe(t))]);
}));

// ---------------- Overview (one call for the whole page) ----------------
// Overview is a shared page: it only asks the sources behind the modules that are on.
// A part whose module is off is left out of the answer (null) and the UI does not draw it.
api.get('/overview', wrap(async (req, res) => {
  const { start, end, step } = timeRange(req);
  const on = await enabledModules();
  const off = Promise.reject(new Error('module disabled'));
  off.catch(() => {});
  const infra = on.includes('infrastructure'), alerting = on.includes('alerting'), services = on.includes('services');
  const settled = await Promise.allSettled([
    infra ? promInstant(`avg(${cpuByHost()})`) : off,
    infra ? promInstant(`avg(${cpuByHost('1h')})`) : off,
    infra ? promInstant(`avg(${memByHost()})`) : off,
    infra ? promInstant(`avg(${memByHost('1h')})`) : off,
    infra ? promInstant(cpuByHost()) : off,
    infra ? prom('/api/v1/query_range', { query: memByHost(), start, end, step }) : off,
    infra ? promInstant(`count(${SERVERS_UP})`) : off,
    infra ? promInstant(`count(${SERVERS_UP} == 0)`) : off,
    alerting ? am('/api/v2/alerts?active=true&silenced=false&inhibited=false') : off,
    services ? servicesNow() : off,
    services ? servicesSeries('rps', start, end, step) : off,
    services ? servicesSeries('p95', start, end, step) : off,
  ]);
  const v = (i) => (settled[i].status === 'fulfilled' ? settled[i].value : null);
  const err = (i) => (settled[i].status === 'rejected' ? settled[i].reason.message : null);
  const scalar = (r) => (r && r[0] ? Number(r[0].value[1]) : null);
  const svc = v(9);
  res.json({
    modules: { infrastructure: infra, alerting, services },
    cpu: { now: scalar(v(0)), before: scalar(v(1)), error: err(0) },
    mem: { now: scalar(v(2)), before: scalar(v(3)), error: err(2) },
    cpuByHost: (v(4) || []).map((r) => ({ host: r.metric.host, value: Number(r.value[1]) })).sort((a, b) => a.host.localeCompare(b.host)),
    memSeries: v(5)?.result || [],
    memError: err(5),
    // null = unknown (query failed); a real count of 0 stays 0
    servers: { total: v(6) ? (scalar(v(6)) ?? 0) : null, down: v(7) ? (scalar(v(7)) ?? 0) : null, error: err(6) },
    alerts: { active: v(8) ? v(8).length : null, critical: v(8) ? v(8).filter((a) => a.labels.severity === 'critical').length : null, error: err(8) },
    services: svc,
    servicesError: err(9),
    rpsSeries: v(10),
    rpsError: err(10),
    latSeries: v(11),
    latError: err(11),
    cpuByHostError: err(4),
  });
}));

// ---------------- Services ----------------
function servicesCfg() {
  return JSON.parse(fs.readFileSync(path.join(config.configDir, 'services.json'), 'utf8'));
}

const summarize = summarizeServices; // rules in health.js (unit-tested)

async function servicesNow() {
  const c = servicesCfg();
  const L = c.serviceLabel;
  const [rps, err, p95] = await Promise.all([promInstant(c.rps), promInstant(c.errorRate).catch(() => []), promInstant(c.p95).catch(() => [])]);
  const map = new Map();
  // null = no value reported (unknown); never turned into 0
  const get = (name) => map.get(name) || map.set(name, { name, namespace: '', rps: null, errorRate: null, p95: null }).get(name);
  const val = (r) => { const x = Number(r.value[1]); return Number.isFinite(x) ? x : null; };
  rps.forEach((r) => (get(r.metric[L] || '(none)').rps = val(r)));
  err.forEach((r) => (get(r.metric[L] || '(none)').errorRate = val(r)));
  p95.forEach((r) => (get(r.metric[L] || '(none)').p95 = val(r)));
  const t = c.thresholds;
  const list = [...map.values()].map((s) => classifyService(s, t)); // rules in health.js
  return { list, summary: summarize(list) };
}

async function servicesSeries(metric, start, end, step, names) {
  const c = servicesCfg();
  const q = metric === 'rps' ? c.rps : metric === 'p95' ? c.p95 : c.errorRate;
  const top = names?.length ? `{${c.serviceLabel}=~"${names.map((n) => n.replace(/[^\w.-]/g, '')).join('|')}"}` : '';
  const query = top ? `(${q}) and on(${c.serviceLabel}) (group by (${c.serviceLabel}) (${q}))` : `topk(5, ${q})`;
  const d = await prom('/api/v1/query_range', { query, start, end, step });
  return { label: c.serviceLabel, result: d.result.map((r) => ({ metric: { service: r.metric[c.serviceLabel] }, values: r.values })) };
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
  const d = requireConfigured('loki');
  let entries;
  {
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
        });
      }
    }
    entries.sort((a, b) => b.ts - a.ts);
  }
  // Loki stops at "limit" lines: tell the UI so it can say the list is cut, never imply it is complete
  const truncated = entries.length >= limit;
  entries = entries.slice(0, limit);
  const counts = { ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0 };
  for (const e of entries) counts[e.level] = (counts[e.level] || 0) + 1;
  res.json({ entries, counts, limit, truncated });
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
  const d = requireConfigured('tempo');
  const p = new URLSearchParams({ limit: String(limit), start: String(start), end: String(end) });
  const tagStr = Object.entries(tags).map(([k, v]) => `${k}=${/\s/.test(v) ? `"${v}"` : v}`).join(' ');
  if (tagStr) p.set('tags', tagStr);
  if (minDur) p.set('minDuration', `${minDur}ms`);
  const r = await fetchJson(`${d.url}/api/search?${p}`);
  res.json({
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
  const d = requireConfigured('tempo');
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
  res.json({ traceId: id, startMs, durationMs, error: spans.some((s) => s.error), spans });
}));

// ---------------- Alerts ----------------
// A tenant user sees only alerts on its own series (tenant label set by the server) and its own silences.
const mineAlert = (a) => !isScoped() || a.labels?.tenant === currentTenant();
const mineSilence = (s) => !isScoped() || (s.matchers || []).some((m) => m.name === 'tenant' && m.value === currentTenant() && m.isEqual !== false && !m.isRegex);

api.get('/alerts', wrap(async (req, res) => {
  const [allAlerts, allSilences] = await Promise.all([am('/api/v2/alerts'), am('/api/v2/silences')]);
  const alerts = allAlerts.filter(mineAlert), silences = allSilences.filter(mineSilence);
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
  const a = (await am('/api/v2/alerts?active=true&silenced=false&inhibited=false')).filter(mineAlert);
  res.json({ active: a.length, critical: a.filter((x) => x.labels.severity === 'critical').length, warning: a.filter((x) => x.labels.severity === 'warning').length });
}));

api.get('/rules', wrap(async (req, res) => {
  const d = await prom('/api/v1/rules', { type: 'alert' });
  const custom = new Set(readUiRules().map((r) => r.alert));
  const rules = [];
  for (const g of d.groups) {
    for (const r of g.rules) {
      // a tenant sees the platform's rules (they run on its servers too) and its own, never another tenant's
      if (isScoped() && r.labels?.tenant && r.labels.tenant !== currentTenant()) continue;
      rules.push({
        group: g.name, name: r.name, query: r.query, duration: r.duration, state: r.state,
        severity: r.labels?.severity || 'none', summary: r.annotations?.summary || '',
        firing: (r.alerts || []).filter((a) => a.state === 'firing').length,
        lastEvaluation: r.lastEvaluation, health: r.health, lastError: r.lastError,
        custom: isUiGroup(g.name) && custom.has(r.name), labels: r.labels || {}, runbook: r.annotations?.runbook_url || '',
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
    matchers: [
      ...matchers.filter((m) => !(isScoped() && m.name === 'tenant')).map((m) => ({ name: String(m.name), value: String(m.value), isRegex: false, isEqual: true })),
      ...(isScoped() ? [{ name: 'tenant', value: currentTenant(), isRegex: false, isEqual: true }] : []),
    ],
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
  if (isScoped()) {
    const s = await am(`/api/v2/silence/${id}`).catch(() => null);
    if (!s || !mineSilence(s)) throw httpError(404, 'Silence not found.');
  }
  await am(`/api/v2/silence/${id}`, { method: 'DELETE' });
  audit(req, 'silence.expire', { id });
  res.json({ ok: true });
}));

// /notifications: routes/notifications.js (channels managed in ObservaOne, written into Alertmanager's config)

// --- alert rules created in the UI (written to a rules file, Prometheus reloads it) ---
// Rules created in the UI: group "ui-rules" (Prometheus' evaluation interval) or "ui-rules-<interval>" (their own).
const EVAL_INTERVALS = ['15s', '30s', '1m', '2m', '5m', '10m'];
const isUiGroup = (name) => name === 'ui-rules' || /^ui-rules-\d+[sm]$/.test(name);
function readUiRules() {
  if (!config.rulesFile || !fs.existsSync(config.rulesFile)) return [];
  const doc = YAML.parse(fs.readFileSync(config.rulesFile, 'utf8')) || {};
  return (doc.groups || []).filter((g) => isUiGroup(g.name)).flatMap((g) => (g.rules || []).map((r) => (g.interval ? { ...r, _interval: g.interval } : r)));
}

async function writeUiRulesAndReload(rules) {
  const old = fs.existsSync(config.rulesFile) ? fs.readFileSync(config.rulesFile, 'utf8') : null;
  const byInterval = new Map();
  for (const { _interval, ...r } of rules) { const k = _interval || ''; if (!byInterval.has(k)) byInterval.set(k, []); byInterval.get(k).push(r); }
  if (!byInterval.size) byInterval.set('', []);
  const groups = [...byInterval.entries()].sort(([a], [b]) => (a ? 1 : 0) - (b ? 1 : 0) || a.localeCompare(b))
    .map(([iv, rs]) => ({ name: iv ? `ui-rules-${iv}` : 'ui-rules', ...(iv ? { interval: iv } : {}), rules: rs }));
  const text = '# Managed by ObservaOne UI - edits here may be overwritten\n' + YAML.stringify({ groups });
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
  const { name, forMinutes = 5, severity = 'warning', summary = '', description = '', runbookUrl = '', interval = '' } = req.body || {};
  if (interval && !EVAL_INTERVALS.includes(String(interval))) throw httpError(400, `Evaluation interval: one of ${EVAL_INTERVALS.join(', ')}.`);
  let expr = buildExpr(req.body || {}); // { expr } or { query, op, threshold }
  if (!/^[A-Za-z][A-Za-z0-9_]{2,63}$/.test(name || '')) throw httpError(400, 'Name: 3-64 letters, numbers or _ , starting with a letter (e.g. HighCpuAppServers).');
  if (!['critical', 'warning', 'info'].includes(severity)) throw httpError(400, 'Severity must be critical, warning or info.');
  if (!expr || String(expr).length > 2000) throw httpError(400, 'Query is required.');
  await prom('/api/v1/query', { query: expr }).catch((e) => { throw httpError(400, `Query error: ${e.message}`); });
  // labels used for routing (Alertmanager routes on team / env / service / severity) and display
  const labels = { severity, created_by: req.user.username };
  const extra = req.body?.labels && typeof req.body.labels === 'object' && !Array.isArray(req.body.labels) ? req.body.labels : {};
  for (const [k, v] of Object.entries({ ...extra, ...(req.body?.team ? { team: req.body.team } : {}) })) {
    if (!/^[a-z][a-z0-9_]{0,30}$/.test(k) || ['severity', 'created_by', 'tenant', 'alertname', '__name__'].includes(k)) throw httpError(400, `Label "${k}": lower-case a-z 0-9 _, not a reserved name.`);
    if (!/^[A-Za-z0-9._ -]{1,64}$/.test(String(v))) throw httpError(400, `Label ${k}: letters, digits, space . _ - (max 64).`);
    if (k === 'observaone_policy' && !/^p\d{1,12}$/.test(String(v))) throw httpError(400, 'Notification policy: choose one from the list.');
    labels[k] = String(v);
  }
  if (Object.keys(labels).length > 12) throw httpError(400, 'At most 10 labels.');
  if (runbookUrl && !/^https?:\/\/\S{3,500}$/.test(String(runbookUrl))) throw httpError(400, 'Runbook: an http(s) link.');
  // A tenant's rule only ever sees the tenant's series (Prometheus evaluates it without ObservaOne in between),
  // and its alerts carry the tenant label, so only that tenant sees them.
  if (isScoped()) {
    try { expr = scopePromQL(expr, currentTenant()); } catch (e) { throw httpError(400, `This query cannot be used for your organisation: ${e.message}`); }
    labels.tenant = currentTenant();
  }
  const rules = readUiRules();
  if (rules.some((r) => r.alert === name)) throw httpError(409, 'A rule with this name already exists.');
  rules.push({
    alert: name, expr: String(expr), for: `${Math.max(0, Math.min(1440, Number(forMinutes) || 0))}m`, ...(interval ? { _interval: String(interval) } : {}),
    labels,
    annotations: { summary: String(summary).slice(0, 300) || name, description: String(description).slice(0, 1000), ...(runbookUrl ? { runbook_url: String(runbookUrl) } : {}) },
  });
  await writeUiRulesAndReload(rules);
  audit(req, 'rule.create', { name, expr, severity });
  res.json({ ok: true });
}));

api.delete('/rules/:name', requirePerm('alerts.rules'), wrap(async (req, res) => {
  if (!config.rulesFile) throw httpError(400, 'Rule editing is off.');
  const rules = readUiRules();
  const mine = (r) => !isScoped() || r.labels?.tenant === currentTenant(); // another tenant's rule: not found
  const left = rules.filter((r) => !(r.alert === req.params.name && mine(r)));
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

function rowToDash(r) {
  return {
    id: r.id, title: r.title, description: r.description, owner: r.owner, tags: r.tags,
    variables: r.variables, panels: r.panels, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(), kind: 'custom',
  };
}

// Custom dashboards belong to a tenant: users of the default tenant (the platform) see all of them, users of another
// tenant only their own; another tenant's dashboard answers 404 for reading, changing and deleting alike.
const DASH_TENANT = `($T = 't_default' OR tenant_id = $T)`;
const dashScope = (n) => DASH_TENANT.replaceAll('$T', `$${n}`);

async function customDashboards() {
  const { rows } = await q(`SELECT * FROM dashboards WHERE ${dashScope(1)} ORDER BY lower(title)`, [currentTenant()]);
  return rows.map(rowToDash);
}

async function findDashboard(id) {
  const b = builtinDashboards().find((x) => x.id === id);
  if (b) return b;
  const r = await one(`SELECT * FROM dashboards WHERE id = $1 AND ${dashScope(2)}`, [id, currentTenant()]);
  return r ? rowToDash(r) : null;
}

api.get('/dashboards', wrap(async (req, res) => {
  const all = [...builtinDashboards(), ...(await customDashboards())];
  res.json(all.map(({ panels, ...d }) => ({ ...d, panelCount: panels?.length || 0, preview: panels?.find((p) => p.type !== 'stat' && p.type !== 'table') || panels?.[0] || null })));
}));

api.get('/dashboards/:id', wrap(async (req, res) => {
  const d = await findDashboard(req.params.id);
  if (!d) return res.status(404).json({ error: 'Dashboard not found' });
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

api.post('/dashboards', requirePerm('dashboards.edit'), wrap(async (req, res) => {
  const { title, description = '' } = req.body || {};
  if (!title || String(title).length > 60) throw httpError(400, 'Title is required (max 60 chars).');
  const id = `c-${crypto.randomBytes(5).toString('hex')}`;
  const r = await one(`INSERT INTO dashboards (id, title, description, owner, tenant_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [id, String(title), String(description).slice(0, 200), req.user.username, currentTenant()]);
  audit(req, 'dashboard.create', { id, title: r.title });
  res.json(rowToDash(r));
}));

api.post('/dashboards/:id/panels', requirePerm('dashboards.edit'), wrap(async (req, res) => {
  const panel = cleanPanel(req.body);
  const r = await one(`UPDATE dashboards SET panels = panels || $2::jsonb, updated_at = now() WHERE id = $1 AND ${dashScope(3)} RETURNING *`,
    [req.params.id, JSON.stringify([panel]), currentTenant()]);
  if (!r) throw httpError(404, 'Only custom dashboards can be changed. System dashboards are managed as files.');
  audit(req, 'dashboard.panel.add', { id: r.id, title: panel.title });
  res.json(rowToDash(r));
}));

api.delete('/dashboards/:id/panels/:idx', requirePerm('dashboards.edit'), wrap(async (req, res) => {
  const idx = Number(req.params.idx);
  if (!Number.isInteger(idx) || idx < 0) throw httpError(400, 'Bad panel index');
  const r = await one(`UPDATE dashboards SET panels = panels - $2::int, updated_at = now() WHERE id = $1 AND ${dashScope(3)} RETURNING *`, [req.params.id, idx, currentTenant()]);
  if (!r) throw httpError(404, 'Dashboard not found');
  audit(req, 'dashboard.panel.delete', { id: r.id, idx });
  res.json(rowToDash(r));
}));

api.delete('/dashboards/:id', requirePerm('dashboards.edit'), wrap(async (req, res) => {
  const r = await q(`DELETE FROM dashboards WHERE id = $1 AND ${dashScope(2)}`, [req.params.id, currentTenant()]);
  if (!r.rowCount) throw httpError(404, 'Only custom dashboards can be deleted.');
  audit(req, 'dashboard.delete', { id: req.params.id });
  res.json({ ok: true });
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

// ---------------- Modules (admin) ----------------
api.get('/modules', requirePerm('settings.manage'), wrap(async (req, res) => {
  res.json({ catalog: MODULES, ...(await moduleSettings()) });
}));

api.put('/modules', requirePerm('settings.manage'), wrap(async (req, res) => {
  const before = await enabledModules();
  const enabled = await setEnabledModules(req.body?.enabled, req.user.username);
  audit(req, 'modules.update', { before, after: enabled });
  res.json({ catalog: MODULES, configured: true, enabled });
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
