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
import { CREDENTIAL_RE, AGENT_LATEST, agentForCredential, forgetAgentCredential, describeAgent } from './agent-control.js';

export const AGENT_VERSIONS = {
  agent: AGENT_LATEST,
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
    if (!m) return res.status(401).end();

    // Enrolled agent (Linux agent 1.1+): its own credential; identity comes from the database, never from headers.
    if (CREDENTIAL_RE.test(m[1])) {
      const a = await agentForCredential(m[1]);
      if (!a) return res.status(401).end();
      if (a.blocked) return res.status(403).end();
      const s = seen.get(a.id);
      if (!s || Date.now() - s.at >= SEEN_WRITE_EVERY) {
        seen.set(a.id, { at: Date.now(), blocked: false });
        if (seen.size > 20000) seen.clear();
        await q('UPDATE agents SET last_seen = now() WHERE id = $1', [a.id]); // last DATA upload (heartbeats are separate)
      }
      return res.status(204).end();
    }

    // Older agents (Windows, Docker, Kubernetes, Linux 1.0): the shared enrollment token on every upload.
    if (!TOKEN_RE.test(m[1])) return res.status(401).end();
    const t = await tokenFor(m[1]);
    if (!t) return res.status(401).end();
    const host = clean(req.get('x-agent-host'));
    if (!host) return res.status(403).end();
    const platform = PLATFORMS.includes(req.get('x-agent-platform')) ? req.get('x-agent-platform') : 'linux';
    const id = clean(req.get('x-agent-id'), 80) || `${platform}:${host}`;
    const s = seen.get(id);
    if (s && Date.now() - s.at < SEEN_WRITE_EVERY) return res.status(s.blocked ? 403 : 204).end();
    // A shared token can never write as an ENROLLED agent: those prove who they are with their own credential.
    const row = await one(`
      INSERT INTO agents (id, host, platform, os, arch, version, env, role, cluster, ip, token_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (id) DO UPDATE SET host = $2, platform = $3, os = $4, arch = $5, version = $6, env = $7, role = $8,
        cluster = $9, ip = $10, token_id = $11, last_seen = now()
        WHERE agents.credential_hash IS NULL
      RETURNING blocked, (xmax = 0) AS inserted`,
    [id, host, platform, clean(req.get('x-agent-os')), clean(req.get('x-agent-arch'), 16), clean(req.get('x-agent-version'), 32),
      clean(req.get('x-agent-env'), 64), clean(req.get('x-agent-role'), 64), clean(req.get('x-agent-cluster'), 64),
      clean(req.get('x-real-ip') || req.ip, 64), t.id]);
    if (!row) { // the id belongs to an enrolled agent: refuse (impersonation attempt or a stale header)
      audit(null, 'agent.impersonation_refused', { username: 'agent', id, host });
      seen.set(id, { at: Date.now(), blocked: true });
      return res.status(403).end();
    }
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
function certInfo() {
  try {
    const pem = fs.readFileSync(config.agent.serverCertFile);
    const x = new crypto.X509Certificate(pem);
    return {
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

// The HTTPS address agents use. PUBLIC_URL when it is https, otherwise the address the browser used (through Nginx).
function serverUrl(req) {
  if (/^https:\/\//.test(config.publicUrl)) return config.publicUrl.replace(/:443$/, '');
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

const publicDiag = (d = {}) => ({
  collectors: d.collectors || null, uploadFailures: d.uploadFailures ?? null, lastError: d.lastError || '', uptimeSeconds: d.uptimeSeconds ?? null,
});

function toAgent(a, now, m) {
  const d = describeAgent(a, now);
  const enrolled = !!a.credential_hash;
  const lastData = a.last_seen && (!a.enrolled_at || new Date(a.last_seen) - new Date(a.enrolled_at) > 1000) ? a.last_seen : null;
  const get = (map) => (map && map.get(a.host)) ?? null;
  return {
    id: a.id, host: a.host, platform: a.platform, os: a.os, arch: a.arch, version: a.version, env: a.env, role: a.role,
    cluster: a.cluster, ip: a.ip, kernel: a.kernel || '', labels: a.labels || {}, token: a.token_name || null,
    enrolled, enrolledAt: a.enrolled_at || null, firstSeen: a.first_seen,
    lastHeartbeat: a.last_heartbeat || null, lastData, lastSeen: a.last_heartbeat || lastData || null,
    bootTime: a.boot_time || null,
    status: d.status, statusReason: d.reason, problems: d.problems, secondsAgo: d.ageSeconds,
    outdated: !!a.version && a.version !== AGENT_VERSIONS.agent,
    cpu: get(m.cpu), mem: get(m.mem), diskFree: get(m.disk),
    sendFailures: get(m.fails), queue: get(m.queue),
  };
}

const tokenRow = (t) => ({
  id: Number(t.id), name: t.name, prefix: t.prefix, env: t.env, createdBy: t.created_by, createdAt: t.created_at,
  lastUsed: t.last_used, expiresAt: t.expires_at, revoked: t.revoked, agents: Number(t.agents || 0),
  maxUses: t.max_uses == null ? null : Number(t.max_uses), uses: Number(t.uses || 0),
  usedUp: t.max_uses != null && Number(t.uses) >= Number(t.max_uses),
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
  const now = Date.now();
  const agents = rows.map((a) => toAgent(a, now, { cpu, mem, disk, fails, queue }));
  const count = (st) => agents.filter((a) => a.status === st).length;
  res.json({
    agents,
    summary: {
      total: agents.length,
      online: count('online') + count('attention'),      // sending heartbeats (attention = online with a problem)
      attention: count('attention'),
      notReporting: count('not_reporting'),
      offline: count('offline'),
      pending: count('pending'),
      blocked: count('blocked'),
      outdated: agents.filter((a) => a.outdated).length,
      byPlatform: Object.fromEntries(PLATFORMS.map((p) => [p, agents.filter((a) => a.platform === p).length])),
    },
    latest: AGENT_VERSIONS.agent,
    thresholds: { onlineSeconds: config.agent.onlineSeconds, offlineSeconds: config.agent.offlineSeconds, heartbeatSeconds: config.agent.heartbeatSeconds },
  });
}));

// One agent with its full diagnostics
agentsRouter.get('/agents/:id', requirePerm('view'), wrap(async (req, res, next) => {
  if (req.params.id === 'install-info') return next();
  const a = await one(`SELECT a.*, t.name AS token_name FROM agents a LEFT JOIN agent_tokens t ON t.id = a.token_id WHERE a.id = $1`, [req.params.id]);
  if (!a) throw httpError(404, 'Agent not found.', { state: 'not_found' });
  res.json({ agent: { ...toAgent(a, Date.now(), {}), diag: publicDiag(a.diag) } });
}));

agentsRouter.get('/agents/install-info', requirePerm('view'), wrap(async (req, res) => {
  res.json({ server: serverUrl(req), cert: certInfo(), versions: AGENT_VERSIONS, platforms: PLATFORMS });
}));

agentsRouter.post('/agents/:id/block', requirePerm('integrations.manage'), wrap(async (req, res) => {
  const r = await one('UPDATE agents SET blocked = TRUE WHERE id = $1 RETURNING host', [req.params.id]);
  if (!r) throw httpError(404, 'Agent not found.');
  seen.delete(req.params.id);
  forgetAgentCredential(req.params.id);
  audit(req, 'agent.block', { id: req.params.id, host: r.host });
  res.json({ ok: true });
}));

agentsRouter.post('/agents/:id/unblock', requirePerm('integrations.manage'), wrap(async (req, res) => {
  const r = await one('UPDATE agents SET blocked = FALSE WHERE id = $1 RETURNING host', [req.params.id]);
  if (!r) throw httpError(404, 'Agent not found.');
  seen.delete(req.params.id);
  forgetAgentCredential(req.params.id);
  audit(req, 'agent.unblock', { id: req.params.id, host: r.host });
  res.json({ ok: true });
}));

// Forget an agent that was uninstalled. If it is still sending with a valid token it comes back.
agentsRouter.delete('/agents/:id', requirePerm('integrations.manage'), wrap(async (req, res) => {
  const r = await one('DELETE FROM agents WHERE id = $1 RETURNING host', [req.params.id]);
  if (!r) throw httpError(404, 'Agent not found.');
  seen.delete(req.params.id);
  forgetAgentCredential(req.params.id);
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
  const maxUses = req.body?.maxUses == null || req.body.maxUses === '' || Number(req.body.maxUses) === 0 ? null : Number(req.body.maxUses);
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100000)) throw httpError(400, 'Max uses must be 1 to 100000, or empty for unlimited.');
  if (!name || name.length > 60) throw httpError(400, 'Give the token a name (max 60 characters), e.g. "Production Linux servers".');
  if (!Number.isInteger(days) || days < 0 || days > 3650) throw httpError(400, 'Expiry must be 0 (never) to 3650 days.');
  const prefix = crypto.randomBytes(4).toString('hex');
  const token = `oat_${prefix}_${randomToken(24)}`;
  const r = await one(`INSERT INTO agent_tokens (name, prefix, token_hash, env, created_by, expires_at, max_uses)
                       VALUES ($1,$2,$3,$4,$5, CASE WHEN $6::int > 0 THEN now() + make_interval(days => $6::int) END, $7) RETURNING *`,
  [name, prefix, sha256(token), env, req.user.username, days, maxUses]);
  audit(req, 'agent.token.create', { name, prefix, env, expiresDays: days || null, maxUses });
  res.set('Cache-Control', 'no-store'); // the only time the token is ever sent
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
