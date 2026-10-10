// ObservaOne Agent control plane: enrollment and heartbeats. Called by agents, not by people.
//
//   POST /api/agent/v1/enroll      Authorization: Bearer oat_...   (enrollment token from the Agents page)
//        -> 201 { agentId, host, credential, heartbeatSeconds, ... }   the credential is shown ONCE
//   POST /api/agent/v1/heartbeat   Authorization: Bearer oac_...   (the agent's own credential)
//        -> 200 { status, heartbeatSeconds, latestVersion }
//
// The server decides the agent's identity: the agent id comes from the credential, never from the body.
// Metrics/logs/traces do NOT pass through here: they go to /ingest/agent/... (see verifyAgent in agents.js),
// so a Prometheus outage never makes enrollment or heartbeats fail, and the other way round.
import express from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { q, one, tx } from '../db.js';
import { audit, clientIp } from '../store.js';
import { sha256, randomToken } from '../secrets.js';
import { counterDelta, agentStatus, agentProblems } from '../health.js';

export const AGENT_LATEST = '1.1.0';
export const ENROLL_TOKEN_RE = /^oat_[0-9a-f]{8}_[A-Za-z0-9_-]{20,64}$/;
export const CREDENTIAL_RE = /^oac_([0-9a-f]{20})_([A-Za-z0-9_-]{43})$/;
const PLATFORMS = ['linux'];                     // enrollment is implemented for the Linux agent
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const LABEL_RE = /^[A-Za-z0-9._-]{0,64}$/;
const LABEL_KEY_RE = /^[a-z][a-z0-9_]{0,30}$/;
const RESERVED_LABELS = new Set(['host', 'job', 'instance', 'agent', 'os', 'platform', 'env', 'role', 'cluster', '__name__']);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (res, status, code, message) => res.status(status).json({ error: message, code });

// ---------------- small in-memory rate limiter (per process; enough for one UI container) ----------------
const buckets = new Map();
export function rateLimited(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start > windowMs) { b = { start: now, n: 0 }; buckets.set(key, b); }
  b.n += 1;
  if (buckets.size > 50_000) buckets.clear();
  return b.n > max;
}
export function resetRateLimits() { buckets.clear(); }

// ---------------- input checks ----------------
const str = (v, re, max = 128) => (typeof v === 'string' && v.length <= max && (!re || re.test(v)) ? v : null);
const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

function parseEnroll(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { err: 'Body must be a JSON object.' };
  const hostname = str(b.hostname, HOST_RE, 63);
  if (!hostname) return { err: 'hostname is required: letters, digits, . _ - (max 63).' };
  const platform = b.platform ?? 'linux';
  if (!PLATFORMS.includes(platform)) return { err: `platform must be one of: ${PLATFORMS.join(', ')}.` };
  const arch = str(b.arch, /^(amd64|arm64)$/, 8);
  if (!arch) return { err: 'arch must be amd64 or arm64.' };
  const version = str(b.version, /^\d{1,3}\.\d{1,3}\.\d{1,3}$/, 16);
  if (!version) return { err: 'version must look like 1.2.3.' };
  const env = b.env == null || b.env === '' ? '' : str(b.env, LABEL_RE, 64);
  const role = b.role == null || b.role === '' ? '' : str(b.role, LABEL_RE, 64);
  if (env === null || role === null) return { err: 'env and role may only use letters, digits, . _ - (max 64).' };
  const machine = b.machineHash == null || b.machineHash === '' ? '' : str(b.machineHash, /^[0-9a-f]{64}$/, 64);
  if (machine === null) return { err: 'machineHash must be 64 hex characters.' };
  const labels = {};
  if (b.labels != null) {
    if (typeof b.labels !== 'object' || Array.isArray(b.labels)) return { err: 'labels must be an object.' };
    const e = Object.entries(b.labels);
    if (e.length > 10) return { err: 'At most 10 labels.' };
    for (const [k, v] of e) {
      if (!LABEL_KEY_RE.test(k) || RESERVED_LABELS.has(k)) return { err: `Label name "${String(k).slice(0, 40)}" is not allowed.` };
      if (str(v, LABEL_RE, 64) === null) return { err: `Label ${k}: value may only use letters, digits, . _ - (max 64).` };
      labels[k] = v;
    }
  }
  return { v: { hostname, platform, arch, version, env, role, machine, labels, os: text(b.os, 100), kernel: text(b.kernel, 100) } };
}

