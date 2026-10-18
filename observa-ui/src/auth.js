// Users, passwords, sessions, permissions, MFA sign-in, API keys - stored in PostgreSQL.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { audit, clientIp } from './store.js';
import { q, one, tx } from './db.js';
import { sha256, randomToken, decrypt } from './secrets.js';
import { verifyTotp } from './totp.js';
import { getSetting } from './settings.js';

const COOKIE = 'oo_session';
const BCRYPT_COST = 12;
export const USERNAME_RE = /^[a-zA-Z0-9._@-]{3,64}$/;

// ---------- permissions ----------
export const PERMISSIONS = {
  view: 'See all data: dashboards, metrics, logs, traces, alerts',
  'dashboards.edit': 'Create and edit dashboards and notebooks',
  'alerts.silence': 'Silence alerts and schedule maintenance windows',
  'alerts.rules': 'Create and delete alert rules',
  'notifications.manage': 'Manage notification channels and routing',
  'incidents.manage': 'Declare, update and resolve incidents',
  'oncall.manage': 'Edit on-call schedules and escalation policies',
  'slo.manage': 'Create and edit SLOs',
  'synthetics.manage': 'Create and edit uptime checks',
  'catalog.manage': 'Edit the service catalog and record deployments',
  'workflows.manage': 'Create and run automation workflows',
  'integrations.manage': 'Data sources, monitored servers, discovery, integrations',
  'rum.manage': 'Manage real-user monitoring apps and session replay',
  'ai.use': 'Use the AI assistant',
  'security.read': 'See security signals',
  'users.manage': 'Users, roles, teams, API keys and sign-in sessions',
  'audit.read': 'Read the audit log',
  'settings.manage': 'System settings (MFA policy and similar)',
};
export const BUILTIN_ROLES = ['viewer', 'operator', 'admin'];

let roleCache = { at: 0, map: new Map() }; // name -> { permissions:Set, description, builtin }

export async function loadRoles(force = false) {
  if (!force && Date.now() - roleCache.at < 30_000 && roleCache.map.size) return roleCache.map;
  const { rows } = await q('SELECT name, description, permissions, builtin FROM roles ORDER BY builtin DESC, name');
  roleCache = { at: Date.now(), map: new Map(rows.map((r) => [r.name, { ...r, permissions: new Set(r.permissions) }])) };
  return roleCache.map;
}
export function invalidateRoles() {
  roleCache.at = 0;
}

function permsOf(role) {
  return roleCache.map.get(role)?.permissions || new Set();
}

export function hasPerm(user, perm) {
  const p = user?.permissions;
  if (!p) return false;
  return p.includes('*') || p.includes(perm);
}

// Can someone with `perms` hand out `role`? (no privilege escalation through roles or API keys)
export function canGrantRole(perms, role) {
  if (perms.includes('*')) return true;
  const target = permsOf(role);
  if (target.has('*')) return false;
  return [...target].every((p) => perms.includes(p));
}

// ---------- password policy ----------
export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 12) return 'Password must be at least 12 characters.';
  if (pw.length > 128) return 'Password is too long (max 128).';
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/[0-9]/.test(pw) || !/[^A-Za-z0-9]/.test(pw))
    return 'Password needs upper case, lower case, a number and a symbol.';
  return null;
}

export function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) e.extra = extra;
  return e;
}

// ---------- users ----------
export function publicUser(u) {
  return {
    username: u.username,
    role: u.role,
    disabled: !!u.disabled,
    authSource: u.auth_source || 'local',
    email: u.email || null,
    displayName: u.display_name || null,
    phone: u.phone || null,
    mfaEnabled: !!u.mfa_enabled,
    createdAt: u.created_at?.toISOString?.() || u.created_at,
    lastLogin: u.last_login ? new Date(u.last_login).toISOString() : null,
    permissions: [...permsOf(u.role)],
  };
}

