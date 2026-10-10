// Audit log (in PostgreSQL) and request helpers.
import fs from 'node:fs';
import { config } from './config.js';
import { q } from './db.js';

fs.mkdirSync(config.dataDir, { recursive: true });

export function clientIp(req) {
  return (req.headers['x-real-ip'] || req.ip || '').toString();
}

// Never blocks the request; a failed audit write is logged to the console.
export function audit(req, action, details = {}) {
  const d = { ...details };
  delete d.password;
  const username = req?.user?.username || d.username || null;
  delete d.username;
  q('INSERT INTO audit_log (username, ip, action, details) VALUES ($1, $2, $3, $4)',
    [username, req ? clientIp(req) : null, action, JSON.stringify(d)])
    .catch((e) => console.error(`[audit] write failed (${action}): ${e.message}`));
}

export async function readAudit({ limit = 200, user, action, before } = {}) {
  const where = [];
  const params = [];
  if (user) { params.push(user); where.push(`username = $${params.length}`); }
  if (action) { params.push(`${action}%`); where.push(`action LIKE $${params.length}`); }
  if (before) { params.push(before); where.push(`id < $${params.length}`); }
  params.push(Math.min(1000, Math.max(1, Number(limit) || 200)));
  const { rows } = await q(
    `SELECT id, time, username AS user, ip, action, details FROM audit_log
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT $${params.length}`, params);
  return rows.map((r) => ({ id: r.id, time: r.time.toISOString(), user: r.user || '-', ip: r.ip || '-', action: r.action, ...r.details }));
}

export async function pruneAudit() {
  const r = await q(`DELETE FROM audit_log WHERE time < now() - make_interval(days => $1)`, [config.auditRetentionDays]);
  if (r.rowCount) console.log(`[audit] removed ${r.rowCount} entries older than ${config.auditRetentionDays} days`);
}
