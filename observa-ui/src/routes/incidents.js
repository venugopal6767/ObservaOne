// Incidents: one incident per group of firing alerts (same alert on the same service/host), created and
// resolved automatically from Alertmanager. People acknowledge, investigate, assign and add notes.
// Manual incidents can be declared too. In demo mode a few sample incidents are added (marked DEMO).
import express from 'express';
import crypto from 'node:crypto';
import { q, one, tx } from '../db.js';
import { audit } from '../store.js';
import { requirePerm, httpError } from '../auth.js';
import { am, ds } from '../datasources.js';

export const incidentsRouter = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const SEV_RANK = { critical: 3, warning: 2, info: 1 };
const STATUSES = ['open', 'acknowledged', 'investigating', 'resolved'];
const fp = (key) => crypto.createHash('sha1').update(key).digest('hex').slice(0, 20);
const sevOf = (s) => (SEV_RANK[s] ? s : s === 'error' ? 'critical' : 'warning');

const row = (r) => ({
  id: Number(r.id), number: `INC-${String(r.id).padStart(4, '0')}`, title: r.title, severity: r.severity, status: r.status,
  service: r.service, host: r.host, environment: r.environment, summary: r.summary, source: r.source,
  alertName: r.alert_name, labels: r.labels, assignedTo: r.assigned_to, createdBy: r.created_by,
  startedAt: r.started_at, acknowledgedAt: r.acknowledged_at, resolvedAt: r.resolved_at,
  durationSec: Math.max(0, Math.round(((r.resolved_at ? new Date(r.resolved_at) : new Date()) - new Date(r.started_at)) / 1000)),
});

async function event(c, id, actor, kind, text) {
  await c.query('INSERT INTO incident_events (incident_id, actor, kind, text) VALUES ($1,$2,$3,$4)', [id, actor, kind, text]);
}

