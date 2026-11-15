// Alerts API (hybrid alerting: Prometheus + Alertmanager do the work, ObservaOne shows, scopes and records it).
//
//   GET  /alerts/list?state=all|firing|pending|resolved&start&end&severity&env&q   alerts with value, duration, team (+ envs)
//   GET  /alerts/item/:id                                                     one episode: rule, threshold, history,
//                                                                            labels, annotations, evidence query
//   GET  /alerts/find?name&host&at                                          the episode a notification links to (by
//                                                                            alert name, host, start time) -> { id }
//   POST /rules/test  { expr } | { query, op, threshold }                     "valid, N instances affected" before creating
//
// Tenants: a user of a non-default tenant only sees alerts whose series carry their tenant label; every query they
// test is scoped like any other (datasources.js).
import express from 'express';
import { requirePerm, httpError } from '../auth.js';
import { prom, am } from '../datasources.js';
import { currentTenant } from '../tenancy.js';
import { alertKey, splitThreshold, unitOf, resourceOf, tenantSql, episodeRows } from '../alerting.js';
import { dedupeOpenEpisodes } from '../health.js';

const thresholdCache = new Map(); // rule expression -> has a numeric threshold (a value worth showing)
const hasThreshold = (expr) => { if (!thresholdCache.has(expr)) { if (thresholdCache.size > 2000) thresholdCache.clear(); thresholdCache.set(expr, !!splitThreshold(expr)); } return thresholdCache.get(expr); };

export const alertingRouter = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const OPS = ['>', '>=', '<', '<=', '==', '!='];

async function amStatus() {
  try {
    const list = await am('/api/v2/alerts');
    return new Map(list.map((a) => [alertKey(a.labels), { silenced: a.status.silencedBy?.length > 0, inhibited: a.status.inhibitedBy?.length > 0, silencedBy: a.status.silencedBy || [] }]));
  } catch { return null; } // Alertmanager down: rows still show, without silence state
}

export function toRow(e, amMap, now = Date.now()) {
  const L = e.labels || {}, A = e.annotations || {};
  const state = e.resolved_at ? 'resolved' : e.state;
  const from = e.fired_at || e.active_at;
  const until = e.resolved_at ? Date.parse(e.resolved_at) : now;
  const s = amMap?.get(e.alert_key);
  return {
    id: String(e.id), key: e.alert_key, name: e.alertname, severity: e.severity, state,
    neverFired: state === 'resolved' && !e.fired_at,
    silenced: !!s?.silenced, inhibited: !!s?.inhibited,
    host: e.host || resourceOf(L), env: L.env || '', team: L.team || '', service: L.service || L.service_name || '',
    // a rule without a numeric threshold (e.g. "agent silent") has no meaningful value: shown as "—"
    value: hasThreshold(e.rule_expr) ? e.value : null, peak: hasThreshold(e.rule_expr) ? e.peak : null, unit: unitOf(L, A, e.alertname),
    activeAt: new Date(e.active_at).toISOString(), firedAt: e.fired_at ? new Date(e.fired_at).toISOString() : null,
    resolvedAt: e.resolved_at ? new Date(e.resolved_at).toISOString() : null,
    durationSec: Math.max(0, Math.round((until - Date.parse(from)) / 1000)),
    summary: A.summary || '', runbook: A.runbook_url || '',
  };
}

