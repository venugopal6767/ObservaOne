// ObservaOne Agent control plane: enrollment and heartbeats. Called by agents, not by people.
//
//   POST /api/v1/agents/register             Bearer oat_... (enrollment token)  -> 201 { agentId, host, credential, ... }
//   POST /api/v1/agents/{id}/heartbeat       Bearer oac_... (the agent's own credential) -> { status, heartbeatSeconds, ... }
//   POST /api/v1/agents/{id}/metrics         Bearer oac_...  Prometheus text (gzip), push mode
//   POST /api/v1/agents/{id}/pull-certificate Bearer oac_... pull mode: certificate for the agent's own HTTPS endpoint
//   GET  /api/v1/agents/{id}/config          Bearer oac_...  settings the server holds for this agent
//
// The agent 1.1 paths (/api/agent/v1/enroll | heartbeat | metrics) stay as aliases for one release.
//
// The server decides the agent's identity: the agent id comes from the credential, never from the body.
// Metrics/logs/traces do NOT pass through here: they go to /ingest/agent/... (see verifyAgent in agents.js),
// so a Prometheus outage never makes enrollment or heartbeats fail, and the other way round.
import express from 'express';
import crypto from 'node:crypto';
import net from 'node:net';
import { config } from '../config.js';
import { q, one, tx } from '../db.js';
import { audit, clientIp } from '../store.js';
import { sha256, randomToken } from '../secrets.js';
import { counterDelta, agentStatus, agentProblems, compareVersions } from '../health.js';
import { ds } from '../datasources.js';
import { parseExposition, writeToPrometheus } from '../promwrite.js';
import { parseCertRequest, issueAgentCert } from '../agentpki.js';
import { effectiveFor, toAgentMap, deliverActions, recordResult, storeDiagnostics, scrubBundle } from '../agentmgmt.js';
import { DEFAULT_TENANT } from '../tenancy.js';

// the version this server publishes in agent/files (AGENT_LATEST_VERSION overrides it, e.g. for a lab or a pinned release)
export const AGENT_LATEST = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(process.env.AGENT_LATEST_VERSION || '') ? process.env.AGENT_LATEST_VERSION : '1.3.1';
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
function overLimit(key, max, windowMs) { // peek: is the bucket already full? (does not count this request)
  const b = buckets.get(key);
  return !!b && Date.now() - b.start <= windowMs && b.n >= max;
}

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
  const mode = b.mode == null || b.mode === '' ? 'push' : b.mode;
  if (!['push', 'pull'].includes(mode)) return { err: 'mode must be push or pull.' };
  // replay protection (agent 1.2+): a one-time nonce and a timestamp within 5 minutes of the server's clock
  const nonce = b.nonce == null ? null : str(b.nonce, /^[0-9a-f]{32,64}$/, 64);
  if (b.nonce != null && !nonce) return { err: 'nonce must be 32-64 hex characters.' };
  const timestamp = b.timestamp == null ? null : (Number.isFinite(b.timestamp) ? Number(b.timestamp) : NaN);
  if (Number.isNaN(timestamp)) return { err: 'timestamp must be epoch milliseconds.' };
  return { v: { hostname, platform, arch, version, env, role, machine, labels, mode, nonce, timestamp, os: text(b.os, 100), kernel: text(b.kernel, 100) } };
}

export const NONCE_WINDOW_MS = 5 * 60_000;
// Agents from 1.2 must send a nonce; 1.1 agents (no nonce) are still accepted for one release.
export function replayCheck(v, nowMs = Date.now()) {
  const needs = compareVersions(v.version, '1.2.0') >= 0;
  if (!v.nonce || v.timestamp == null) return needs ? 'This agent version must send a nonce and timestamp.' : null;
  if (Math.abs(nowMs - v.timestamp) > NONCE_WINDOW_MS) return 'The registration timestamp is more than 5 minutes off the server clock (check NTP on this host).';
  return null;
}

const COLLECTOR_STATES = ['ok', 'error', 'unavailable', 'disabled', 'running', 'stopped', 'failed', 'missing', 'unknown'];
const COLLECTOR_NAME_RE = /^[a-z][a-z0-9_.-]{0,31}$/;

