// ObservaOne Agent: enrollment tokens, the token check Nginx calls for every agent upload,
// and the fleet list shown on the Agents page.
import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { q, one } from '../db.js';
import { audit } from '../store.js';
import { sha256, randomToken } from '../secrets.js';
import { requirePerm, httpError } from '../auth.js';
import { promInstant } from '../datasources.js';
import { cpuByHost, memByHost, diskFreeByHost } from '../queries.js';

export const AGENT_VERSIONS = {
  agent: '1.0.0',
  otelcol: '0.162.0',
  nodeExporter: '1.12.1',
  windowsExporter: '0.31.8',
  cadvisor: '0.60.6',
  kubeStateMetrics: '2.20.0',
};
export const PLATFORMS = ['linux', 'windows', 'docker', 'kubernetes'];
const TOKEN_RE = /^oat_[0-9a-f]{8}_[A-Za-z0-9_-]{20,64}$/;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------- token check (called by Nginx auth_request, not reachable from outside) ----------------
const tokenCache = new Map(); // token hash -> { id, env, exp }
const seen = new Map(); // agent id -> { at, blocked }
const TOKEN_TTL = 60_000;
const SEEN_WRITE_EVERY = 30_000;

const clean = (v, max = 128) => String(v || '').replace(/[^\w.:@/ ()+,-]/g, '').trim().slice(0, max);

async function tokenFor(token) {
  const h = sha256(token);
  const c = tokenCache.get(h);
  if (c && c.exp > Date.now()) return c;
  const row = await one(`SELECT id, env FROM agent_tokens
                         WHERE token_hash = $1 AND NOT revoked AND (expires_at IS NULL OR expires_at > now())`, [h]);
  if (!row) { tokenCache.delete(h); return null; }
  const t = { id: Number(row.id), env: row.env, exp: Date.now() + TOKEN_TTL };
  if (tokenCache.size > 5000) tokenCache.clear();
  tokenCache.set(h, t);
  return t;
}

export async function verifyAgent(req, res) {
  try {
    const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
    if (!m || !TOKEN_RE.test(m[1])) return res.status(401).end();
    const t = await tokenFor(m[1]);
    if (!t) return res.status(401).end();
    const host = clean(req.get('x-agent-host'));
    if (!host) return res.status(403).end();
    const platform = PLATFORMS.includes(req.get('x-agent-platform')) ? req.get('x-agent-platform') : 'linux';
    const id = clean(req.get('x-agent-id'), 80) || `${platform}:${host}`;
    const s = seen.get(id);
    if (s && Date.now() - s.at < SEEN_WRITE_EVERY) return res.status(s.blocked ? 403 : 204).end();
    const row = await one(`
      INSERT INTO agents (id, host, platform, os, arch, version, env, role, cluster, ip, token_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (id) DO UPDATE SET host = $2, platform = $3, os = $4, arch = $5, version = $6, env = $7, role = $8,
        cluster = $9, ip = $10, token_id = $11, last_seen = now()
      RETURNING blocked, (xmax = 0) AS inserted`,
    [id, host, platform, clean(req.get('x-agent-os')), clean(req.get('x-agent-arch'), 16), clean(req.get('x-agent-version'), 32),
      clean(req.get('x-agent-env'), 64), clean(req.get('x-agent-role'), 64), clean(req.get('x-agent-cluster'), 64),
      clean(req.get('x-real-ip') || req.ip, 64), t.id]);
    await q('UPDATE agent_tokens SET last_used = now() WHERE id = $1', [t.id]);
    if (row.inserted) audit(null, 'agent.registered', { username: 'agent', id, host, platform });
    if (seen.size > 20000) seen.clear();
    seen.set(id, { at: Date.now(), blocked: row.blocked });
    return res.status(row.blocked ? 403 : 204).end();
  } catch (e) {
    console.error('[agents] verify failed:', e.message);
    return res.status(503).end();
  }
}