export async function listUsers() {
  await loadRoles();
  const { rows } = await q(
    `SELECT u.*,
       (SELECT count(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > now()
          AND s.last_seen > now() - make_interval(mins => $1)) AS sessions,
       COALESCE((SELECT json_agg(t.name ORDER BY t.name) FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = u.id), '[]') AS teams
     FROM users u ORDER BY lower(u.username)`, [config.sessionIdleMinutes]);
  return rows.map((u) => ({ ...publicUser(u), activeSessions: u.sessions, teams: u.teams }));
}

export const findUser = (username) => one('SELECT * FROM users WHERE lower(username) = lower($1)', [username || '']);

export async function bootstrapUsers() {
  await loadRoles(true);
  const { rows } = await q('SELECT count(*)::int AS n FROM users');
  if (rows[0].n > 0) return;
  let created = 0;
  for (const b of config.bootstrapUsers) {
    if (!b.password) { console.warn(`[auth] no password set for ${b.role} user "${b.username}" - skipped`); continue; }
    const prob = passwordProblem(b.password);
    if (prob) { console.warn(`[auth] password for "${b.username}" rejected: ${prob} - user skipped`); continue; }
    await q('INSERT INTO users (username, role, password_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [b.username, b.role, await bcrypt.hash(b.password, BCRYPT_COST)]);
    created++;
  }
  const admins = await one(`SELECT count(*)::int AS n FROM users WHERE role = 'admin'`);
  if (!admins.n) throw new Error('No valid admin user. Set UI_ADMIN_USER and UI_ADMIN_PASSWORD (12+ chars, upper, lower, number, symbol).');
  console.log(`[auth] created ${created} first-start user(s)`);
}

async function assertRole(role) {
  const roles = await loadRoles();
  if (!roles.has(role)) throw httpError(400, 'Unknown role.');
}

export async function createUser({ username, password, role, email, displayName, phone }, actorPerms) {
  if (!USERNAME_RE.test(username || '')) throw httpError(400, 'Username: 3-64 letters, numbers, dot, dash, underscore or @.');
  await assertRole(role);
  if (actorPerms && !canGrantRole(actorPerms, role)) throw httpError(403, 'You cannot give a role with more rights than your own.');
  const prob = passwordProblem(password);
  if (prob) throw httpError(400, prob);
  try {
    await q('INSERT INTO users (username, role, password_hash, email, display_name, phone) VALUES ($1,$2,$3,$4,$5,$6)',
      [username, role, await bcrypt.hash(password, BCRYPT_COST), email || null, displayName || null, phone || null]);
  } catch (e) {
    if (e.code === '23505') throw httpError(409, 'User already exists.');
    throw e;
  }
}

async function activeAdmins(c) {
  return (await c.query(`SELECT count(*)::int AS n FROM users u JOIN roles r ON r.name = u.role
                         WHERE r.permissions ? '*' AND NOT u.disabled`)).rows[0].n;
}

export async function updateUser(username, { role, password, disabled, email, displayName, phone, resetMfa }, actorPerms) {
  if (role !== undefined) {
    await assertRole(role);
    if (actorPerms && !canGrantRole(actorPerms, role)) throw httpError(403, 'You cannot give a role with more rights than your own.');
  }
  if (password !== undefined) {
    const prob = passwordProblem(password);
    if (prob) throw httpError(400, prob);
  }
  const hash = password !== undefined ? await bcrypt.hash(password, BCRYPT_COST) : null;
  await tx(async (c) => {
    await c.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE'); // no two admins demoting each other at once
    const u = (await c.query('SELECT * FROM users WHERE username = $1', [username])).rows[0];
    if (!u) throw httpError(404, 'User not found.');
    if (hash && u.auth_source !== 'local') throw httpError(400, `This user signs in with ${u.auth_source.toUpperCase()}; change the password there.`);
    const wasAdmin = permsOf(u.role).has('*');
    const losingAdmin = wasAdmin && !u.disabled && ((role && !permsOf(role).has('*')) || disabled);
    if (losingAdmin && (await activeAdmins(c)) <= 1) throw httpError(400, 'Cannot remove or disable the last admin.');
    await c.query(
      `UPDATE users SET role = COALESCE($2, role), disabled = COALESCE($3, disabled),
         password_hash = COALESCE($4, password_hash),
         password_changed_at = CASE WHEN $4::text IS NULL THEN password_changed_at ELSE now() END,
         email = CASE WHEN $5::boolean THEN $6 ELSE email END,
         display_name = CASE WHEN $7::boolean THEN $8 ELSE display_name END,
         phone = CASE WHEN $9::boolean THEN $10 ELSE phone END,
         updated_at = now() WHERE id = $1`,
      [u.id, role ?? null, disabled === undefined ? null : !!disabled, hash,
        email !== undefined, email || null, displayName !== undefined, displayName || null, phone !== undefined, phone || null]);
    if (resetMfa) {
      await c.query(`UPDATE users SET mfa_enabled = FALSE, mfa_secret = NULL, mfa_pending_secret = NULL, mfa_recovery = '[]', mfa_last_step = NULL WHERE id = $1`, [u.id]);
    }
    if (disabled || hash || resetMfa || (role && role !== u.role)) await c.query('DELETE FROM sessions WHERE user_id = $1', [u.id]);
  });
}

export async function deleteUser(username) {
  await tx(async (c) => {
    await c.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    const u = (await c.query('SELECT * FROM users WHERE username = $1', [username])).rows[0];
    if (!u) throw httpError(404, 'User not found.');
    if (permsOf(u.role).has('*') && !u.disabled && (await activeAdmins(c)) <= 1) throw httpError(400, 'Cannot delete the last admin.');
    await c.query('DELETE FROM users WHERE id = $1', [u.id]); // sessions, preferences, keys, memberships go with it
  });
}

// Users that come from LDAP or SSO: created on first sign-in, kept in sync after that.
export async function upsertExternalUser(source, { externalId, username, email, displayName, role, defaultRole, syncRole }) {
  await loadRoles();
  const existing = await one('SELECT * FROM users WHERE auth_source = $1 AND external_id = $2', [source, String(externalId)]);
  if (existing) {
    // the directory/IdP is the source of truth when a role map is set: no matching group = no access
    if (syncRole && !role && !defaultRole) throw httpError(403, 'Your account is not in any group that has access. Ask an administrator.');
    const synced = role || defaultRole;
    const newRole = syncRole && synced && roleCache.map.has(synced) ? synced : existing.role;
    const r = await one(`UPDATE users SET email = COALESCE($2, email), display_name = COALESCE($3, display_name), role = $4, updated_at = now()
                         WHERE id = $1 RETURNING *`, [existing.id, email || null, displayName || null, newRole]);
    if (newRole !== existing.role) audit(null, 'user.role_synced', { username: existing.username, from: existing.role, to: newRole, source });
    return r;
  }
  const finalRole = role || defaultRole;
  if (!finalRole) throw httpError(403, 'Your account is not in any group that has access. Ask an administrator.');
  if (!roleCache.map.has(finalRole)) throw httpError(500, `Role "${finalRole}" from the ${source} mapping does not exist.`);
  let base = String(username || email || externalId).toLowerCase().replace(/[^a-z0-9._@-]/g, '.').slice(0, 56);
  if (base.length < 3) base = `${base}.${source}`.slice(0, 56);
  for (const candidate of [base, `${base}.${source}`, `${base}.${crypto.randomBytes(2).toString('hex')}`]) {
    try {
      const r = await one(`INSERT INTO users (username, role, password_hash, auth_source, external_id, email, display_name)
                           VALUES ($1, $2, NULL, $3, $4, $5, $6) RETURNING *`,
      [candidate, finalRole, source, String(externalId), email || null, displayName || null]);
      audit(null, 'user.create', { username: candidate, role: finalRole, source });
      return r;
    } catch (e) {
      if (e.code !== '23505') throw e;
    }
  }
  throw httpError(409, 'Could not create a unique username.');
}

// ---------- lockout (shared by all UI instances) ----------
const lockKey = (username, ip) => `${(username || '').toLowerCase().slice(0, 64)}|${ip}`;

async function lockedUntil(key) {
  const r = await one('SELECT locked_until FROM login_failures WHERE key = $1 AND locked_until > now()', [key]);
  return r?.locked_until || null;
}

export async function recordFailure(key) {
  await q(
    `INSERT INTO login_failures (key, failures, updated_at) VALUES ($1, 1, now())
     ON CONFLICT (key) DO UPDATE SET
       failures = CASE WHEN login_failures.updated_at < now() - make_interval(mins => $2::int) THEN 1 ELSE login_failures.failures + 1 END,
       updated_at = now()`,
    [key, config.lockoutMinutes]);
  await q(
    `UPDATE login_failures SET locked_until = now() + make_interval(mins => $3::int), failures = 0
     WHERE key = $1 AND failures >= $2::int`,
    [key, config.maxFailedLogins, config.lockoutMinutes]);
}

// ---------- sessions ----------
function cookieSecure(req) {
  if (config.cookieSecure === 'true') return true;
  if (config.cookieSecure === 'false') return false;
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function setCookie(res, req, token, persistent) {
  // Lax (not Strict) so the cookie is sent when an SSO provider redirects back to us.
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (cookieSecure(req)) parts.push('Secure');
  if (persistent) parts.push(`Max-Age=${config.sessionMaxHours * 3600}`);
  res.append('Set-Cookie', parts.join('; '));
}

function readCookie(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}

export async function createSession(req, res, u, { remember = false, method = 'local', restricted = null } = {}) {
  const token = randomToken(32);
  await tx(async (c) => {
    await c.query('UPDATE users SET last_login = now() WHERE id = $1', [u.id]);
    await c.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at, persistent, ip, user_agent, auth_method, restricted)
       VALUES ($1, $2, now() + make_interval(hours => $3), $4, $5, $6, $7, $8)`,
      [sha256(token), u.id, config.sessionMaxHours, !!remember, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 300), method, restricted]);
  });
  setCookie(res, req, token, !!remember);
  req.user = publicUser({ ...u, last_login: new Date() });
  audit(req, 'login.ok', { method, persistent: !!remember, ...(restricted ? { restricted } : {}) });
  return req.user;
}

// Same work whether the user exists or not (no username probing by timing)
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', BCRYPT_COST);

// external password check (LDAP) is plugged in from server.js to avoid an import cycle
let externalPasswordAuth = null;
export function setExternalPasswordAuth(fn) {
  externalPasswordAuth = fn;
}

export async function login(req, res) {
  const { username, password, remember } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    throw httpError(400, 'Enter username and password.');
  }
  await loadRoles();
  const ip = clientIp(req);
  const key = lockKey(username, ip);
  if (await lockedUntil(key)) {
    audit(req, 'login.locked', { username });
    throw httpError(429, `Too many failed attempts. Try again in ${config.lockoutMinutes} minutes.`);
  }
  let u = await findUser(username);
  let method = 'local';
  let ok = false;
  if (u && u.auth_source === 'local') {
    ok = await bcrypt.compare(password, u.password_hash || DUMMY_HASH);
  } else if (u && u.auth_source !== 'ldap') {
    await bcrypt.compare(password, DUMMY_HASH);
    throw httpError(400, `This account signs in with ${u.auth_source.toUpperCase()}. Use the button below the form.`);
  } else if (externalPasswordAuth) {
    // LDAP user, or an unknown user who may exist in LDAP
    method = 'ldap';
    const ext = await externalPasswordAuth(username, password).catch((e) => {
      console.error('[auth] LDAP error:', e.message);
      if (e.status) throw e;
      throw httpError(503, 'The directory server (LDAP) is not reachable. Try again later.');
    });
    if (ext) {
      u = ext;
      ok = true;
    }
  } else {
    await bcrypt.compare(password, DUMMY_HASH);
  }
  if (!u || !ok || u.disabled) {
    await recordFailure(key);
    audit(req, 'login.failed', { username, reason: u?.disabled ? 'disabled' : 'bad credentials', method });
    throw httpError(401, 'Wrong username or password.');
  }
  await q('DELETE FROM login_failures WHERE key = $1', [key]);
  return finishPrimaryAuth(req, res, u, { method, remember: !!remember });
}

// After the password (or LDAP) step: ask for the MFA code, force MFA setup, or sign in.
export async function finishPrimaryAuth(req, res, u, { method, remember }) {
  const localKind = method === 'local' || method === 'ldap';
  if (localKind && u.mfa_enabled) {
    const token = randomToken(24);
    await q(`INSERT INTO login_challenges (token_hash, user_id, purpose, remember, auth_method, expires_at)
             VALUES ($1, $2, 'mfa', $3, $4, now() + interval '5 minutes')`, [sha256(token), u.id, remember, method]);
    audit(req, 'login.mfa_challenge', { username: u.username });
    return { mfaRequired: true, challenge: token };
  }
  const sec = await getSetting('security');
  const restricted = localKind && !u.mfa_enabled && (sec.mfaRequiredRoles || []).includes(u.role) ? 'mfa_setup' : null;
  const user = await createSession(req, res, u, { remember, method, restricted });
  return { user, mfaSetupRequired: !!restricted };
}

export async function verifyMfaLogin(req, res, { challenge, code, recoveryCode }) {
  if (!challenge) throw httpError(400, 'Missing sign-in challenge.');
  const c = await one(`SELECT c.*, u.username FROM login_challenges c JOIN users u ON u.id = c.user_id
                       WHERE c.token_hash = $1 AND c.purpose = 'mfa' AND c.expires_at > now()`, [sha256(challenge)]);
  if (!c) throw httpError(401, 'The sign-in took too long. Start again.');
  const key = lockKey(c.username, clientIp(req));
  if (await lockedUntil(key)) throw httpError(429, `Too many failed attempts. Try again in ${config.lockoutMinutes} minutes.`);
  const u = await one('SELECT * FROM users WHERE id = $1', [c.user_id]);
  if (!u || u.disabled || !u.mfa_enabled) throw httpError(401, 'Sign-in not possible.');
  let ok = false;
  if (code) {
    const step = verifyTotp(decrypt(u.mfa_secret), code, { lastStep: u.mfa_last_step });
    if (step !== null) {
      // only one use per code: the step must be newer than the last one used
      const r = await q('UPDATE users SET mfa_last_step = $2 WHERE id = $1 AND (mfa_last_step IS NULL OR mfa_last_step < $2)', [u.id, step]);
      ok = r.rowCount === 1;
    }
  } else if (recoveryCode) {
    const h = sha256(String(recoveryCode).trim().toLowerCase());
    const r = await q(`UPDATE users SET mfa_recovery = mfa_recovery - $2 WHERE id = $1 AND mfa_recovery ? $2`, [u.id, h]);
    ok = r.rowCount === 1;
    if (ok) audit(req, 'mfa.recovery_code_used', { username: u.username });
  }
  if (!ok) {
    await q('UPDATE login_challenges SET attempts = attempts + 1 WHERE token_hash = $1', [sha256(challenge)]);
    await q('DELETE FROM login_challenges WHERE token_hash = $1 AND attempts >= 5', [sha256(challenge)]);
    await recordFailure(key);
    audit(req, 'login.failed', { username: u.username, reason: 'bad mfa code' });
    throw httpError(401, 'Wrong code.');
  }
  await q('DELETE FROM login_challenges WHERE token_hash = $1', [sha256(challenge)]);
  await q('DELETE FROM login_failures WHERE key = $1', [key]);
  const user = await createSession(req, res, u, { remember: c.remember, method: c.auth_method || 'local' });
  return { user };
}

export async function logout(req, res) {
  const t = readCookie(req);
  if (t) await q('DELETE FROM sessions WHERE token_hash = $1', [sha256(t)]);
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export async function changeOwnPassword(req, current, next) {
  const u = await one('SELECT * FROM users WHERE id = $1', [req.userId]);
  if (!u) throw httpError(400, 'Not available.');
  if (u.auth_source !== 'local') throw httpError(400, `You sign in with ${u.auth_source.toUpperCase()}; change your password there.`);
  if (!(await bcrypt.compare(current || '', u.password_hash || DUMMY_HASH))) throw httpError(400, 'Current password is wrong.');
  const prob = passwordProblem(next);
  if (prob) throw httpError(400, prob);
  if (await bcrypt.compare(next, u.password_hash)) throw httpError(400, 'New password must be different from the current one.');
  await tx(async (c) => {
    await c.query('UPDATE users SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE id = $1', [u.id, await bcrypt.hash(next, BCRYPT_COST)]);
    await c.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [u.id, req.sessionHash]); // sign out other devices
  });
}

export async function checkOwnPassword(userId, password) {
  const u = await one('SELECT * FROM users WHERE id = $1', [userId]);
  if (!u) return false;
  if (u.auth_source !== 'local') return true; // SSO/LDAP users: the session itself proves identity
  return bcrypt.compare(password || '', u.password_hash || DUMMY_HASH);
}

// List sessions: your own, or everyone's (admin)
export async function listSessions({ userId, currentHash }) {
  const { rows } = await q(
    `SELECT s.token_hash, s.created_at, s.last_seen, s.expires_at, s.persistent, s.ip, s.user_agent, s.auth_method, u.username
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.expires_at > now() AND s.last_seen > now() - make_interval(mins => $2) ${userId ? 'AND s.user_id = $1' : 'AND $1::bigint IS NULL'}
     ORDER BY s.last_seen DESC LIMIT 500`,
    [userId ?? null, config.sessionIdleMinutes]);
  return rows.map((r) => ({
    id: r.token_hash.slice(0, 16), // short id only, never the full hash
    username: r.username, ip: r.ip, userAgent: r.user_agent, persistent: r.persistent, method: r.auth_method || 'local',
    createdAt: r.created_at.toISOString(), lastSeen: r.last_seen.toISOString(), expiresAt: r.expires_at.toISOString(),
    current: r.token_hash === currentHash,
  }));
}

export async function revokeSession({ shortId, userId }) {
  if (!/^[0-9a-f]{16}$/.test(shortId || '')) throw httpError(400, 'Bad session id.');
  const r = await q(
    `DELETE FROM sessions WHERE token_hash LIKE $1 || '%' ${userId ? 'AND user_id = $2' : 'AND $2::bigint IS NULL'} RETURNING user_id`,
    [shortId, userId ?? null]);
  if (!r.rowCount) throw httpError(404, 'Session not found.');
}

export async function cleanupSessions() {
  await q(`DELETE FROM sessions WHERE expires_at < now() OR last_seen < now() - make_interval(mins => $1)`, [config.sessionIdleMinutes]);
  await q(`DELETE FROM login_failures WHERE updated_at < now() - interval '1 day' AND (locked_until IS NULL OR locked_until < now())`);
  await q(`DELETE FROM login_challenges WHERE expires_at < now()`);
  await q(`DELETE FROM oauth_states WHERE expires_at < now()`);
}

// ---------- API keys ----------
// Format: oo_<8 hex prefix>_<secret>. Only a SHA-256 of the whole key is stored.
export function newApiKey() {
  const prefix = crypto.randomBytes(4).toString('hex');
  const key = `oo_${prefix}_${randomToken(24)}`;
  return { key, prefix, hash: sha256(key) };
}

async function apiKeyAuth(req, res, next, key) {
  if (!/^oo_[0-9a-f]{8}_[A-Za-z0-9_-]{20,64}$/.test(key)) return res.status(401).json({ error: 'Invalid API key.' });
  await loadRoles();
  const k = await one(`UPDATE api_keys SET last_used = now()
                       WHERE key_hash = $1 AND NOT revoked AND (expires_at IS NULL OR expires_at > now()) RETURNING *`, [sha256(key)]);
  if (!k) return res.status(401).json({ error: 'Invalid, revoked or expired API key.' });
  let perms = [...permsOf(k.role)];
  let owner = null;
  if (k.owner_user_id) {
    owner = await one('SELECT * FROM users WHERE id = $1 AND NOT disabled', [k.owner_user_id]);
    if (!owner) return res.status(401).json({ error: 'The owner of this API key is disabled.' });
    // a key never has more rights than its owner has today
    const ownerPerms = permsOf(owner.role);
    if (!ownerPerms.has('*')) perms = perms.includes('*') ? [...ownerPerms] : perms.filter((p) => ownerPerms.has(p));
  }
  req.user = {
    username: owner ? owner.username : `apikey:${k.name}`,
    role: k.role,
    permissions: perms,
    apiKey: { id: k.id, name: k.name, prefix: k.prefix },
    authSource: 'apikey',
  };
  req.userId = owner?.id ?? null;
  req.apiKeyId = k.id;
  next();
}

// ---------- middleware ----------
const RESTRICTED_ALLOWED = new Set(['/me', '/logout', '/me/mfa/setup', '/me/mfa/enable', '/brand']);

export async function requireAuth(req, res, next) {
  try {
    const authz = req.headers.authorization;
    if (authz && /^Bearer\s+/i.test(authz)) return await apiKeyAuth(req, res, next, authz.replace(/^Bearer\s+/i, '').trim());
    const t = readCookie(req);
    if (!t) return res.status(401).json({ error: 'Please sign in.' });
    await loadRoles();
    const h = sha256(t);
    // one round trip: check + slide the idle timer + load the user
    const row = await one(
      `UPDATE sessions s SET last_seen = now()
       FROM users u
       WHERE s.token_hash = $1 AND u.id = s.user_id
         AND s.expires_at > now() AND s.last_seen > now() - make_interval(mins => $2)
         AND NOT u.disabled
       RETURNING u.*, s.restricted AS session_restricted, s.auth_method AS session_method`,
      [h, config.sessionIdleMinutes]);
    if (!row) {
      await q('DELETE FROM sessions WHERE token_hash = $1', [h]);
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }
    req.user = { ...publicUser(row), sessionMethod: row.session_method || 'local' };
    req.userId = row.id;
    req.sessionHash = h;
    if (row.session_restricted === 'mfa_setup') {
      // allow MFA setup once it is done (session is lifted in enableMfa)
      req.user.restricted = 'mfa_setup';
      if (!RESTRICTED_ALLOWED.has(req.path)) {
        return res.status(403).json({ error: 'Set up two-factor sign-in first.', mfaSetupRequired: true });
      }
    }
    next();
  } catch (e) {
    next(e);
  }
}

export function requirePerm(perm) {
  const mw = (req, res, next) => {
    if (hasPerm(req.user, perm)) return next();
    audit(req, 'access.denied', { path: req.originalUrl, need: perm });
    res.status(403).json({ error: `You need the "${perm}" permission for this.` });
  };
  mw._perm = perm;
  return mw;
}

// Old name kept for compatibility: role names map to a typical permission.
export function requireRole(min) {
  return requirePerm({ viewer: 'view', operator: 'dashboards.edit', admin: 'users.manage' }[min] || min);
}

// Blocks cross-site form posts: our own JS always sends this header. API keys skip it (no cookies involved).
export function requireAjaxHeader(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers.authorization && /^Bearer\s+/i.test(req.headers.authorization)) return next();
  if (req.headers['x-requested-with'] !== 'observa') return res.status(403).json({ error: 'Missing request header.' });
  next();
}

export function requireUser(req, res, next) {
  if (!req.userId) return res.status(400).json({ error: 'This needs a signed-in user (not a service API key).' });
  next();
}

// ---------- per-user preferences ----------
const PREF_KEYS = new Set(['timeRange', 'metricsQuery', 'logsQuery', 'tracesQuery', 'homePage', 'dashboardVars', 'navCollapsed', 'theme',
  'refreshMs', 'sidebarCollapsed', 'metricsHistory']); // web UI 2.0: auto-refresh interval, collapsed sidebar, recent queries

export async function getPrefs(userId) {
  if (!userId) return {};
  const { rows } = await q('SELECT key, value FROM user_preferences WHERE user_id = $1', [userId]);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function setPrefs(userId, prefs) {
  const entries = Object.entries(prefs || {}).filter(([k]) => PREF_KEYS.has(k));
  if (!entries.length) throw httpError(400, `Allowed keys: ${[...PREF_KEYS].join(', ')}`);
  for (const [k, v] of entries) {
    const json = JSON.stringify(v);
    if (json.length > 20_000) throw httpError(400, `Value for ${k} is too large.`);
    await q(`INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES ($1,$2,$3,now())
             ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [userId, k, json]);
  }
}
