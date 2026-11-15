// Tenants (Phase 6): organisations that share this ObservaOne but must not see each other's agents or series.
// Only users of the default tenant with users.manage can create tenants and move users between them.
import express from 'express';
import { q, one } from '../db.js';
import { audit } from '../store.js';
import { requirePerm, httpError } from '../auth.js';
import { DEFAULT_TENANT, TENANT_RE } from '../tenancy.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export const tenantsRouter = express.Router();

const providerOnly = (req) => {
  if ((req.user?.tenant || DEFAULT_TENANT) !== DEFAULT_TENANT) throw httpError(404, 'Not found.');
};

tenantsRouter.get('/tenants', requirePerm('users.manage'), wrap(async (req, res) => {
  providerOnly(req);
  const { rows } = await q(`SELECT t.*, (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id) AS users,
                                   (SELECT count(*)::int FROM agents a WHERE a.tenant_id = t.id) AS agents
                            FROM tenants t ORDER BY t.id = 't_default' DESC, lower(t.name)`);
  const users = (await q('SELECT username, tenant_id FROM users ORDER BY lower(username)')).rows;
  res.json({
    tenants: rows.map((t) => ({ id: t.id, name: t.name, users: t.users, agents: t.agents, createdBy: t.created_by, createdAt: t.created_at, isDefault: t.id === DEFAULT_TENANT })),
    users: users.map((u) => ({ username: u.username, tenant: u.tenant_id })),
  });
}));

tenantsRouter.post('/tenants', requirePerm('users.manage'), wrap(async (req, res) => {
  providerOnly(req);
  const name = String(req.body?.name || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._&-]{0,59}$/.test(name)) throw httpError(400, 'Name: letters, digits, space . _ & - (max 60).');
  const id = `t_${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'org'}`;
  if (!TENANT_RE.test(id) || id === DEFAULT_TENANT) throw httpError(400, 'Choose another name.');
  try {
    await q('INSERT INTO tenants (id, name, created_by) VALUES ($1, $2, $3)', [id, name, req.user.username]);
  } catch (e) {
    if (e.code === '23505') throw httpError(409, `A tenant ${id} already exists.`);
    throw e;
  }
  audit(req, 'tenant.create', { id, name });
  res.status(201).json({ id, name });
}));

tenantsRouter.put('/users/:username/tenant', requirePerm('users.manage'), wrap(async (req, res) => {
  providerOnly(req);
  const tenant = String(req.body?.tenant || '');
  if (!(await one('SELECT id FROM tenants WHERE id = $1', [tenant]))) throw httpError(400, 'Unknown tenant.');
  if (req.params.username === req.user.username && tenant !== DEFAULT_TENANT) throw httpError(400, 'You cannot move yourself out of the default tenant (you would lose access to tenants).');
  const r = await one('UPDATE users SET tenant_id = $2, updated_at = now() WHERE username = $1 RETURNING username', [req.params.username, tenant]);
  if (!r) throw httpError(404, 'User not found.');
  audit(req, 'user.tenant', { username: r.username, tenant });
  res.json({ ok: true });
}));
