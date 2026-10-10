// Users & access: MFA enrolment, roles, teams, API keys, security settings, API docs.
import express from 'express';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { q, one, tx } from '../db.js';
import { audit } from '../store.js';
import { encrypt, decrypt, sha256 } from '../secrets.js';
import { newSecret, verifyTotp, otpauthUri, recoveryCodes } from '../totp.js';
import {
  PERMISSIONS, BUILTIN_ROLES, loadRoles, invalidateRoles, canGrantRole, hasPerm, requirePerm, requireUser,
  httpError, newApiKey, checkOwnPassword,
} from '../auth.js';
import { getSetting, setSetting } from '../settings.js';
import { enabledProviders } from '../sso.js';
import { ldapEnabled, ldapTest } from '../ldap.js';

export const accessRouter = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------- MFA (two-factor sign-in) ----------------
accessRouter.post('/me/mfa/setup', requireUser, wrap(async (req, res) => {
  const u = await one('SELECT * FROM users WHERE id = $1', [req.userId]);
  if (!['local', 'ldap'].includes(u.auth_source)) throw httpError(400, 'Two-factor sign-in for SSO accounts is handled by your SSO provider.');
  if (u.mfa_enabled) throw httpError(400, 'Two-factor sign-in is already on. Turn it off first to set up a new device.');
  const secret = newSecret();
  await q('UPDATE users SET mfa_pending_secret = $2 WHERE id = $1', [u.id, encrypt(secret)]);
  const uri = otpauthUri({ secret, account: u.username, issuer: config.brand });
  const svg = await QRCode.toString(uri, { type: 'svg', margin: 1, width: 200, color: { dark: '#0b1324', light: '#ffffff' } });
  res.json({ secret, otpauth: uri, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` });
}));

accessRouter.post('/me/mfa/enable', requireUser, wrap(async (req, res) => {
  const u = await one('SELECT * FROM users WHERE id = $1', [req.userId]);
  if (!u.mfa_pending_secret) throw httpError(400, 'Start the setup first.');
  const secret = decrypt(u.mfa_pending_secret);
  const step = verifyTotp(secret, req.body?.code);
  if (step === null) throw httpError(400, 'That code is not right. Check the time on your phone and try the newest code.');
  const codes = recoveryCodes(10);
  await tx(async (c) => {
    await c.query(`UPDATE users SET mfa_enabled = TRUE, mfa_secret = $2, mfa_pending_secret = NULL, mfa_last_step = $3, mfa_recovery = $4
                   WHERE id = $1`, [u.id, encrypt(secret), step, JSON.stringify(codes.map((x) => sha256(x)))]);
    if (req.sessionHash) await c.query('UPDATE sessions SET restricted = NULL WHERE token_hash = $1', [req.sessionHash]);
  });
  audit(req, 'mfa.enabled');
  res.json({ ok: true, recoveryCodes: codes });
}));

async function requireCode(u, code) {
  const step = verifyTotp(decrypt(u.mfa_secret), code, { lastStep: u.mfa_last_step });
  if (step === null) throw httpError(400, 'Wrong two-factor code.');
  await q('UPDATE users SET mfa_last_step = $2 WHERE id = $1', [u.id, step]);
}

accessRouter.post('/me/mfa/disable', requireUser, wrap(async (req, res) => {
  const u = await one('SELECT * FROM users WHERE id = $1', [req.userId]);
  if (!u.mfa_enabled) throw httpError(400, 'Two-factor sign-in is not on.');
  const sec = await getSetting('security');
  if ((sec.mfaRequiredRoles || []).includes(u.role)) throw httpError(400, `Two-factor sign-in is required for the ${u.role} role.`);
  if (!(await checkOwnPassword(u.id, req.body?.password))) throw httpError(400, 'Password is wrong.');
  await requireCode(u, req.body?.code);
  await q(`UPDATE users SET mfa_enabled = FALSE, mfa_secret = NULL, mfa_recovery = '[]', mfa_last_step = NULL WHERE id = $1`, [u.id]);
  audit(req, 'mfa.disabled');
  res.json({ ok: true });
}));

accessRouter.post('/me/mfa/recovery-codes', requireUser, wrap(async (req, res) => {
  const u = await one('SELECT * FROM users WHERE id = $1', [req.userId]);
  if (!u.mfa_enabled) throw httpError(400, 'Two-factor sign-in is not on.');
  await requireCode(u, req.body?.code);
  const codes = recoveryCodes(10);
  await q('UPDATE users SET mfa_recovery = $2 WHERE id = $1', [u.id, JSON.stringify(codes.map((x) => sha256(x)))]);
  audit(req, 'mfa.recovery_codes_regenerated');
  res.json({ recoveryCodes: codes });
}));

accessRouter.put('/me/profile', requireUser, wrap(async (req, res) => {
  const { email, displayName, phone } = req.body || {};
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'E-mail address looks wrong.');
  if (phone && !/^\+?[0-9 ()-]{6,20}$/.test(phone)) throw httpError(400, 'Phone number looks wrong (use +country code).');
  await q(`UPDATE users SET email = $2, display_name = $3, phone = $4, updated_at = now() WHERE id = $1`,
    [req.userId, email || null, displayName ? String(displayName).slice(0, 80) : null, phone || null]);
  audit(req, 'profile.update');
  res.json({ ok: true });
}));

// ---------------- Roles ----------------
accessRouter.get('/roles', wrap(async (req, res) => {
  const roles = await loadRoles(true);
  const counts = Object.fromEntries((await q('SELECT role, count(*)::int AS n FROM users GROUP BY role')).rows.map((r) => [r.role, r.n]));
  res.json({
    permissions: PERMISSIONS,
    roles: [...roles.values()].map((r) => ({ name: r.name, description: r.description, builtin: r.builtin, permissions: [...r.permissions], users: counts[r.name] || 0 })),
  });
}));

function cleanPerms(list) {
  if (!Array.isArray(list)) throw httpError(400, 'permissions must be a list');
  const out = [...new Set(list.filter((p) => p === '*' || PERMISSIONS[p]))];
  if (!out.includes('view') && !out.includes('*')) out.unshift('view');
  return out;
}

accessRouter.post('/roles', requirePerm('users.manage'), wrap(async (req, res) => {
  const { name, description = '', permissions } = req.body || {};
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(name || '')) throw httpError(400, 'Role name: 2-32 lower-case letters, numbers, - or _.');
  const perms = cleanPerms(permissions);
  if (!perms.every((p) => hasPerm(req.user, p))) throw httpError(403, 'You cannot create a role with rights you do not have.');
  try {
    await q('INSERT INTO roles (name, description, permissions) VALUES ($1, $2, $3)', [name, String(description).slice(0, 200), JSON.stringify(perms)]);
  } catch (e) {
    if (e.code === '23505') throw httpError(409, 'A role with this name exists.');
    throw e;
  }
  invalidateRoles();
  audit(req, 'role.create', { role: name, permissions: perms });
  res.json({ ok: true });
}));

accessRouter.put('/roles/:name', requirePerm('users.manage'), wrap(async (req, res) => {
  const r = await one('SELECT * FROM roles WHERE name = $1', [req.params.name]);
  if (!r) throw httpError(404, 'Role not found.');
  if (r.builtin) throw httpError(400, 'Built-in roles cannot be changed. Create a custom role instead.');
  const perms = cleanPerms(req.body?.permissions ?? r.permissions);
  if (!perms.every((p) => hasPerm(req.user, p))) throw httpError(403, 'You cannot give a role rights you do not have.');
  await q('UPDATE roles SET description = $2, permissions = $3, updated_at = now() WHERE name = $1',
    [r.name, String(req.body?.description ?? r.description).slice(0, 200), JSON.stringify(perms)]);
  invalidateRoles();
  audit(req, 'role.update', { role: r.name, permissions: perms });
  res.json({ ok: true });
}));

accessRouter.delete('/roles/:name', requirePerm('users.manage'), wrap(async (req, res) => {
  if (BUILTIN_ROLES.includes(req.params.name)) throw httpError(400, 'Built-in roles cannot be deleted.');
  const used = await one('SELECT (SELECT count(*) FROM users WHERE role = $1) + (SELECT count(*) FROM api_keys WHERE role = $1 AND NOT revoked) AS n', [req.params.name]);
  if (used.n > 0) throw httpError(400, `This role is still used by ${used.n} user(s) or API key(s).`);
  await q('DELETE FROM api_keys WHERE role = $1', [req.params.name]);
  const r = await q('DELETE FROM roles WHERE name = $1 AND NOT builtin', [req.params.name]);
  if (!r.rowCount) throw httpError(404, 'Role not found.');
  invalidateRoles();
  audit(req, 'role.delete', { role: req.params.name });
  res.json({ ok: true });
}));

// ---------------- Teams ----------------
accessRouter.get('/teams', wrap(async (req, res) => {
  const { rows } = await q(`SELECT t.id, t.name, t.description, t.created_at,
      COALESCE(json_agg(json_build_object('username', u.username, 'displayName', u.display_name)) FILTER (WHERE u.id IS NOT NULL), '[]') AS members
    FROM teams t LEFT JOIN team_members m ON m.team_id = t.id LEFT JOIN users u ON u.id = m.user_id
    GROUP BY t.id ORDER BY lower(t.name)`);
  res.json(rows.map((t) => ({ id: t.id, name: t.name, description: t.description, members: t.members, createdAt: t.created_at })));
}));

accessRouter.post('/teams', requirePerm('users.manage'), wrap(async (req, res) => {
  const { name, description = '' } = req.body || {};
  if (!name || String(name).length > 60) throw httpError(400, 'Team name is required (max 60).');
  try {
    const t = await one('INSERT INTO teams (name, description) VALUES ($1, $2) RETURNING id', [String(name).trim(), String(description).slice(0, 200)]);
    audit(req, 'team.create', { team: name });
    res.json({ id: t.id });
  } catch (e) {
    if (e.code === '23505') throw httpError(409, 'A team with this name exists.');
    throw e;
  }
}));

accessRouter.put('/teams/:id', requirePerm('users.manage'), wrap(async (req, res) => {
  const { name, description, members } = req.body || {};
  await tx(async (c) => {
    const t = (await c.query('SELECT * FROM teams WHERE id = $1', [req.params.id])).rows[0];
    if (!t) throw httpError(404, 'Team not found.');
    if (name !== undefined || description !== undefined) {
      await c.query('UPDATE teams SET name = $2, description = $3 WHERE id = $1', [t.id, String(name ?? t.name).trim().slice(0, 60), String(description ?? t.description).slice(0, 200)]);
    }
    if (Array.isArray(members)) {
      await c.query('DELETE FROM team_members WHERE team_id = $1', [t.id]);
      if (members.length) {
        await c.query(`INSERT INTO team_members (team_id, user_id) SELECT $1, id FROM users WHERE username = ANY($2::text[])`, [t.id, members.map(String)]);
      }
    }
  });
  audit(req, 'team.update', { team: req.params.id, members });
  res.json({ ok: true });
}));

accessRouter.delete('/teams/:id', requirePerm('users.manage'), wrap(async (req, res) => {
  const r = await q('DELETE FROM teams WHERE id = $1', [req.params.id]);
  if (!r.rowCount) throw httpError(404, 'Team not found.');
  audit(req, 'team.delete', { team: req.params.id });
  res.json({ ok: true });
}));

// ---------------- API keys ----------------
accessRouter.get('/apikeys', wrap(async (req, res) => {
  const all = req.query.all === '1' && hasPerm(req.user, 'users.manage');
  const { rows } = await q(`SELECT k.id, k.name, k.prefix, k.role, k.created_by, k.created_at, k.last_used, k.expires_at, k.revoked,
      u.username AS owner FROM api_keys k LEFT JOIN users u ON u.id = k.owner_user_id
    WHERE ${all ? 'TRUE' : 'k.owner_user_id = $1'} ORDER BY k.revoked, k.created_at DESC`, all ? [] : [req.userId ?? -1]);
  res.json(rows.map((k) => ({
    id: k.id, name: k.name, display: `oo_${k.prefix}_…`, role: k.role, owner: k.owner || '(service account)', createdBy: k.created_by,
    createdAt: k.created_at, lastUsed: k.last_used, expiresAt: k.expires_at, revoked: k.revoked,
    expired: !!(k.expires_at && new Date(k.expires_at) < new Date()),
  })));
}));

accessRouter.post('/apikeys', wrap(async (req, res) => {
  const { name, role, expiresDays, serviceAccount } = req.body || {};
  if (!name || String(name).length > 60) throw httpError(400, 'Name is required (max 60).');
  await loadRoles();
  const roles = await loadRoles();
  if (!roles.has(role)) throw httpError(400, 'Unknown role.');
  if (!canGrantRole(req.user.permissions, role)) throw httpError(403, 'A key cannot have more rights than you have.');
  if (serviceAccount && !hasPerm(req.user, 'users.manage')) throw httpError(403, 'Only user admins can create service-account keys.');
  if (!serviceAccount && !req.userId) throw httpError(400, 'Service API keys cannot create personal keys.');
  const days = expiresDays ? Math.min(3650, Math.max(1, Number(expiresDays))) : null;
  const { key, prefix, hash } = newApiKey();
  const k = await one(`INSERT INTO api_keys (name, prefix, key_hash, role, owner_user_id, created_by, expires_at)
                       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::int IS NULL THEN NULL ELSE now() + make_interval(days => $7::int) END) RETURNING id`,
  [String(name), prefix, hash, role, serviceAccount ? null : req.userId, req.user.username, days]);
  audit(req, 'apikey.create', { id: k.id, name, role, serviceAccount: !!serviceAccount, expiresDays: days });
  res.json({ id: k.id, key }); // shown once
}));

accessRouter.delete('/apikeys/:id', wrap(async (req, res) => {
  const k = await one('SELECT * FROM api_keys WHERE id = $1', [req.params.id]);
  if (!k) throw httpError(404, 'Key not found.');
  if (k.owner_user_id !== req.userId && !hasPerm(req.user, 'users.manage')) throw httpError(403, 'Not your key.');
  await q('UPDATE api_keys SET revoked = TRUE WHERE id = $1', [k.id]);
  audit(req, 'apikey.revoke', { id: k.id, name: k.name });
  res.json({ ok: true });
}));

// ---------------- Security settings ----------------
accessRouter.get('/settings/security', requirePerm('view'), wrap(async (req, res) => {
  const sec = await getSetting('security');
  res.json({
    ...sec,
    session: { idleMinutes: config.sessionIdleMinutes, maxHours: config.sessionMaxHours, lockoutAfter: config.maxFailedLogins, lockoutMinutes: config.lockoutMinutes },
    sso: enabledProviders(),
    ldap: ldapEnabled() ? { url: config.ldap.url, baseDn: config.ldap.baseDn, filter: config.ldap.userFilter, groupAttr: config.ldap.groupAttr, mappings: Object.keys(config.ldap.roleMap).length, defaultRole: config.ldap.defaultRole || null } : null,
    publicUrl: config.publicUrl || null,
  });
}));

accessRouter.put('/settings/security', requirePerm('settings.manage'), wrap(async (req, res) => {
  const roles = await loadRoles();
  const list = (req.body?.mfaRequiredRoles || []).filter((r) => roles.has(r));
  await setSetting('security', { mfaRequiredRoles: list }, req.user.username);
  audit(req, 'settings.security', { mfaRequiredRoles: list });
  res.json({ ok: true });
}));

accessRouter.post('/settings/ldap/test', requirePerm('settings.manage'), wrap(async (req, res) => {
  if (!ldapEnabled()) throw httpError(400, 'LDAP is not configured (LDAP_URL and LDAP_BASE_DN).');
  try {
    res.json(await ldapTest(String(req.body?.username || '')));
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
}));