function parseHeartbeat(b) {
  if (b == null) b = {};
  if (typeof b !== 'object' || Array.isArray(b)) return { err: 'Body must be a JSON object.' };
  const version = b.version == null ? null : str(b.version, /^\d{1,3}\.\d{1,3}\.\d{1,3}$/, 16);
  if (b.version != null && !version) return { err: 'version must look like 1.2.3.' };
  const n = (x, max = 1e15) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= max ? x : null);
  // collectors: { cpu: 'ok', filesystem: 'unavailable', ... } (max 32), errors: { filesystem: 'permission denied' }
  const collectors = {}, collectorErrors = {};
  if (b.collectors && typeof b.collectors === 'object' && !Array.isArray(b.collectors)) {
    for (const [k, v] of Object.entries(b.collectors).slice(0, 32)) {
      if (COLLECTOR_NAME_RE.test(k) && COLLECTOR_STATES.includes(v)) collectors[k] = v;
    }
  }
  if (b.collectorErrors && typeof b.collectorErrors === 'object' && !Array.isArray(b.collectorErrors)) {
    for (const [k, v] of Object.entries(b.collectorErrors).slice(0, 32)) {
      if (COLLECTOR_NAME_RE.test(k) && typeof v === 'string') collectorErrors[k] = text(v, 200);
    }
  }
  const hostLocked = Array.isArray(b.hostLocked) ? b.hostLocked.filter((x) => typeof x === 'string' && /^[a-z_.]{1,40}$/.test(x)).slice(0, 30) : [];
  const mode = b.mode === 'pull' ? 'pull' : b.mode == null || b.mode === 'push' ? 'push' : null;
  if (!mode) return { err: 'mode must be push or pull.' };
  const ipList = (x, max) => (Array.isArray(x) ? x.filter((ip) => typeof ip === 'string' && net.isIP(ip)).slice(0, max) : []);
  const addresses = ipList(b.addresses, 8);
  let pull = null;
  if (mode === 'pull' && b.pull && typeof b.pull === 'object' && !Array.isArray(b.pull)) {
    const port = Number(b.pull.port);
    pull = {
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
      ips: ipList(b.pull.ips, 8),
      dns: Array.isArray(b.pull.dns) ? b.pull.dns.filter((d) => typeof d === 'string' && /^[a-z0-9.-]{1,253}$/.test(d)).slice(0, 4) : [],
      listening: b.pull.listening === true,
      scrapes: n(b.pull.scrapes),
      refused: n(b.pull.refused),
      lastScrapeAgoSeconds: n(b.pull.lastScrapeAgoSeconds, 1e9),
      certNotAfter: n(b.pull.certNotAfter, 4102444800),
      error: text(b.pull.error, 300),
    };
  }
  return {
    v: {
      version,
      uptimeSeconds: n(b.uptimeSeconds, 1e10),
      bootTime: n(b.bootTime, 4102444800), // epoch seconds, before 2100
      uploadFailedTotal: n(b.uploadFailedTotal),
      bufferedPayloads: n(b.bufferedPayloads, 1e6),
      droppedPayloads: n(b.droppedPayloads),
      lastUploadAgoSeconds: n(b.lastUploadAgoSeconds, 1e9),
      collectors, collectorErrors, hostLocked, mode, addresses, pull,
      configVersion: n(b.configVersion, 9e15),
      diskBuffered: n(b.diskBuffered, 1e7),
      diskBufferedBytes: n(b.diskBufferedBytes, 1e13),
      configError: text(b.configError, 300),
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
    const row = await one(`SELECT id, host, platform, blocked, credential_hash, credential_prev_hash, credential_prev_until, credential_issued_at,
                                  rotate_requested, tenant_id, version
                           FROM agents WHERE id = $1 AND credential_hash IS NOT NULL`, [id]);
    if (!row) { credCache.delete(id); return null; }
    c = { row, exp: Date.now() + 30_000 };
    if (credCache.size > 20_000) credCache.clear();
    credCache.set(id, c);
  }
  const given = Buffer.from(sha256(cred));
  const same = (h) => { const b = Buffer.from(h || ''); return given.length === b.length && crypto.timingSafeEqual(given, b); };
  const r = c.row;
  if (same(r.credential_hash)) {
    // first use of a rotated credential: the old one keeps working for 10 more minutes, then never again
    if (r.credential_prev_hash && !r.credential_prev_until) {
      await q(`UPDATE agents SET credential_prev_until = now() + interval '10 minutes' WHERE id = $1 AND credential_prev_until IS NULL`, [r.id]);
      credCache.delete(r.id);
    }
    return { ...r, usedPrevious: false };
  }
  if (r.credential_prev_hash && same(r.credential_prev_hash) && (!r.credential_prev_until || new Date(r.credential_prev_until) > new Date())) {
    return { ...r, usedPrevious: true };
  }
  return null;
}