function parseHeartbeat(b) {
  if (b == null) b = {};
  if (typeof b !== 'object' || Array.isArray(b)) return { err: 'Body must be a JSON object.' };
  const version = b.version == null ? null : str(b.version, /^\d{1,3}\.\d{1,3}\.\d{1,3}$/, 16);
  if (b.version != null && !version) return { err: 'version must look like 1.2.3.' };
  const st = (x) => (['running', 'stopped', 'failed', 'missing', 'unknown'].includes(x) ? x : undefined);
  const c = b.collectors && typeof b.collectors === 'object' ? b.collectors : {};
  const n = (x, max = 1e15) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= max ? x : null);
  return {
    v: {
      version,
      uptimeSeconds: n(b.uptimeSeconds, 1e10),
      bootTime: n(b.bootTime, 4102444800), // epoch seconds, before 2100
      uploadFailedTotal: n(b.uploadFailedTotal),
      collectors: { forwarder: st(c.forwarder), exporter: st(c.exporter) },
      lastError: text(b.lastError, 300),
      kernel: text(b.kernel, 100),
    },
  };
}

// ---------------- credential check ----------------
const credCache = new Map(); // agent id -> { hash, blocked, exp }
export function forgetAgentCredential(id) { if (id) credCache.delete(id); else credCache.clear(); }

// Returns the agent row for a valid credential, or null. Constant-time comparison of the hash.
export async function agentForCredential(cred) {
  const m = CREDENTIAL_RE.exec(cred || '');
  if (!m) return null;
  const id = `agt_${m[1]}`;
  let c = credCache.get(id);
  if (!c || c.exp < Date.now()) {
    const row = await one('SELECT id, host, platform, blocked, credential_hash FROM agents WHERE id = $1 AND credential_hash IS NOT NULL', [id]);
    if (!row) { credCache.delete(id); return null; }
    c = { row, exp: Date.now() + 30_000 };
    if (credCache.size > 20_000) credCache.clear();
    credCache.set(id, c);
  }
  const a = Buffer.from(sha256(cred)), b = Buffer.from(c.row.credential_hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return c.row;
}

const bearer = (req) => (/^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '') || [])[1] || '';

// ---------------- router ----------------
export const agentControlRouter = express.Router();
// small bodies only (the main API allows 200 kB; nothing here needs more than a few hundred bytes)
agentControlRouter.use('/agent/v1', express.json({ limit: '8kb', type: () => true }));