alertingRouter.get('/alerts/list', wrap(async (req, res) => {
  const state = ['firing', 'pending', 'resolved', 'all'].includes(req.query.state) ? req.query.state : 'all';
  const end = Number(req.query.end) || Date.now() / 1000;
  const start = Number(req.query.start) || end - 86400;
  const t = currentTenant();
  const params = [t, new Date(start * 1000), new Date(end * 1000)];
  const parts = [];
  // active alerts are shown whatever the range; resolved ones when they ended inside it
  if (state === 'all' || state === 'firing' || state === 'pending') parts.push(`(resolved_at IS NULL${state === 'all' ? '' : ` AND state = '${state}'`})`);
  parts.push(state === 'all' || state === 'resolved' ? '(resolved_at BETWEEN $2 AND $3)' : '(resolved_at BETWEEN $2 AND $3 AND FALSE)');
  let where = `${tenantSql(1)} AND (${parts.join(' OR ')})`;
  if (req.query.severity) { params.push(String(req.query.severity)); where += ` AND severity = $${params.length}`; }
  if (req.query.env) { params.push(String(req.query.env)); where += ` AND labels->>'env' = $${params.length}`; }
  if (req.query.q) { params.push(`%${String(req.query.q).toLowerCase()}%`); where += ` AND (lower(alertname) LIKE $${params.length} OR lower(host) LIKE $${params.length} OR lower(labels::text) LIKE $${params.length})`; }
  const [rows0, amMap] = await Promise.all([episodeRows(where, params), amStatus()]);
  const rows = dedupeOpenEpisodes(rows0); // one row per alert (rules in health.js)
  const list = rows.map((e) => toRow(e, amMap));
  const rank = { firing: 0, pending: 1, resolved: 2 }, sev = { critical: 0, warning: 1, info: 2 };
  list.sort((a, b) => rank[a.state] - rank[b.state] || (sev[a.severity] ?? 3) - (sev[b.severity] ?? 3) || b.activeAt.localeCompare(a.activeAt));
  // counts for the tabs (active ones + resolved in the range), tenant-scoped like the list
  const inRange = dedupeOpenEpisodes(await episodeRows(`${tenantSql(1)} AND (resolved_at IS NULL OR resolved_at BETWEEN $2 AND $3)`, params.slice(0, 3), 5000));
  const c = inRange.reduce((acc, e) => { acc[e.resolved_at ? 'resolved' : e.state]++; return acc; }, { firing: 0, pending: 0, resolved: 0 });
  const envs = [...new Set(inRange.map((e) => e.labels?.env).filter(Boolean))].sort(); // the Environment filter's choices
  res.json({ alerts: list, counts: { ...c, all: c.firing + c.pending + c.resolved }, envs, alertmanager: amMap !== null });
}));

// The alert counts every page shows (Overview, Metrics, the bell, Alerting): open episodes from the tracker,
// tenant-scoped and de-duplicated exactly like /alerts/list, so the numbers match the list.
//   firing   firing now (muted ones included: they are still firing)   critical / warning: of the firing ones
//   muted    firing but silenced or inhibited (no notification)         pending: true, not yet for their duration
// "active" = firing, kept for older clients. Database down: Alertmanager's view (firing only) is used instead.
export async function alertCounts() {
  const t = currentTenant();
  try {
    const [rows, amMap] = await Promise.all([episodeRows(`${tenantSql(1)} AND resolved_at IS NULL`, [t], 5000), amStatus()]);
    const list = dedupeOpenEpisodes(rows).map((e) => toRow(e, amMap));
    return countAlerts(list, amMap !== null);
  } catch {
    const mine = (a) => t === 't_default' || a.labels?.tenant === t;
    const all = (await am('/api/v2/alerts?active=true')).filter(mine);
    const list = all.map((a) => ({ state: 'firing', severity: a.labels.severity || 'none', silenced: a.status.silencedBy?.length > 0, inhibited: a.status.inhibitedBy?.length > 0 }));
    return countAlerts(list, true);
  }
}
export function countAlerts(list, alertmanager = true) {
  const firing = list.filter((a) => a.state === 'firing');
  const n = firing.length;
  return {
    firing: n, active: n, pending: list.filter((a) => a.state === 'pending').length,
    critical: firing.filter((a) => a.severity === 'critical').length,
    warning: firing.filter((a) => a.severity === 'warning').length,
    muted: alertmanager ? firing.filter((a) => a.silenced || a.inhibited).length : null,
  };
}

