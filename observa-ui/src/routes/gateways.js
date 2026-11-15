// Site gateways (Phase 6): create (token shown once), list with their last status, revoke.
// A gateway relays enrollment, heartbeats and metrics for a site that cannot reach this server, and keeps them
// (bounded) while the link is down. See gateway/README.md.
import express from 'express';
import crypto from 'node:crypto';
import { q, one } from '../db.js';
import { audit } from '../store.js';
import { sha256, randomToken } from '../secrets.js';
import { requirePerm, httpError } from '../auth.js';
import { forgetGateways } from './agent-control.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const tn = (req) => req.user?.tenant || 't_default';
export const gatewaysRouter = express.Router();

gatewaysRouter.get('/gateways', requirePerm('integrations.manage'), wrap(async (req, res) => {
  const { rows } = await q(`SELECT g.*, (SELECT count(*)::int FROM agents a WHERE a.gateway_id = g.id) AS agents
                            FROM gateways g WHERE ($1 = 't_default' OR g.tenant_id = $1) ORDER BY g.revoked, lower(g.name)`, [tn(req)]);
  res.json({ gateways: rows.map((g) => ({ id: g.id, name: g.name, tenant: g.tenant_id, createdBy: g.created_by, createdAt: g.created_at, lastSeen: g.last_seen,
    lastIp: g.last_ip, version: g.version, stats: g.stats, revoked: g.revoked, agents: g.agents,
    online: !!g.last_seen && Date.now() - new Date(g.last_seen).getTime() < 120_000 })) });
}));

gatewaysRouter.post('/gateways', requirePerm('integrations.manage'), wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/.test(name)) throw httpError(400, 'Name: letters, digits, space . _ - (max 60), e.g. "Mumbai DC".');
  const id = `gw_${crypto.randomBytes(6).toString('hex')}`;
  const token = `ogw_${crypto.randomBytes(4).toString('hex')}_${randomToken(32)}`;
  await q('INSERT INTO gateways (id, name, token_hash, tenant_id, created_by) VALUES ($1, $2, $3, $4, $5)', [id, name, sha256(token), tn(req), req.user.username]);
  audit(req, 'gateway.create', { id, name });
  res.set('Cache-Control', 'no-store');
  res.status(201).json({ id, name, token });
}));

gatewaysRouter.delete('/gateways/:id', requirePerm('integrations.manage'), wrap(async (req, res) => {
  const r = await one(`UPDATE gateways SET revoked = TRUE WHERE id = $1 AND ($2 = 't_default' OR tenant_id = $2) AND NOT revoked RETURNING name`, [req.params.id, tn(req)]);
  if (!r) throw httpError(404, 'Gateway not found or already revoked.');
  forgetGateways();
  audit(req, 'gateway.revoke', { id: req.params.id, name: r.name });
  res.json({ ok: true });
}));