// ---------------- sync with Alertmanager (at most every 15 s) ----------------
let lastSync = 0;
let syncing = null;
export async function syncIncidents(force = false) {
  if (!force && Date.now() - lastSync < 15_000) return;
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      await seedDemo();
      let alerts;
      try {
        alerts = await am('/api/v2/alerts?active=true&silenced=false&inhibited=false');
      } catch {
        return; // Alertmanager down: keep incidents as they are
      }
      const groups = new Map();
      for (const a of alerts) {
        const L = a.labels || {};
        const target = L.service || L.app || L.host || L.instance || L.job || '';
        const key = `${L.alertname}|${target}`;
        const g = groups.get(key) || { key, alerts: [], L, target };
        g.alerts.push(a);
        groups.set(key, g);
      }
      await tx(async (c) => {
        const open = (await c.query(`SELECT * FROM incidents WHERE source = 'alert' AND status <> 'resolved'`)).rows;
        const openByFp = new Map(open.map((r) => [r.fingerprint, r]));
        for (const g of groups.values()) {
          const f = fp(g.key);
          const sev = g.alerts.map((a) => sevOf(a.labels.severity)).sort((x, y) => SEV_RANK[y] - SEV_RANK[x])[0];
          const existing = openByFp.get(f);
          if (existing) {
            if (SEV_RANK[sev] > SEV_RANK[existing.severity]) {
              await c.query('UPDATE incidents SET severity = $2, updated_at = now() WHERE id = $1', [existing.id, sev]);
              await event(c, existing.id, null, 'alert', `Severity raised to ${sev}`);
            }
            openByFp.delete(f);
            continue;
          }
          const first = g.alerts[0];
          const title = first.annotations?.summary || humanize(g.L.alertname);
          const started = g.alerts.map((a) => a.startsAt).sort()[0] || new Date().toISOString();
          const r = (await c.query(`INSERT INTO incidents (fingerprint, title, severity, service, host, environment, summary, source, alert_name, labels, started_at)
                                    VALUES ($1,$2,$3,$4,$5,$6,$7,'alert',$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
          [f, title.slice(0, 200), sev, g.L.service || g.L.app || '', g.L.host || g.L.instance || '', g.L.env || g.L.environment || '',
            (first.annotations?.description || '').slice(0, 1000), g.L.alertname, JSON.stringify(g.L), started])).rows[0];
          if (r) await event(c, r.id, null, 'created', `Opened automatically: ${g.alerts.length} alert(s) "${g.L.alertname}" firing`);
        }
        // groups that stopped firing: resolve
        for (const r of openByFp.values()) {
          await c.query(`UPDATE incidents SET status = 'resolved', resolved_at = now(), updated_at = now() WHERE id = $1`, [r.id]);
          await event(c, r.id, null, 'status', 'All alerts cleared - resolved automatically');
        }
      });
      lastSync = Date.now();
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

const humanize = (s) => String(s || 'Alert').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');

// ---------------- demo incidents (only while service metrics are in demo mode) ----------------
const DEMO = [
  { title: 'High error rate detected', severity: 'critical', status: 'investigating', service: 'payment-service', min: 12, summary: 'Error rate above 5% for 10 minutes on POST /api/v1/payments.' },
  { title: 'High CPU usage', severity: 'warning', status: 'acknowledged', service: 'user-service', min: 28, summary: 'CPU above 90% on 3 of 4 pods.' },
  { title: 'Increased latency', severity: 'warning', status: 'open', service: 'catalog-service', min: 47, summary: 'P95 latency doubled compared with the same time yesterday.' },
  { title: 'Database connection timeout', severity: 'critical', status: 'resolved', service: 'order-service', min: 125, dur: 18, summary: 'Connection pool exhausted after a slow query.' },
  { title: 'Pod restart loop', severity: 'warning', status: 'resolved', service: 'inventory', min: 190, dur: 25, summary: 'CrashLoopBackOff after a bad config push.' },
];
let demoChecked = 0;
async function seedDemo() {
  if (Date.now() - demoChecked < 60_000) return;
  demoChecked = Date.now();
  const demoOn = ds('services').mode === 'demo';
  const have = await one(`SELECT count(*)::int AS n, max(started_at) AS newest FROM incidents WHERE source = 'demo'`);
  if (!demoOn) {
    if (have.n) await q(`DELETE FROM incidents WHERE source = 'demo'`);
    return;
  }
  // keep the sample incidents "recent": re-create them every 6 hours
  if (have.n && Date.now() - new Date(have.newest) < 6 * 3600_000) return;
  await tx(async (c) => {
    await c.query(`DELETE FROM incidents WHERE source = 'demo'`);
    for (const d of DEMO) {
      const started = new Date(Date.now() - d.min * 60_000);
      const resolved = d.status === 'resolved' ? new Date(started.getTime() + d.dur * 60_000) : null;
      const acked = d.status !== 'open' ? new Date(started.getTime() + 3 * 60_000) : null;
      const r = (await c.query(`INSERT INTO incidents (title, severity, status, service, environment, summary, source, assigned_to, started_at, acknowledged_at, resolved_at)
                                VALUES ($1,$2,$3,$4,'production',$5,'demo',$6,$7,$8,$9) RETURNING id`,
      [d.title, d.severity, d.status, d.service, d.summary, d.status === 'open' ? null : 'admin', started, acked, resolved])).rows[0];
      await c.query('INSERT INTO incident_events (incident_id, at, kind, text) VALUES ($1,$2,$3,$4)', [r.id, started, 'created', `Opened automatically: alert "${d.title}" firing`]);
      if (acked) await c.query('INSERT INTO incident_events (incident_id, at, actor, kind, text) VALUES ($1,$2,$3,$4,$5)', [r.id, acked, 'admin', 'status', 'Acknowledged']);
      if (d.status === 'investigating') await c.query('INSERT INTO incident_events (incident_id, at, actor, kind, text) VALUES ($1,$2,$3,$4,$5)', [r.id, new Date(acked.getTime() + 2 * 60_000), 'admin', 'status', 'Investigating']);
      if (resolved) await c.query('INSERT INTO incident_events (incident_id, at, actor, kind, text) VALUES ($1,$2,$3,$4,$5)', [r.id, resolved, 'admin', 'status', 'Resolved']);
    }
  });
}

// ---------------- API ----------------
incidentsRouter.get('/incidents/count', requirePerm('view'), wrap(async (req, res) => {
  await syncIncidents();
  const r = await one(`SELECT count(*) FILTER (WHERE status <> 'resolved')::int AS active,
                              count(*) FILTER (WHERE status <> 'resolved' AND severity = 'critical')::int AS critical,
                              count(*) FILTER (WHERE status <> 'resolved' AND severity = 'warning')::int AS warning
                       FROM incidents`);
  res.json(r);
}));

incidentsRouter.get('/incidents', requirePerm('view'), wrap(async (req, res) => {
  await syncIncidents();
  const status = String(req.query.status || 'all');
  const where = [];
  const args = [];
  if (status === 'active') where.push(`status <> 'resolved'`);
  else if (STATUSES.includes(status)) { args.push(status); where.push(`status = $${args.length}`); }
  if (SEV_RANK[req.query.severity]) { args.push(req.query.severity); where.push(`severity = $${args.length}`); }
  if (req.query.service) { args.push(String(req.query.service)); where.push(`service = $${args.length}`); }
  if (req.query.q) { args.push(`%${String(req.query.q).slice(0, 80)}%`); where.push(`(title ILIKE $${args.length} OR service ILIKE $${args.length} OR host ILIKE $${args.length})`); }
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  const { rows } = await q(`SELECT * FROM incidents ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                            ORDER BY (status = 'resolved'), CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, started_at DESC
                            LIMIT ${limit}`, args);
  const counts = await one(`SELECT count(*) FILTER (WHERE status <> 'resolved')::int AS active,
                                   count(*) FILTER (WHERE status <> 'resolved' AND severity = 'critical')::int AS critical,
                                   count(*) FILTER (WHERE status <> 'resolved' AND severity = 'warning')::int AS warning,
                                   count(*) FILTER (WHERE status = 'resolved' AND resolved_at > now() - interval '24 hours')::int AS resolved24h,
                                   count(*)::int AS total,
                                   bool_or(source = 'demo') AS demo
                            FROM incidents`);
  res.json({ incidents: rows.map(row), counts });
}));

incidentsRouter.get('/incidents/:id', requirePerm('view'), wrap(async (req, res) => {
  await syncIncidents();
  const r = await one('SELECT * FROM incidents WHERE id = $1', [Number(req.params.id) || 0]);
  if (!r) throw httpError(404, 'Incident not found');
  const { rows: events } = await q('SELECT at, actor, kind, text FROM incident_events WHERE incident_id = $1 ORDER BY at', [r.id]);
  let alerts = [];
  if (r.source === 'alert' && r.status !== 'resolved') {
    try {
      const all = await am('/api/v2/alerts?active=true');
      alerts = all.filter((a) => a.labels.alertname === r.alert_name
        && (a.labels.service || a.labels.app || a.labels.host || a.labels.instance || a.labels.job || '') === (r.labels.service || r.labels.app || r.labels.host || r.labels.instance || r.labels.job || ''))
        .map((a) => ({ labels: a.labels, startsAt: a.startsAt, summary: a.annotations?.summary || '', state: a.status.state }));
    } catch { /* Alertmanager down */ }
  }
  res.json({ incident: row(r), events, alerts });
}));

incidentsRouter.post('/incidents', requirePerm('incidents.manage'), wrap(async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title || title.length > 200) throw httpError(400, 'Give the incident a title (max 200 characters).');
  const severity = SEV_RANK[b.severity] ? b.severity : 'warning';
  const id = await tx(async (c) => {
    const r = (await c.query(`INSERT INTO incidents (title, severity, service, host, environment, summary, source, created_by, assigned_to, status)
                              VALUES ($1,$2,$3,$4,$5,$6,'manual',$7,$7,'investigating') RETURNING id`,
    [title, severity, String(b.service || '').slice(0, 100), String(b.host || '').slice(0, 100), String(b.environment || '').slice(0, 50),
      String(b.summary || '').slice(0, 2000), req.user.username])).rows[0];
    await event(c, r.id, req.user.username, 'created', 'Declared manually');
    return r.id;
  });
  audit(req, 'incident.create', { id: Number(id), title, severity });
  res.json({ id: Number(id) });
}));

incidentsRouter.post('/incidents/:id/status', requirePerm('incidents.manage'), wrap(async (req, res) => {
  const status = String(req.body?.status || '');
  if (!STATUSES.includes(status)) throw httpError(400, `Status must be one of: ${STATUSES.join(', ')}`);
  const id = Number(req.params.id) || 0;
  await tx(async (c) => {
    const r = (await c.query(`UPDATE incidents SET status = $2, updated_at = now(),
                                acknowledged_at = CASE WHEN $2 <> 'open' THEN COALESCE(acknowledged_at, now()) ELSE acknowledged_at END,
                                resolved_at = CASE WHEN $2 = 'resolved' THEN now() ELSE NULL END,
                                assigned_to = CASE WHEN $2 IN ('acknowledged','investigating') THEN COALESCE(assigned_to, $3) ELSE assigned_to END
                              WHERE id = $1 RETURNING id`, [id, status, req.user.username])).rows[0];
    if (!r) throw httpError(404, 'Incident not found');
    await event(c, id, req.user.username, 'status', status[0].toUpperCase() + status.slice(1));
  }).catch((e) => {
    if (e.code === '23505') throw httpError(409, 'Another open incident already covers these alerts.');
    throw e;
  });
  audit(req, 'incident.status', { id, status });
  res.json({ ok: true });
}));

incidentsRouter.post('/incidents/:id/assign', requirePerm('incidents.manage'), wrap(async (req, res) => {
  const id = Number(req.params.id) || 0;
  const who = req.body?.username === 'me' || !req.body?.username ? req.user.username : String(req.body.username).slice(0, 64);
  const u = await one('SELECT username FROM users WHERE lower(username) = lower($1) AND NOT disabled', [who]);
  if (!u) throw httpError(400, 'No such user.');
  await tx(async (c) => {
    const r = (await c.query('UPDATE incidents SET assigned_to = $2, updated_at = now() WHERE id = $1 RETURNING id', [id, u.username])).rows[0];
    if (!r) throw httpError(404, 'Incident not found');
    await event(c, id, req.user.username, 'assigned', `Assigned to ${u.username}`);
  });
  res.json({ ok: true });
}));

incidentsRouter.post('/incidents/:id/notes', requirePerm('incidents.manage'), wrap(async (req, res) => {
  const id = Number(req.params.id) || 0;
  const text = String(req.body?.text || '').trim();
  if (!text || text.length > 2000) throw httpError(400, 'Write a note (max 2000 characters).');
  const r = await one('SELECT id FROM incidents WHERE id = $1', [id]);
  if (!r) throw httpError(404, 'Incident not found');
  await q('INSERT INTO incident_events (incident_id, actor, kind, text) VALUES ($1,$2,$3,$4)', [id, req.user.username, 'note', text]);
  res.json({ ok: true });
}));
