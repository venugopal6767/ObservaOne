// ObservaOne Gateway: runs in a site whose servers cannot reach the central ObservaOne (or should not, one by one).
// Agents are installed with --server https://<the gateway>; the gateway relays everything to the centre and keeps
// working while the link to the centre is down:
//
//   enrollment, actions, diagnostics, settings  relayed live (need the centre: 503 while it is down)
//   heartbeats   relayed live; while the centre is down they are answered here (last answer the centre gave, no
//                actions), and the LATEST heartbeat per agent is replayed when the link is back, with the time
//                the gateway received it (the centre trusts that time only from an authenticated gateway)
//   metrics      relayed live; while the centre is down they are spooled to disk (bounded by size and age) and
//                replayed oldest first, so the agents' 10-minute buffers are not the limit any more
//   /agent/*     installers and binaries are fetched from the centre and cached, so installs work offline
//
// The gateway never decides anything about an agent: the centre checks every credential, every payload and
// every label. Only uploads from credentials the centre accepted in the last 24 h are spooled, so the spool
// cannot be filled by strangers. Spool files hold the agent's credential (to replay it): 0600, in the
// gateway's own volume.
//
//   GATEWAY_UPSTREAM=https://observaone.example.com  GATEWAY_TOKEN=ogw_...  [GATEWAY_CA_FILE=/certs/central.crt]
//   PORT=8080  GATEWAY_SPOOL_DIR=/data/spool  GATEWAY_SPOOL_MB=1024  GATEWAY_SPOOL_HOURS=2
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';

export const GATEWAY_VERSION = '1.3.0';
const env = (k, d) => process.env[k] ?? d;

