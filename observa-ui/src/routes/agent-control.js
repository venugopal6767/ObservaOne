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
import { ds } from '../datasources.js';
import { parseExposition, writeToPrometheus } from '../promwrite.js';

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
  return {
    v: {
      version,
      uptimeSeconds: n(b.uptimeSeconds, 1e10),
      bootTime: n(b.bootTime, 4102444800), // epoch seconds, before 2100
      uploadFailedTotal: n(b.uploadFailedTotal),
      bufferedPayloads: n(b.bufferedPayloads, 1e6),
      droppedPayloads: n(b.droppedPayloads),
      lastUploadAgoSeconds: n(b.lastUploadAgoSeconds, 1e9),
      collectors, collectorErrors, hostLocked,
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
const json8k = express.json({ limit: '8kb', type: () => true });
agentControlRouter.use('/agent/v1/enroll', json8k);
agentControlRouter.use('/agent/v1/heartbeat', json8k);

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

// ---------------- metrics intake ----------------
// The agent POSTs the Prometheus text format (gzip). The server, not the agent, decides the identity labels:
// host, agent_id, job, platform, env, role and the agent's custom labels come from the database, so one
// agent can never write series that look like another host's. Then the samples go to Prometheus
// (remote write). If Prometheus is down the agent gets 503 and keeps the data in its buffer;
// heartbeats keep working because they do not depend on Prometheus.
const IDENTITY_LABELS = new Set(['host', 'agent_id', 'job', 'instance', 'agent', 'os', 'platform', 'env', 'role', 'cluster']);
const MAX_PAST_MS = 30 * 60_000; // Prometheus accepts out-of-order samples up to 30 min old (prometheus.yml)
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

agentControlRouter.post('/agent/v1/metrics', express.raw({ type: () => true, limit: '4mb', inflate: true }), wrap(async (req, res) => {
  const ip = clientIp(req);
  const cred = bearer(req);
  const agent = cred ? await agentForCredential(cred) : null;
  if (!agent) {
    if (rateLimited(`mfail:${ip}`, 30, 60_000)) { res.set('Retry-After', '60'); return fail(res, 429, 'rate_limited', 'Too many failed uploads from this address.'); }
    return fail(res, 401, 'invalid_credential', 'Agent credential missing or not valid.');
  }
  if (agent.blocked) return fail(res, 403, 'blocked', 'This agent is blocked on the Agents page.');
  if (rateLimited(`metrics:${agent.id}`, 120, 60_000)) { res.set('Retry-After', '30'); return fail(res, 429, 'rate_limited', 'Too many uploads; slow down.'); }
  const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!body) return fail(res, 400, 'bad_request', 'Empty body.');
  const parsed = parseExposition(body);
  if (!parsed.series.length) return fail(res, 400, 'bad_request', `No valid samples${parsed.errors.length ? ` (first problem on line ${parsed.errors[0].line}: ${parsed.errors[0].reason})` : ''}.`);

  const now = Date.now();
  const agentTime = Number(req.get('x-agent-time'));
  const skew = Number.isFinite(agentTime) && agentTime > 0 ? now - agentTime : 0;
  const skewMs = Math.abs(skew) > 5000 ? skew : 0; // small differences are network delay, not clock error
  const row = await one('SELECT id, host, platform, env, role, labels FROM agents WHERE id = $1', [agent.id]);
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