// Links in Slack / Teams / email point here: Alertmanager knows the alert's labels and start time, not our id.
alertingRouter.get('/alerts/find', wrap(async (req, res) => {
  const name = String(req.query.name || ''), host = String(req.query.host || '');
  if (!/^[A-Za-z_:][A-Za-z0-9_:]{0,200}$/.test(name)) throw httpError(400, 'name: an alert name');
  const at = Number(req.query.at);
  const p = [name, currentTenant()];
  let where = `alertname = $1 AND ${tenantSql(2)}`;
  if (host) { p.push(host.slice(0, 300)); where += ` AND host = $${p.length}`; }
  let rows = [];
  if (Number.isFinite(at) && at > 0) {
    // the episode that was active at that moment (Alertmanager's start can be a few seconds off ours)
    p.push(at);
    rows = await episodeRows(`${where} AND active_at <= to_timestamp($${p.length}) + interval '5 minutes'
                              AND COALESCE(resolved_at, now()) >= to_timestamp($${p.length}) - interval '5 minutes'`, p, 1);
    p.pop();
  }
  if (!rows.length) rows = await episodeRows(where, p, 1);
  if (!rows.length) throw httpError(404, 'No record of this alert (it may be older than 30 days or from another tenant).');
  res.json({ id: Number(rows[0].id) });
}));

alertingRouter.get('/alerts/item/:id', wrap(async (req, res) => {
  if (!/^\d{1,18}$/.test(req.params.id)) throw httpError(404, 'Alert not found.');
  const [e] = await episodeRows(`id = $1 AND ${tenantSql(2)}`, [req.params.id, currentTenant()], 1);
  if (!e) throw httpError(404, 'Alert not found.'); // another tenant's alert answers the same
  const [hist, amMap] = await Promise.all([
    episodeRows(`alert_key = $1 AND ${tenantSql(2)}`, [e.alert_key, currentTenant()], 20),
    amStatus(),
  ]);
  const split = splitThreshold(e.rule_expr);
  // evidence: the rule's expression without its comparison, for this alert's series only
  const own = Object.fromEntries(Object.entries(e.labels).filter(([k]) => !['alertname', 'severity', 'team', 'service', 'unit'].includes(k)));
  res.json({
    alert: toRow(e, amMap),
    labels: e.labels, annotations: e.annotations,
    rule: { expr: e.rule_expr, forSec: e.rule_for, op: split?.op || null, threshold: split?.threshold ?? null, graphQuery: split?.left || e.rule_expr },
    seriesLabels: own,
    history: hist.map((h) => toRow(h, null)),
  });
}));

// Test a rule before creating it: is the query valid, and how many series would match right now?
export function buildExpr(b) {
  if (b?.expr) return String(b.expr).trim();
  const query = String(b?.query || '').trim();
  if (!query) throw httpError(400, 'Query is required.');
  if (b.threshold === undefined || b.threshold === null || b.threshold === '') return query;
  const op = OPS.includes(b.op) ? b.op : '>';
  const th = Number(b.threshold);
  if (!Number.isFinite(th)) throw httpError(400, 'Threshold must be a number.');
  return `(${query}) ${op} ${th}`;
}

alertingRouter.post('/rules/test', requirePerm('alerts.rules'), wrap(async (req, res) => {
  const expr = buildExpr(req.body || {});
  if (expr.length > 2000) throw httpError(400, 'Query is too long (max 2000 characters).');
  let data;
  try {
    data = await prom('/api/v1/query', { query: expr });
  } catch (e) {
    return res.json({ valid: false, error: e.message, expr });
  }
  if (data.resultType !== 'vector') return res.json({ valid: false, error: `The query returns a ${data.resultType}; an alert needs one series per instance (an instant vector).`, expr });
  const series = data.result.slice(0, 20).map((r) => ({ labels: r.metric, value: Number(r.value[1]) }));
  res.json({ valid: true, expr, instances: data.result.length, series, hasThreshold: !!splitThreshold(expr) });
}));