const bearer = (req) => (/^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '') || [])[1] || '';

// /api/v1/agents/{id}/...: the id in the path must be the credential's own agent (it is never trusted alone)
function pathMismatch(req, agent) {
  return req.params.id !== undefined && req.params.id !== agent.id;
}

// ---------------- site gateways ----------------
// An ObservaOne Gateway relays agents of a site that cannot reach this server. It authenticates itself with
// X-ObservaOne-Gateway (its own token, from Settings > Gateways); only then are its X-Gateway-Client-IP (the agent's
// address) and X-Gateway-Received-At (when the gateway got a request it replays later) believed.
const gwCache = new Map(); // token hash -> { row, exp }
export const GATEWAY_TOKEN_RE = /^ogw_[0-9a-f]{8}_[A-Za-z0-9_-]{30,64}$/;
export async function gatewayForToken(token) {
  if (!GATEWAY_TOKEN_RE.test(token || '')) return null;
  const h = sha256(token);
  const c = gwCache.get(h);
  if (c && c.exp > Date.now()) return c.row;
  const row = await one('SELECT id, name, tenant_id FROM gateways WHERE token_hash = $1 AND NOT revoked', [h]);
  if (gwCache.size > 1000) gwCache.clear();
  gwCache.set(h, { row, exp: Date.now() + 30_000 });
  return row;
}
export function forgetGateways() { gwCache.clear(); }

async function identifyGateway(req, res, next) {
  try {
    const t = req.get('x-observaone-gateway');
    if (t) {
      req.gateway = await gatewayForToken(t);
      if (!req.gateway) return fail(res, 401, 'invalid_gateway', 'Gateway token missing, wrong or revoked.');
    }
    next();
  } catch (e) { next(e); }
}

// the agent's address: the gateway tells it (only an authenticated gateway is believed)
function agentIp(req) {
  const fwd = req.gateway ? String(req.get('x-gateway-client-ip') || '') : '';
  return fwd && net.isIP(fwd) ? fwd : clientIp(req);
}
// when the request really happened: a gateway replaying after an outage says so (max 2 h back)
function receivedAt(req) {
  const t = req.gateway ? Number(req.get('x-gateway-received-at')) : NaN;
  const now = Date.now();
  return Number.isFinite(t) && t <= now && t > now - 2 * 3600_000 ? t : now;
}

// ---------------- router ----------------
export const agentControlRouter = express.Router();
agentControlRouter.use(['/agent/v1', '/v1/agents'], identifyGateway);
// small bodies only (the main API allows 200 kB; nothing here needs more than a few hundred bytes)
const json8k = express.json({ limit: '8kb', type: () => true });
agentControlRouter.use(['/agent/v1/enroll', '/agent/v1/heartbeat', '/v1/agents/register'], json8k);
agentControlRouter.use(/^\/v1\/agents\/agt_[0-9a-f]{20}\/(heartbeat|pull-certificate)$/, json8k);