agentControlRouter.post('/agent/v1/enroll', wrap(async (req, res) => {
  const ip = clientIp(req);
  if (rateLimited(`enroll:${ip}`, config.agent.enrollPerIpPer10Min, 600_000)) {
    audit(req, 'agent.enroll.rate_limited', { username: 'agent' });
    res.set('Retry-After', '600');
    return fail(res, 429, 'rate_limited', 'Too many enrollment attempts from this address. Wait 10 minutes.');
  }
  const token = bearer(req);
  if (!ENROLL_TOKEN_RE.test(token)) {
    audit(req, 'agent.enroll.denied', { username: 'agent', reason: 'malformed_token' });
    return fail(res, 401, 'invalid_token', 'Enrollment token missing or malformed.');
  }
  const p = parseEnroll(req.body);
  if (p.err) return fail(res, 400, 'bad_request', p.err);
  const v = p.v;

  const credentialSecret = randomToken(32); // 43 base64url characters
  const out = await tx(async (c) => {
    // the token row is locked: concurrent enrollments with the same token are serialised (uses counted exactly)
    const t = (await c.query('SELECT * FROM agent_tokens WHERE token_hash = $1 FOR UPDATE', [sha256(token)])).rows[0];
    if (!t) return { deny: 'invalid_token', msg: 'Unknown enrollment token.' };
    if (t.revoked) return { deny: 'token_revoked', msg: 'This enrollment token was revoked. Create a new one on the Agents page.', prefix: t.prefix };
    if (t.expires_at && new Date(t.expires_at) <= new Date()) return { deny: 'token_expired', msg: 'This enrollment token has expired. Create a new one on the Agents page.', prefix: t.prefix };
    if (t.max_uses != null && t.uses >= t.max_uses) return { deny: 'token_used_up', msg: `This enrollment token was already used ${t.uses} time(s), its limit. Create a new one.`, prefix: t.prefix };

    // Same machine enrolling again (re-install after the credential was removed): take over its old record,
    // but only when that record is not currently online - a live agent cannot be hijacked this way.
    let reuse = null;
    if (v.machine) {
      reuse = (await c.query(`SELECT id, host, last_heartbeat FROM agents
                              WHERE platform = $1 AND machine_hash = $2 AND lower(host) = lower($3) AND credential_hash IS NOT NULL
                              FOR UPDATE`, [v.platform, v.machine, v.hostname])).rows[0] || null;
      if (reuse && reuse.last_heartbeat && Date.now() - new Date(reuse.last_heartbeat).getTime() < config.agent.onlineSeconds * 1000) {
        return { deny: 'agent_online', status: 409, msg: `An agent for ${reuse.host} on this machine is online right now. Uninstall it there, or remove it on the Agents page, before enrolling again.` };
      }
    }
    const idHex = crypto.randomBytes(10).toString('hex');
    const id = reuse ? reuse.id : `agt_${idHex}`;
    const credential = `oac_${id.slice(4)}_${credentialSecret}`;

    let host = v.hostname;
    if (reuse) {
      await c.query(`UPDATE agents SET credential_hash = $2, os = $3, arch = $4, version = $5, env = $6, role = $7, labels = $8,
                       kernel = $9, ip = $10, token_id = $11, enrolled_at = now(), last_heartbeat = NULL, blocked = FALSE, diag = '{}'
                     WHERE id = $1`,
      [id, sha256(credential), v.os, v.arch, v.version, v.env, v.role, JSON.stringify(v.labels), v.kernel, ip, t.id]);
      host = reuse.host;
    } else {
      // Another machine already uses this host name: never overwrite it, give this one a distinct name.
      for (let i = 1; ; i++) {
        const name = i === 1 ? v.hostname : `${v.hostname}-${i}`;
        await c.query('SAVEPOINT ins');
        try {
          await c.query(`INSERT INTO agents (id, host, platform, os, arch, version, env, role, labels, kernel, ip, token_id,
                                             credential_hash, machine_hash, enrolled_at, first_seen, last_seen)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now(), now(), now())`,
          [id, name, v.platform, v.os, v.arch, v.version, v.env, v.role, JSON.stringify(v.labels), v.kernel, ip, t.id, sha256(credential), v.machine]);
          await c.query('RELEASE SAVEPOINT ins');
          host = name;
          break;
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT ins');
          if (e.code !== '23505' || i >= 50) throw e;
        }
      }
    }
    await c.query('UPDATE agent_tokens SET uses = uses + 1, last_used = now() WHERE id = $1', [t.id]);
    return { id, host, credential, renamed: host !== v.hostname, reused: !!reuse, prefix: t.prefix };
  });

  if (out.deny) {
    audit(req, 'agent.enroll.denied', { username: 'agent', reason: out.deny, prefix: out.prefix, hostname: v.hostname });
    return fail(res, out.status || 401, out.deny, out.msg);
  }
  forgetAgentCredential(out.id);
  audit(req, out.reused ? 'agent.reenroll' : 'agent.enroll', {
    username: 'agent', id: out.id, host: out.host, requestedHost: v.hostname, platform: v.platform, token: out.prefix, version: v.version,
  });
  res.status(201).json({
    agentId: out.id,
    host: out.host,                       // use this as the "host" label: it is unique among enrolled agents
    renamed: out.renamed,
    reenrolled: out.reused,
    credential: out.credential,           // shown once; the server keeps only its SHA-256
    heartbeatSeconds: config.agent.heartbeatSeconds,
    onlineSeconds: config.agent.onlineSeconds,
    latestVersion: AGENT_LATEST,
  });
}));

const lastWrite = new Map(); // agent id -> ms of the last heartbeat written (bursts are answered, not written)