// ---------------- helpers ----------------
function certInfo(host = '') {
  try {
    const pem = fs.readFileSync(config.agent.serverCertFile);
    const x = new crypto.X509Certificate(pem);
    const bare = host.replace(/^\[|\]$/g, '');
    return {
      // names on the certificate, and whether the address in the install command is one of them
      // (agents check this; a mismatch makes the install fail with a certificate error)
      names: (x.subjectAltName || '').split(/,\s*/).filter(Boolean).map((s) => s.replace(/^(DNS|IP Address):/, '')),
      matches: !bare ? null : /^[\d.]+$|:/.test(bare) ? !!x.checkIP(bare) : !!x.checkHost(bare),
      available: true,
      sha256: x.fingerprint256.replace(/:/g, '').toLowerCase(), // SHA-256 of the DER certificate (what browsers show)
      // curl --pinnedpubkey value: checked even with -k, so the installer download is safe with a self-signed cert
      spkiPin: `sha256//${crypto.createHash('sha256').update(x.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')}`,
      subject: x.subject.replace(/\n/g, ', '),
      issuer: x.issuer.replace(/\n/g, ', '),
      selfSigned: x.subject === x.issuer,
      validTo: new Date(x.validTo).toISOString(),
    };
  } catch {
    return { available: false };
  }
}