const enrollHandler = wrap(async (req, res) => {
  const ip = agentIp(req);
  // Failed attempts are what an attacker produces: 10 per 10 min per address. Successful enrollments have a
  // much higher cap, so a whole fleet behind one NAT address can enroll at once.
  const failed = () => rateLimited(`enrollfail:${ip}`, Number.MAX_SAFE_INTEGER, 600_000);
  if (overLimit(`enrollfail:${ip}`, config.agent.enrollFailuresPer10Min, 600_000) || rateLimited(`enroll:${ip}`, config.agent.enrollPerIpPer10Min, 600_000)) {
    if (!rateLimited(`enroll-rl-audit:${ip}`, 1, 600_000)) audit(req, 'agent.enroll.rate_limited', { username: 'agent' });
    res.set('Retry-After', '600');
    return fail(res, 429, 'rate_limited', 'Too many enrollment attempts from this address. Wait 10 minutes.');
  }
  const token = bearer(req);
  if (!ENROLL_TOKEN_RE.test(token)) {
    failed();
    audit(req, 'agent.enroll.denied', { username: 'agent', reason: 'malformed_token' });
    return fail(res, 401, 'invalid_token', 'Enrollment token missing or malformed.');
  }
  const p = parseEnroll(req.body);
  if (p.err) { failed(); return fail(res, 400, 'bad_request', p.err); }
  const v = p.v;
  const replay = replayCheck(v);
  if (replay) { failed(); audit(req, 'agent.enroll.denied', { username: 'agent', reason: 'replay_check', hostname: v.hostname }); return fail(res, 400, 'replay_check', replay); }

  const credentialSecret = randomToken(32); // 43 base64url characters
  const out = await tx(async (c) => {
    if (v.nonce) {
      // a nonce is accepted once; kept for twice the timestamp window, so a replay is always caught
      const ins = await c.query('INSERT INTO agent_nonces (nonce) VALUES ($1) ON CONFLICT DO NOTHING RETURNING nonce', [v.nonce]);
      if (!ins.rowCount) return { deny: 'replayed', status: 400, msg: 'This registration was already received (replayed request).' };
    }
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
                                AND tenant_id = $4   -- never take over another tenant's record
                              FOR UPDATE`, [v.platform, v.machine, v.hostname, t.tenant_id || DEFAULT_TENANT])).rows[0] || null;
      if (reuse && reuse.last_heartbeat && Date.now() - new Date(reuse.last_heartbeat).getTime() < config.agent.onlineSeconds * 1000) {
        return { deny: 'agent_online', status: 409, msg: `An agent for ${reuse.host} on this machine is online right now. Uninstall it there, or remove it on the Agents page, before enrolling again.` };
      }
    }
    // a token made by the Add Target wizard binds the agent to its target; the target's env / role / labels fill in
    // whatever the installer did not set
    const target = t.target_id ? (await c.query('SELECT * FROM targets WHERE id = $1', [t.target_id])).rows[0] : null;
    if (target) {
      v.env = v.env || target.env;
      v.role = v.role || target.role;
      v.labels = { ...(target.labels || {}), ...v.labels };
    }
    const idHex = crypto.randomBytes(10).toString('hex');
    const id = reuse ? reuse.id : `agt_${idHex}`;
    const credential = `oac_${id.slice(4)}_${credentialSecret}`;

    let host = v.hostname;
    if (reuse) {
      await c.query(`UPDATE agents SET credential_hash = $2, os = $3, arch = $4, version = $5, env = $6, role = $7, labels = $8,
                       kernel = $9, ip = $10, token_id = $11, enrolled_at = now(), last_heartbeat = NULL, blocked = FALSE, diag = '{}',
                       mode = $12, pull = '{}', target_id = COALESCE($13, target_id), tenant_id = $14,
                       credential_prev_hash = NULL, credential_prev_until = NULL, credential_issued_at = now(), rotate_requested = FALSE
                     WHERE id = $1`,
      [id, sha256(credential), v.os, v.arch, v.version, v.env, v.role, JSON.stringify(v.labels), v.kernel, ip, t.id, v.mode, target?.id || null, t.tenant_id || DEFAULT_TENANT]);
      host = reuse.host;
    } else {
      // Another machine already uses this host name: never overwrite it, give this one a distinct name.
      for (let i = 1; ; i++) {
        const name = i === 1 ? v.hostname : `${v.hostname}-${i}`;
        await c.query('SAVEPOINT ins');
        try {
          await c.query(`INSERT INTO agents (id, host, platform, os, arch, version, env, role, labels, kernel, ip, token_id,
                                             credential_hash, machine_hash, mode, target_id, tenant_id, credential_issued_at, enrolled_at, first_seen, last_seen)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now(), now(), now(), now())`,
          [id, name, v.platform, v.os, v.arch, v.version, v.env, v.role, JSON.stringify(v.labels), v.kernel, ip, t.id, sha256(credential), v.machine, v.mode, target?.id || null, t.tenant_id || DEFAULT_TENANT]);
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
    failed();
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
});
agentControlRouter.post('/v1/agents/register', enrollHandler);
agentControlRouter.post('/agent/v1/enroll', enrollHandler); // agent 1.1

// Remove nonces older than twice the timestamp window (called every minute by the server)
export async function purgeNonces() {
  await q("DELETE FROM agent_nonces WHERE seen_at < now() - interval '10 minutes'");
}

// Credential check shared by every per-agent call. Sends the error answer itself and returns null on failure.
async function authAgent(req, res, failKey) {
  const ip = agentIp(req);
  const cred = bearer(req);
  const agent = cred ? await agentForCredential(cred) : null;
  if (!agent) {
    if (rateLimited(`${failKey}:${ip}`, 30, 60_000)) { res.set('Retry-After', '60'); fail(res, 429, 'rate_limited', 'Too many failed requests from this address.'); return null; }
    if (!rateLimited(`${failKey}-audit:${ip}`, 1, 300_000)) audit(req, `agent.${failKey}.denied`, { username: 'agent', reason: cred ? 'invalid_credential' : 'missing_credential' });
    fail(res, 401, 'invalid_credential', 'Agent credential missing or not valid. Re-enroll this agent.');
    return null;
  }
  if (pathMismatch(req, agent)) { fail(res, 403, 'agent_mismatch', 'The agent id in the path is not this credential\'s agent.'); return null; }
  if (req.gateway && req.gateway.tenant_id !== DEFAULT_TENANT && agent.tenant_id !== req.gateway.tenant_id) {
    fail(res, 403, 'gateway_tenant', 'This gateway relays agents of another tenant only.'); return null;
  }
  if (agent.blocked) { fail(res, 403, 'blocked', 'This agent is blocked on the Agents page.'); return null; }
  return agent;
}

const lastWrite = new Map(); // agent id -> ms of the last heartbeat written (bursts are answered, not written)

const heartbeatHandler = wrap(async (req, res) => {
  const ip = agentIp(req);
  const at = receivedAt(req); // a replayed heartbeat counts for when the gateway received it
  const agent = await authAgent(req, res, 'heartbeat');
  if (!agent) return;
  const p = parseHeartbeat(req.body);
  if (p.err) return fail(res, 400, 'bad_request', p.err);
  const v = p.v;

  const now = Date.now();
  const prevWrite = lastWrite.get(agent.id) || 0;
  if (now - prevWrite >= 5_000) { // at most one write per agent every 5 s: a burst cannot overload the database
    lastWrite.set(agent.id, now);
    if (lastWrite.size > 50_000) lastWrite.clear();
    const prevRow = await one('SELECT diag, ip, last_heartbeat FROM agents WHERE id = $1', [agent.id]);
    const prev = prevRow?.diag || {};
    const failures = counterDelta(Number(prev.uploadFailedTotal), v.uploadFailedTotal ?? NaN);
    const diag = {
      collectors: v.collectors,
      collectorErrors: v.collectorErrors,
      uploadFailedTotal: v.uploadFailedTotal,
      uploadFailures: failures ?? null,
      bufferedPayloads: v.bufferedPayloads,
      droppedPayloads: v.droppedPayloads,
      lastUploadAgoSeconds: v.lastUploadAgoSeconds,
      hostLocked: v.hostLocked,
      lastError: v.lastError || '',
      uptimeSeconds: v.uptimeSeconds,
      agentIp: ip,
      mode: v.mode,
      diskBuffered: v.diskBuffered,
      diskBufferedBytes: v.diskBufferedBytes,
    };
    // server time only, and never backwards (GREATEST) even if requests arrive out of order
    await q(`UPDATE agents SET last_heartbeat = GREATEST(COALESCE(last_heartbeat, to_timestamp($12::float8 / 1000)), to_timestamp($12::float8 / 1000)), heartbeats = heartbeats + 1,
               version = COALESCE($2, version), boot_time = CASE WHEN $3::float8 IS NULL THEN boot_time ELSE to_timestamp($3::float8) END,
               kernel = CASE WHEN $4 = '' THEN kernel ELSE $4 END, diag = $5, ip = $6,
               mode = $7, pull = $8, addresses = $9,
               config_applied = COALESCE($10, config_applied), config_error = $11, gateway_id = $13
             WHERE id = $1`, [agent.id, v.version, v.bootTime, v.kernel, JSON.stringify(diag), ip, v.mode, JSON.stringify(v.pull || {}), JSON.stringify(v.addresses),
      v.configVersion, v.configError || '', at, req.gateway?.id || null]);
    // address changes are kept as history (search, joining old data)
    if (prevRow && prevRow.ip && prevRow.ip !== ip) {
      await q(`INSERT INTO agent_aliases (agent_id, kind, value, seen_from) VALUES ($1, 'ip', $2, $3)`, [agent.id, prevRow.ip, prevRow.last_heartbeat]);
    }
    if (prev.collectors === undefined) audit(req, 'agent.first_heartbeat', { username: 'agent', id: agent.id, host: agent.host });
  }
  const row = await one('SELECT * FROM agents WHERE id = $1', [agent.id]);
  const eff = await effectiveFor(row);
  // agent 1.1/1.2 understand only "config" (and ignore the rest); 1.3 also applies configVersion and actions
  const answer = {
    agentId: agent.id,
    status: describeAgent(row, now).status,
    heartbeatSeconds: config.agent.heartbeatSeconds,
    latestVersion: AGENT_LATEST,
    config: toAgentMap(eff.settings),
    configVersion: eff.version,
  };
  if (compareVersions(v.version || row.version || '0.0.0', '1.3.0') >= 0) {
    answer.actions = await deliverActions(agent.id);
    // a new credential when an admin asked for it or the current one is older than AGENT_CREDENTIAL_DAYS
    const days = config.agent.credentialDays;
    const old = days > 0 && row.credential_issued_at && Date.now() - new Date(row.credential_issued_at).getTime() > days * 86_400_000;
    if (!agent.usedPrevious && (row.rotate_requested || old)) answer.rotate = true;
  }
  res.json(answer);
});
agentControlRouter.post('/v1/agents/:id/heartbeat', heartbeatHandler);
agentControlRouter.post('/agent/v1/heartbeat', heartbeatHandler); // agent 1.1

// Pull mode: sign a certificate for the agent's HTTPS endpoint. The agent sends only its public key and the
// addresses it listens on; the certificate's name is the agent id (from the credential, never from the body).
agentControlRouter.post('/v1/agents/:id/pull-certificate', wrap(async (req, res) => {
  const agent = await authAgent(req, res, 'pullcert');
  if (!agent) return;
  if (rateLimited(`pullcert:${agent.id}`, 10, 3_600_000)) { res.set('Retry-After', '600'); return fail(res, 429, 'rate_limited', 'Too many certificate requests for this agent (10 per hour).'); }
  const p = parseCertRequest(req.body);
  if (p.err) return fail(res, 400, 'bad_request', p.err);
  const c = issueAgentCert(agent.id, p);
  await q('UPDATE agents SET pull_cert_at = now() WHERE id = $1', [agent.id]);
  audit(req, 'agent.pull_certificate', { username: 'agent', id: agent.id, host: agent.host, ips: p.ips, dns: p.dns, serial: c.serial, notAfter: c.notAfter });
  res.set('Cache-Control', 'no-store');
  res.json(c);
}));

agentControlRouter.get('/v1/agents/:id/config', wrap(async (req, res) => {
  const agent = await authAgent(req, res, 'config');
  if (!agent) return;
  const eff = await effectiveFor(await one('SELECT * FROM agents WHERE id = $1', [agent.id]));
  res.json({ agentId: agent.id, heartbeatSeconds: config.agent.heartbeatSeconds, latestVersion: AGENT_LATEST, config: toAgentMap(eff.settings), configVersion: eff.version });
}));

// Result of an action the Agents page requested (diagnostics failure, restart, upgrade outcome).
agentControlRouter.post('/v1/agents/:id/actions/:actionId/result', json8k, wrap(async (req, res) => {
  const agent = await authAgent(req, res, 'action');
  if (!agent) return;
  const r = await recordResult(agent.id, Number(req.params.actionId) || 0, req.body || {});
  if (!r) return fail(res, 404, 'not_found', 'No open action with that id for this agent.');
  audit(req, `agent.action.${r.state}`, { username: 'agent', id: agent.id, host: agent.host, action: r.action, actionId: r.id, message: r.result?.message });
  res.json({ ok: true });
}));

// Diagnostics bundle (<= 1 MB). Stored as data, secrets scrubbed on the way in; shown and downloaded on the Agents page.
agentControlRouter.post('/v1/agents/:id/diagnostics', express.json({ limit: '1mb', type: () => true }), wrap(async (req, res) => {
  const agent = await authAgent(req, res, 'diagnostics');
  if (!agent) return;
  if (rateLimited(`diag:${agent.id}`, 10, 3_600_000)) { res.set('Retry-After', '600'); return fail(res, 429, 'rate_limited', 'Too many diagnostics uploads (10 per hour).'); }
  const b = req.body;
  if (!b || typeof b !== 'object' || !b.bundle || typeof b.bundle !== 'object' || Array.isArray(b.bundle)) return fail(res, 400, 'bad_request', 'Body must be { actionId, bundle: {...} }.');
  const bundle = scrubBundle(b.bundle);
  const size = Buffer.byteLength(JSON.stringify(bundle));
  const r = await storeDiagnostics(agent.id, Number(b.actionId) || null, bundle, size);
  audit(req, 'agent.diagnostics', { username: 'agent', id: agent.id, host: agent.host, diagnosticsId: r.id, size });
  res.status(201).json({ ok: true, id: r.id });
}));

// Credential rotation (agent 1.3+). Only the CURRENT credential can ask; the old one stays valid until 10 minutes
// after the new one is first used (see agentForCredential), so an agent that fails to save the new one is not lost.
agentControlRouter.post('/v1/agents/:id/credential/rotate', json8k, wrap(async (req, res) => {
  const agent = await authAgent(req, res, 'rotate');
  if (!agent) return;
  if (agent.usedPrevious) return fail(res, 409, 'use_current', 'Rotate with the current credential.');
  if (rateLimited(`rotate:${agent.id}`, 5, 3_600_000)) { res.set('Retry-After', '600'); return fail(res, 429, 'rate_limited', 'Too many rotations (5 per hour).'); }
  const credential = `oac_${agent.id.slice(4)}_${randomToken(32)}`;
  await q(`UPDATE agents SET credential_prev_hash = credential_hash, credential_prev_until = NULL, credential_hash = $2,
             credential_issued_at = now(), rotate_requested = FALSE WHERE id = $1`, [agent.id, sha256(credential)]);
  forgetAgentCredential(agent.id);
  audit(req, 'agent.credential.rotate', { username: 'agent', id: agent.id, host: agent.host });
  res.set('Cache-Control', 'no-store');
  res.json({ credential });
}));

// Gateway status (every 30 s): spool size, relayed agents, link state. Shown on Settings > Gateways.
agentControlRouter.post('/v1/gateways/heartbeat', json8k, wrap(async (req, res) => {
  const gw = await gatewayForToken(req.get('x-observaone-gateway'));
  if (!gw) return fail(res, 401, 'invalid_gateway', 'Gateway token missing, wrong or revoked.');
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const n = (x) => (Number.isFinite(x) && x >= 0 ? x : null);
  const stats = { agents: n(b.agents), spooledFiles: n(b.spooledFiles), spooledBytes: n(b.spooledBytes), pendingHeartbeats: n(b.pendingHeartbeats),
    replayed: n(b.replayed), dropped: n(b.dropped), lastUpstreamError: text(b.lastUpstreamError, 300) };
  await q('UPDATE gateways SET last_seen = now(), last_ip = $2, version = $3, stats = $4 WHERE id = $1',
    [gw.id, clientIp(req), str(b.version, /^\d{1,3}\.\d{1,3}\.\d{1,3}$/, 16) || '', JSON.stringify(stats)]);
  res.json({ ok: true, gatewayId: gw.id, name: gw.name });
}));

// ---------------- metrics intake ----------------
// The agent POSTs the Prometheus text format (gzip). The server, not the agent, decides the identity labels:
// host, agent_id, job, platform, env, role and the agent's custom labels come from the database, so one
// agent can never write series that look like another host's. Then the samples go to Prometheus
// (remote write). If Prometheus is down the agent gets 503 and keeps the data in its buffer;
// heartbeats keep working because they do not depend on Prometheus.
const IDENTITY_LABELS = new Set(['host', 'agent_id', 'job', 'instance', 'agent', 'os', 'platform', 'env', 'role', 'cluster', 'tenant', 'gateway']);
const MAX_PAST_MS = 2 * 3600_000; // Prometheus accepts out-of-order samples up to 2 h old (prometheus.yml); agent disk buffers keep 2 h
const lastDataWrite = new Map();

export function remoteWriteUrl() {
  if (config.agent.remoteWriteUrl) return config.agent.remoteWriteUrl;
  const u = ds('prometheus')?.url;
  return u ? `${u.replace(/\/+$/, '')}/api/v1/write` : '';
}

// Pure: turn parsed series into the series written to Prometheus. Exported for tests.
export function relabel(series, agentRow, { nowMs, skewMs = 0 }) {
  const fixed = {
    host: agentRow.host, agent_id: agentRow.id, job: agentRow.platform, platform: agentRow.platform,
    agent: 'observaone', os: agentRow.platform === 'windows' ? 'windows' : 'linux',
  };
  if (agentRow.env) fixed.env = agentRow.env;
  if (agentRow.role) fixed.role = agentRow.role;
  if (agentRow.tenant_id && agentRow.tenant_id !== DEFAULT_TENANT) fixed.tenant = agentRow.tenant_id; // never from the agent
  const custom = agentRow.labels || {};
  const out = [];
  let dropped = 0, newest = 0;
  for (const s of series) {
    const ts = s.ts == null ? nowMs : s.ts + skewMs; // correct a wrong host clock
    if (ts < nowMs - MAX_PAST_MS || ts > nowMs + 60_000) { dropped++; continue; }
    const labels = { __name__: s.name };
    for (const [k, v] of Object.entries(s.labels)) if (!IDENTITY_LABELS.has(k) && !k.startsWith('__')) labels[k] = v;
    for (const [k, v] of Object.entries(custom)) labels[k] = String(v);
    Object.assign(labels, fixed);
    out.push({ labels, value: s.value, ts });
    if (ts > newest) newest = ts;
  }
  // "up" = this agent delivered data at that time (what the dashboards and Infrastructure read)
  if (out.length) out.push({ labels: { __name__: 'up', ...Object.fromEntries(Object.entries(custom).map(([k, v]) => [k, String(v)])), ...fixed }, value: 1, ts: newest });
  return { out, dropped };
}

const metricsHandler = wrap(async (req, res) => {
  const agent = await authAgent(req, res, 'metrics');
  if (!agent) return;
  if (rateLimited(`metrics:${agent.id}`, 120, 60_000)) { res.set('Retry-After', '30'); return fail(res, 429, 'rate_limited', 'Too many uploads; slow down.'); }
  const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!body) return fail(res, 400, 'bad_request', 'Empty body.');
  const parsed = parseExposition(body);
  if (!parsed.series.length) return fail(res, 400, 'bad_request', `No valid samples${parsed.errors.length ? ` (first problem on line ${parsed.errors[0].line}: ${parsed.errors[0].reason})` : ''}.`);

  const now = Date.now();
  const agentTime = Number(req.get('x-agent-time'));
  const skew = Number.isFinite(agentTime) && agentTime > 0 ? receivedAt(req) - agentTime : 0;
  const skewMs = Math.abs(skew) > 5000 ? skew : 0; // small differences are network delay, not clock error
  const row = await one('SELECT id, host, platform, env, role, labels, tenant_id FROM agents WHERE id = $1', [agent.id]);
  const { out, dropped } = relabel(parsed.series, row, { nowMs: now, skewMs });
  if (!out.length) return res.json({ accepted: 0, dropped: dropped + parsed.errors.length, reason: 'all samples too old or in the future' });

  const url = remoteWriteUrl();
  if (!url) return fail(res, 503, 'not_configured', 'Prometheus is not configured on the server.');
  let r;
  try {
    r = await writeToPrometheus(url, out);
  } catch (e) {
    res.set('Retry-After', '30');
    return fail(res, 503, 'metrics_store_unavailable', 'The metrics store (Prometheus) is not reachable. Keep the data and retry.');
  }
  if (r.status >= 500 || r.status === 429) {
    res.set('Retry-After', '30');
    return fail(res, 503, 'metrics_store_unavailable', `Prometheus answered ${r.status}. Keep the data and retry.`);
  }
  if (now - (lastDataWrite.get(agent.id) || 0) > 30_000) {
    lastDataWrite.set(agent.id, now);
    if (lastDataWrite.size > 50_000) lastDataWrite.clear();
    await q('UPDATE agents SET last_seen = now() WHERE id = $1', [agent.id]);
  }
  if (r.status >= 400) {
    // e.g. out-of-order samples after a long outage: retrying would never succeed, so do not ask for it
    return res.json({ accepted: 0, dropped: out.length, reason: `Prometheus refused the samples: ${r.text.slice(0, 200)}` });
  }
  res.json({ accepted: out.length, dropped: dropped + parsed.errors.length, clockSkewMs: skewMs });
});
const rawMetrics = express.raw({ type: () => true, limit: '4mb', inflate: true });
agentControlRouter.post('/v1/agents/:id/metrics', rawMetrics, metricsHandler);
agentControlRouter.post('/agent/v1/metrics', rawMetrics, metricsHandler); // agent 1.1

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
agentControlRouter.use(['/agent/v1', '/v1/agents'], (err, req, res, next) => {
  if (err.type === 'entity.too.large') return fail(res, 413, 'too_large', 'Request body too large.');
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'bad_request', 'Body is not valid JSON.');
  // a body that is not what its Content-Encoding says: the payload is broken, retrying will not help
  if (err.type === 'encoding.unsupported' || /header check|unexpected end of file|invalid (stored block|distance|block type|code)/i.test(err.message)) {
    return fail(res, 400, 'bad_encoding', 'The body could not be decompressed (Content-Encoding does not match the data).');
  }
  console.error('[agent-control]', err.message);
  return fail(res, 503, 'unavailable', 'The server could not process the request. Try again later.');
});