agentControlRouter.post('/agent/v1/heartbeat', wrap(async (req, res) => {
  const ip = clientIp(req);
  const cred = bearer(req);
  const agent = cred ? await agentForCredential(cred) : null;
  if (!agent) {
    if (rateLimited(`hbfail:${ip}`, 30, 60_000)) { res.set('Retry-After', '60'); return fail(res, 429, 'rate_limited', 'Too many failed heartbeats from this address.'); }
    if (!rateLimited(`hbfail-audit:${ip}`, 1, 300_000)) audit(req, 'agent.heartbeat.denied', { username: 'agent', reason: cred ? 'invalid_credential' : 'missing_credential' });
    return fail(res, 401, 'invalid_credential', 'Agent credential missing or not valid. Re-enroll this agent.');
  }
  if (agent.blocked) return fail(res, 403, 'blocked', 'This agent is blocked on the Agents page.');
  const p = parseHeartbeat(req.body);
  if (p.err) return fail(res, 400, 'bad_request', p.err);
  const v = p.v;

  const now = Date.now();
  const prevWrite = lastWrite.get(agent.id) || 0;
  if (now - prevWrite >= 5_000) { // at most one write per agent every 5 s: a burst cannot overload the database
    lastWrite.set(agent.id, now);
    if (lastWrite.size > 50_000) lastWrite.clear();
    const prev = (await one('SELECT diag FROM agents WHERE id = $1', [agent.id]))?.diag || {};
    const failures = counterDelta(Number(prev.uploadFailedTotal), v.uploadFailedTotal ?? NaN);
    const diag = {
      collectors: v.collectors,
      uploadFailedTotal: v.uploadFailedTotal,
      uploadFailures: failures ?? null,
      lastError: v.lastError || '',
      uptimeSeconds: v.uptimeSeconds,
      agentIp: ip,
    };
    // server time only, and never backwards (GREATEST) even if requests arrive out of order
    await q(`UPDATE agents SET last_heartbeat = GREATEST(COALESCE(last_heartbeat, now()), now()), heartbeats = heartbeats + 1,
               version = COALESCE($2, version), boot_time = CASE WHEN $3::float8 IS NULL THEN boot_time ELSE to_timestamp($3::float8) END,
               kernel = CASE WHEN $4 = '' THEN kernel ELSE $4 END, diag = $5, ip = $6
             WHERE id = $1`, [agent.id, v.version, v.bootTime, v.kernel, JSON.stringify(diag), ip]);
    if (prev.collectors === undefined) audit(req, 'agent.first_heartbeat', { username: 'agent', id: agent.id, host: agent.host });
  }
  const row = await one('SELECT * FROM agents WHERE id = $1', [agent.id]);
  res.json({
    agentId: agent.id,
    status: describeAgent(row, now).status,
    heartbeatSeconds: config.agent.heartbeatSeconds,
    latestVersion: AGENT_LATEST,
  });
}));

// Status + problems for one agents row (used by the API and the heartbeat answer)
export function describeAgent(a, nowMs = Date.now()) {
  const t = (x) => (x ? new Date(x).getTime() : null);
  const base = { nowMs, lastHeartbeatMs: t(a.last_heartbeat), lastDataMs: t(a.last_seen), onlineSeconds: config.agent.onlineSeconds };
  const problems = a.credential_hash
    ? agentProblems({ ...base, version: a.version, minVersion: config.agent.minVersion, diag: a.diag || {} })
    : [];
  const s = agentStatus({
    nowMs, blocked: a.blocked, problems, onlineSeconds: config.agent.onlineSeconds, offlineSeconds: config.agent.offlineSeconds,
    lastHeartbeatMs: base.lastHeartbeatMs,
    // legacy agents (no credential) have no heartbeat: judge them by their last upload
    lastDataMs: a.credential_hash ? null : base.lastDataMs,
  });
  return { ...s, problems };
}

// Errors from this router: short JSON, never a stack trace or a database message.
// eslint-disable-next-line no-unused-vars
agentControlRouter.use('/agent/v1', (err, req, res, next) => {
  if (err.type === 'entity.too.large') return fail(res, 413, 'too_large', 'Request body too large.');
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'bad_request', 'Body is not valid JSON.');
  console.error('[agent-control]', err.message);
  return fail(res, 503, 'unavailable', 'The server could not process the request. Try again later.');
});