export function gatewayConfig() {
  const upstream = String(env('GATEWAY_UPSTREAM', '')).replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+$/.test(upstream)) throw new Error('GATEWAY_UPSTREAM must be https://host[:port] of the central ObservaOne');
  const token = env('GATEWAY_TOKEN', '');
  if (!/^ogw_[0-9a-f]{8}_[A-Za-z0-9_-]{30,64}$/.test(token)) throw new Error('GATEWAY_TOKEN must be the ogw_... token from Settings > Gateways');
  const caFile = env('GATEWAY_CA_FILE', '');
  return {
    upstream, token, port: Number(env('PORT', '8080')),
    ca: caFile ? fs.readFileSync(caFile) : undefined,
    spoolDir: path.resolve(env('GATEWAY_SPOOL_DIR', './data/spool')),
    spoolBytes: Number(env('GATEWAY_SPOOL_MB', '1024')) * 1024 * 1024,
    spoolMs: Number(env('GATEWAY_SPOOL_HOURS', '2')) * 3600_000,
    cacheDir: path.resolve(env('GATEWAY_CACHE_DIR', './data/agent-files')),
  };
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createGateway(cfg) {
  const agent = new https.Agent({ ca: cfg.ca, keepAlive: true, maxSockets: 32 });
  fs.mkdirSync(cfg.spoolDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cfg.cacheDir, { recursive: true });
  const state = {
    up: true, lastError: '', replayed: 0, dropped: 0,
    known: new Map(),          // sha256(credential) -> last time the centre accepted it
    answers: new Map(),        // agent id -> last heartbeat answer from the centre
    pending: new Map(),        // agent id -> { headers, body, at } latest heartbeat to replay
    agents: new Set(),
  };

  // one request to the centre; resolves { status, headers, body } or rejects on a network error / timeout
  function upstream(method, url, headers, body, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const u = new URL(cfg.upstream + url);
      const req = https.request({ method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, agent, timeout: timeoutMs,
        headers: { ...headers, 'x-observaone-gateway': cfg.token, ...(body ? { 'content-length': body.length } : {}) } }, (r) => {
        const chunks = []; let size = 0;
        r.on('data', (c) => { size += c.length; if (size > 32 << 20) r.destroy(new Error('answer too large')); else chunks.push(c); });
        r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) }));
        r.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
  const linkDown = (e) => { state.up = false; state.lastError = String(e?.message || e).slice(0, 200); };
  const fwdHeaders = (req) => {
    const h = {};
    for (const k of ['authorization', 'content-type', 'content-encoding', 'x-agent-time', 'x-collected-at', 'user-agent']) if (req.headers[k]) h[k] = req.headers[k];
    h['x-gateway-client-ip'] = (req.headers['x-real-ip'] || req.socket.remoteAddress || '').toString().replace(/^::ffff:/, '');
    return h;
  };
  const credOf = (req) => (/^Bearer\s+(oac_\S+)$/i.exec(req.headers.authorization || '') || [])[1] || '';
  const relayAnswer = (res, r) => {
    res.status(r.status);
    for (const k of ['content-type', 'retry-after', 'cache-control']) if (r.headers[k]) res.set(k, r.headers[k]);
    res.send(r.body);
  };

  // ---------------- spool (metrics while the centre is down) ----------------
  function spoolList() {
    return fs.readdirSync(cfg.spoolDir).filter((n) => n.endsWith('.json')).sort();
  }
  function spoolStats() {
    let bytes = 0; const files = spoolList();
    for (const f of files) { try { bytes += fs.statSync(path.join(cfg.spoolDir, f)).size; } catch { /* gone */ } }
    return { files: files.length, bytes };
  }
  function spoolPrune(room) {
    const now = Date.now();
    let { bytes } = spoolStats();
    for (const f of spoolList()) {
      const p = path.join(cfg.spoolDir, f);
      const at = Number(f.split('-')[0]);
      let size = 0; try { size = fs.statSync(p).size; } catch { continue; }
      if (now - at > cfg.spoolMs || bytes + room > cfg.spoolBytes) { fs.rmSync(p, { force: true }); bytes -= size; state.dropped++; }
    }
  }
  function spool(kind, url, headers, body) {
    const rec = JSON.stringify({ kind, url, headers, at: Date.now(), body: body.toString('base64') });
    spoolPrune(rec.length);
    const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`;
    const tmp = path.join(cfg.spoolDir, `.${name}`);
    fs.writeFileSync(tmp, rec, { mode: 0o600 });
    fs.renameSync(tmp, path.join(cfg.spoolDir, name));
  }

  // ---------------- replay ----------------
  let replaying = false;
  async function replay() {
    if (replaying) return;
    replaying = true;
    try {
      const probe = await upstream('GET', '/healthz', {}, null, 5000).catch((e) => { linkDown(e); return null; });
      if (!probe || probe.status >= 500) { if (probe) linkDown(`centre answered ${probe.status}`); return; }
      state.up = true; state.lastError = '';
      for (const [id, hb] of state.pending) {
        const r = await upstream('POST', hb.url, { ...hb.headers, 'x-gateway-received-at': String(hb.at) }, hb.body).catch((e) => { linkDown(e); return null; });
        if (!r) return;
        if (r.status < 500) { state.pending.delete(id); state.replayed++; }
      }
      for (const f of spoolList()) {
        const p = path.join(cfg.spoolDir, f);
        let rec; try { rec = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { fs.rmSync(p, { force: true }); continue; }
        const r = await upstream('POST', rec.url, { ...rec.headers, 'x-gateway-received-at': String(rec.at) }, Buffer.from(rec.body, 'base64')).catch((e) => { linkDown(e); return null; });
        if (!r) return;
        if (r.status >= 500 || r.status === 429) return; // try later, keep order
        fs.rmSync(p, { force: true });
        if (r.status < 300) state.replayed++; else state.dropped++; // refused for its content: never retried
      }
    } finally { replaying = false; }
  }

  async function status() {
    const s = spoolStats();
    await upstream('POST', '/api/v1/gateways/heartbeat', { 'content-type': 'application/json' }, Buffer.from(JSON.stringify({
      version: GATEWAY_VERSION, agents: state.agents.size, spooledFiles: s.files, spooledBytes: s.bytes, pendingHeartbeats: state.pending.size,
      replayed: state.replayed, dropped: state.dropped, lastUpstreamError: state.lastError,
    })), 10_000).then((r) => { if (r.status === 401) state.lastError = 'the centre refused the gateway token (revoked?)'; }).catch(linkDown);
  }

  // ---------------- HTTP ----------------
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback, uniquelocal');
  const raw = express.raw({ type: () => true, limit: '4mb', inflate: false }); // relayed as received (gzip stays gzip)

  app.get('/healthz', (req, res) => res.json({ ok: true, gateway: GATEWAY_VERSION, upstream: state.up ? 'up' : 'down', lastError: state.lastError || undefined, ...spoolStats(), pending: state.pending.size }));

  // installers and binaries: from the centre, cached for offline installs
  app.get(/^\/agent\/(install\.sh|install-legacy\.sh|files\/[A-Za-z0-9._-]+)$/, async (req, res) => {
    const name = req.path.slice('/agent/'.length).replace(/\//g, '__');
    const cached = path.join(cfg.cacheDir, name);
    const r = await upstream('GET', req.path, {}, null, 60_000).catch((e) => { linkDown(e); return null; });
    if (r && r.status === 200) {
      fs.writeFileSync(`${cached}.tmp`, r.body); fs.renameSync(`${cached}.tmp`, cached);
      res.set('content-type', r.headers['content-type'] || 'application/octet-stream');
      return res.send(r.body);
    }
    if (fs.existsSync(cached)) { res.set('x-gateway-cache', 'offline copy'); return res.sendFile(cached); }
    res.status(r ? r.status : 503).send(r ? r.body : 'The central ObservaOne is unreachable and this file is not cached yet.');
  });

  // heartbeats: live when possible, answered here otherwise
  const heartbeat = async (req, res) => {
    const id = req.params.id || 'legacy';
    const h = fwdHeaders(req);
    const r = await upstream('POST', req.originalUrl, h, req.body).catch((e) => { linkDown(e); return null; });
    if (r && r.status < 500) {
      if (r.status === 200) {
        state.up = true; state.known.set(sha(credOf(req)), Date.now()); state.agents.add(id);
        try { state.answers.set(id, JSON.parse(r.body.toString('utf8'))); } catch { /* not JSON */ }
      }
      return relayAnswer(res, r);
    }
    // the centre is down: remember the latest heartbeat, answer with the last known answer
    if (!state.known.has(sha(credOf(req)))) return res.status(503).set('Retry-After', '30').json({ error: 'The central ObservaOne is unreachable and this agent is not known to the gateway yet.', code: 'upstream_down' });
    state.pending.set(id, { url: req.originalUrl, headers: h, body: req.body, at: Date.now() });
    const last = state.answers.get(id) || {};
    res.json({ ...last, actions: [], rotate: false, viaGateway: true, upstream: 'unreachable' });
  };

  // metrics: live when possible, spooled otherwise
  const metrics = async (req, res) => {
    const h = fwdHeaders(req);
    const r = await upstream('POST', req.originalUrl, h, req.body).catch((e) => { linkDown(e); return null; });
    if (r && r.status < 500 && r.status !== 429) {
      if (r.status === 200) state.known.set(sha(credOf(req)), Date.now());
      return relayAnswer(res, r);
    }
    const seen = state.known.get(sha(credOf(req)));
    if (!seen || Date.now() - seen > 24 * 3600_000) return res.status(503).set('Retry-After', '30').json({ error: 'The central ObservaOne is unreachable.', code: 'upstream_down' });
    try { spool('metrics', req.originalUrl, h, req.body); } catch (e) { return res.status(503).json({ error: `spool: ${e.message}` }); }
    res.status(202).json({ accepted: 'spooled', reason: 'the central ObservaOne is unreachable; the gateway sends it later' });
  };

  // everything else an agent calls: relayed live
  const live = async (req, res) => {
    const r = await upstream(req.method, req.originalUrl, fwdHeaders(req), req.method === 'GET' ? null : req.body).catch((e) => { linkDown(e); return null; });
    if (!r) return res.status(503).set('Retry-After', '30').json({ error: 'The central ObservaOne is unreachable from this gateway.', code: 'upstream_down' });
    relayAnswer(res, r);
  };

  app.post(['/api/v1/agents/:id/heartbeat', '/api/agent/v1/heartbeat'], raw, heartbeat);
  app.post(['/api/v1/agents/:id/metrics', '/api/agent/v1/metrics'], raw, metrics);
  app.all(/^\/api\/(v1\/agents|agent\/v1)\//, raw, live);
  app.use((req, res) => res.status(404).json({ error: 'Not found (this is an ObservaOne Gateway: agent traffic only).' }));

  const timers = [];
  const start = () => {
    timers.push(setInterval(() => replay().catch(() => {}), 15_000));
    timers.push(setInterval(() => status().catch(() => {}), 30_000));
    status().catch(() => {});
    return app.listen(cfg.port, () => console.log(`[gateway] ObservaOne Gateway ${GATEWAY_VERSION} on :${cfg.port}, centre ${cfg.upstream}`));
  };
  const stop = () => timers.forEach(clearInterval);
  return { app, start, stop, replay, status, state, spoolStats };
}

// node src/gateway.js
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    const g = createGateway(gatewayConfig());
    const server = g.start();
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { g.stop(); server.close(() => process.exit(0)); });
  } catch (e) {
    console.error('[gateway]', e.message);
    process.exit(1);
  }
}