// The HTTPS address agents use. PUBLIC_URL when it is a real https address; otherwise the address
// the browser used (through Nginx). A PUBLIC_URL pointing at localhost / 127.x / ::1 (the default when
// SERVER_NAME is not set) is ignored, so a server opened as https://10.0.0.5/ hands out https://10.0.0.5.
const LOOPBACK = /^https?:\/\/(localhost|127(?:\.\d+){3}|\[::1\])(?::\d+)?(?:\/|$)/i;
function serverUrl(req) {
  if (/^https:\/\//.test(config.publicUrl) && !LOOPBACK.test(config.publicUrl)) return config.publicUrl.replace(/:443$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`.replace(/^https:\/\/([^/]+):443$/, 'https://$1');
}

async function safeByHost(query) {
  try {
    const r = await promInstant(query);
    return new Map(r.map((x) => [x.metric.host, Number(x.value[1])]));
  } catch {
    return new Map();
  }
}

const tokenRow = (t) => ({
  id: Number(t.id), name: t.name, prefix: t.prefix, env: t.env, createdBy: t.created_by, createdAt: t.created_at,
  lastUsed: t.last_used, expiresAt: t.expires_at, revoked: t.revoked, agents: Number(t.agents || 0),
  expired: !!(t.expires_at && new Date(t.expires_at) < new Date()),
});

// ---------------- router (behind sign-in) ----------------
export const agentsRouter = express.Router();

agentsRouter.get('/agents', requirePerm('view'), wrap(async (req, res) => {
  const { rows } = await q(`SELECT a.*, t.name AS token_name, EXTRACT(EPOCH FROM (now() - a.last_seen))::int AS age
                        FROM agents a LEFT JOIN agent_tokens t ON t.id = a.token_id ORDER BY a.host`);
  const [cpu, mem, disk, fails, queue] = await Promise.all([
    safeByHost(cpuByHost()), safeByHost(memByHost()), safeByHost(diskFreeByHost()),
    safeByHost('sum by (host) (increase({__name__=~"otelcol_exporter_send_failed_(metric_points|log_records|spans)_total", agent="observaone"}[15m]))'),
    safeByHost('sum by (host) (otelcol_exporter_queue_size{agent="observaone"})'),
  ]);
  const agents = rows.map((a) => {
    const status = a.blocked ? 'blocked' : a.age <= config.agent.onlineSeconds ? 'online' : 'offline';
    return {
      id: a.id, host: a.host, platform: a.platform, os: a.os, arch: a.arch, version: a.version, env: a.env, role: a.role,
      cluster: a.cluster, ip: a.ip, token: a.token_name || null, firstSeen: a.first_seen, lastSeen: a.last_seen,
      secondsAgo: a.age, status, outdated: !!a.version && a.version !== AGENT_VERSIONS.agent,
      cpu: cpu.get(a.host) ?? null, mem: mem.get(a.host) ?? null, diskFree: disk.get(a.host) ?? null,
      sendFailures: fails.get(a.host) ?? 0, queue: queue.get(a.host) ?? 0,
    };
  });
  const count = (s) => agents.filter((a) => a.status === s).length;
  res.json({
    agents,
    summary: {
      total: agents.length, online: count('online'), offline: count('offline'), blocked: count('blocked'),
      outdated: agents.filter((a) => a.outdated).length,
      byPlatform: Object.fromEntries(PLATFORMS.map((p) => [p, agents.filter((a) => a.platform === p).length])),
    },
    latest: AGENT_VERSIONS.agent,
  });
}));

agentsRouter.get('/agents/install-info', requirePerm('view'), wrap(async (req, res) => {
  const server = serverUrl(req);
  let host = '';
  try { host = new URL(server).hostname; } catch { /* leave empty */ }
  res.json({ server, cert: certInfo(host), versions: AGENT_VERSIONS, platforms: PLATFORMS });
}));

agentsRouter.post('/agents/:id/block', requirePerm('integrations.manage'), wrap(async (req, res) => {
  const r = await one('UPDATE agents SET blocked = TRUE WHERE id = $1 RETURNING host', [req.params.id]);
  if (!r) throw httpError(404, 'Agent not found.');
  seen.delete(req.params.id);
  audit(req, 'agent.block', { id: req.params.id, host: r.host });
  res.json({ ok: true });
}));

agentsRouter.post('/agents/:id/unblock', requirePerm('integrations.manage'), wrap(async (req, res) => {
  const r = await one('UPDATE agents SET blocked = FALSE WHERE id = $1 RETURNING host', [req.params.id]);
  if (!r) throw httpError(404, 'Agent not found.');
  seen.delete(req.params.id);
  audit(req, 'agent.unblock', { id: req.params.id, host: r.host });
  res.json({ ok: true });
}));

// Forget an agent that was uninstalled. If it is still sending with a valid token it comes back.
agentsRouter.delete('/agents/:id', requirePerm('integrations.manage'), wrap(async (req, res) => {
  const r = await one('DELETE FROM agents WHERE id = $1 RETURNING host', [req.params.id]);
  if (!r) throw httpError(404, 'Agent not found.');
  seen.delete(req.params.id);
  audit(req, 'agent.remove', { id: req.params.id, host: r.host });
  res.json({ ok: true });
}));

// ---- enrollment tokens ----
agentsRouter.get('/agent-tokens', requirePerm('integrations.manage'), wrap(async (req, res) => {
  const { rows } = await q(`SELECT t.*, (SELECT count(*) FROM agents a WHERE a.token_id = t.id) AS agents
                        FROM agent_tokens t ORDER BY t.revoked, t.created_at DESC`);
  res.json({ tokens: rows.map(tokenRow) });
}));

agentsRouter.post('/agent-tokens', requirePerm('integrations.manage'), wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const env = clean(req.body?.env, 64);
  const days = Number(req.body?.expiresDays || 0);
  if (!name || name.length > 60) throw httpError(400, 'Give the token a name (max 60 characters), e.g. "Production Linux servers".');
  if (!Number.isInteger(days) || days < 0 || days > 3650) throw httpError(400, 'Expiry must be 0 (never) to 3650 days.');
  const prefix = crypto.randomBytes(4).toString('hex');
  const token = `oat_${prefix}_${randomToken(24)}`;
  const r = await one(`INSERT INTO agent_tokens (name, prefix, token_hash, env, created_by, expires_at)
                       VALUES ($1,$2,$3,$4,$5, CASE WHEN $6::int > 0 THEN now() + make_interval(days => $6::int) END) RETURNING *`,
  [name, prefix, sha256(token), env, req.user.username, days]);
  audit(req, 'agent.token.create', { name, prefix, env });
  res.json({ token, ...tokenRow(r) });
}));

agentsRouter.delete('/agent-tokens/:id', requirePerm('integrations.manage'), wrap(async (req, res) => {
  const r = await one('UPDATE agent_tokens SET revoked = TRUE WHERE id = $1 AND NOT revoked RETURNING name, prefix', [Number(req.params.id) || 0]);
  if (!r) throw httpError(404, 'Token not found or already revoked.');
  tokenCache.clear();
  seen.clear();
  audit(req, 'agent.token.revoke', { name: r.name, prefix: r.prefix });
  res.json({ ok: true });
}));
