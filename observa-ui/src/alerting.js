// ObservaOne alerting layer (hybrid): Prometheus evaluates the rules, Alertmanager groups, silences and routes the
// notifications; ObservaOne records what happened (pending -> firing -> resolved, with values and durations),
// shows it with its evidence, and scopes everything per tenant.
//
// The state tracker reads Prometheus' rule evaluation every 15 s and keeps one row per alert EPISODE in
// alert_episodes. Several UI containers may run it: a transaction-level advisory lock lets only one write per round.
import crypto from 'node:crypto';
import { q, tx } from './db.js';
import { prom } from './datasources.js';

export const TRACK_EVERY_MS = 15_000;
export const KEEP_DAYS = 30;
const LOCK_ID = 774411; // pg_try_advisory_xact_lock key for the tracker

/** stable key of one alert: its labels (alertname included), sorted */
export function alertKey(labels) {
  const sorted = Object.keys(labels || {}).sort().map((k) => [k, String(labels[k])]);
  return crypto.createHash('sha1').update(JSON.stringify(sorted)).digest('hex').slice(0, 20);
}

/** "expr > 90" -> { left: 'expr', op: '>', threshold: 90 }; null when the expression ends in no comparison */
export function splitThreshold(expr) {
  const m = /^([\s\S]*?)\s*(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(expr || '').replace(/\s*#[^\n]*$/gm, '').trim());
  if (!m) return null;
  let left = m[1].trim();
  // one pair of outer parentheses around the whole left side is noise
  if (left.startsWith('(') && left.endsWith(')') && balancedInner(left)) left = left.slice(1, -1).trim();
  return { left, op: m[2], threshold: Number(m[3]) };
}
function balancedInner(s) {
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') d++;
    else if (s[i] === ')' && --d === 0 && i < s.length - 1) return false;
  }
  return d === 0;
}

/** what the value means, for display: from the rule's labels/annotations, else guessed from its name */
export function unitOf(labels = {}, annotations = {}, name = '') {
  const u = labels.unit || annotations.unit;
  if (u) return u;
  if (/cpu|memory|mem|disk|space|usage|utili[sz]ation|percent/i.test(name)) return 'percent';
  return 'none';
}

/** the host / resource an alert is about */
export const resourceOf = (l = {}) => l.host || l.instance || l.service_name || l.pod || l.job || '';

// One round: read the rules, update open episodes, close the ones that stopped.
export async function trackOnce(now = new Date()) {
  const data = await prom('/api/v1/rules', { type: 'alert' }); // unscoped: runs outside any request
  const seen = new Map();
  for (const g of data.groups || []) {
    for (const r of g.rules || []) {
      for (const a of r.alerts || []) {
        const labels = { ...a.labels };
        const key = alertKey(labels);
        const value = Number(a.value);
        seen.set(key, {
          key, labels, annotations: a.annotations || {}, state: a.state === 'firing' ? 'firing' : 'pending',
          value: Number.isFinite(value) ? value : null, activeAt: a.activeAt ? new Date(a.activeAt) : now,
          expr: r.query || '', forSec: Math.round(r.duration || 0),
        });
      }
    }
  }
  return tx(async (c) => {
    const lock = await c.query('SELECT pg_try_advisory_xact_lock($1) AS ok', [LOCK_ID]);
    if (!lock.rows[0].ok) return { skipped: true };
    const open = new Map((await c.query('SELECT id, alert_key, state FROM alert_episodes WHERE resolved_at IS NULL')).rows.map((r) => [r.alert_key, r]));
    let opened = 0, fired = 0, resolved = 0;
    for (const a of seen.values()) {
      const cur = open.get(a.key);
      if (!cur) {
        await c.query(`INSERT INTO alert_episodes (alert_key, alertname, severity, host, tenant_id, labels, annotations, state, value, peak,
                         active_at, fired_at, last_seen, rule_expr, rule_for)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12,$13,$14)`,
          [a.key, a.labels.alertname || '?', a.labels.severity || 'none', resourceOf(a.labels), a.labels.tenant || 't_default',
            JSON.stringify(a.labels), JSON.stringify(a.annotations), a.state, a.value, a.activeAt, a.state === 'firing' ? now : null, now, a.expr, a.forSec]);
        opened++;
        if (a.state === 'firing') fired++;
      } else {
        await c.query(`UPDATE alert_episodes SET state = $2, value = $3, peak = GREATEST(COALESCE(peak, $3), $3), annotations = $4, last_seen = $5,
                         fired_at = CASE WHEN $2 = 'firing' AND fired_at IS NULL THEN $5 ELSE fired_at END
                       WHERE id = $1`, [cur.id, a.state, a.value, JSON.stringify(a.annotations), now]);
        if (a.state === 'firing' && cur.state !== 'firing') fired++;
      }
    }
    for (const [key, cur] of open) {
      if (seen.has(key)) continue;
      await c.query(`UPDATE alert_episodes SET state = 'resolved', resolved_at = $2 WHERE id = $1`, [cur.id, now]);
      resolved++;
    }
    await c.query(`DELETE FROM alert_episodes WHERE resolved_at < now() - make_interval(days => $1)`, [KEEP_DAYS]);
    return { opened, fired, resolved, active: seen.size };
  });
}

export function startAlertTracker(log = console) {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try { await trackOnce(); } catch (e) { log.error('[alerts] tracker:', e.message); } finally { busy = false; }
  };
  run();
  return setInterval(run, TRACK_EVERY_MS).unref();
}

/** SQL fragment: alerts a tenant may see (the platform sees all) */
export const tenantSql = (n) => `($${n} = 't_default' OR tenant_id = $${n})`;

export async function episodeRows(where, params, limit = 500) {
  return (await q(`SELECT * FROM alert_episodes WHERE ${where} ORDER BY COALESCE(resolved_at, now()) DESC, active_at DESC LIMIT ${Number(limit)}`, params)).rows;
}
