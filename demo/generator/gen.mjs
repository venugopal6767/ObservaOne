// ObservaOne DEMO DATA generator (test data only; delete the demo/ folder to remove it).
//   node gen.mjs seed   - writes the last N days of metric history into the demo Prometheus data folder
//   node gen.mjs serve  - serves live exporter metrics for the demo Prometheus, and pushes logs to Loki
//                         and traces to Tempo
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DAY, HOUR, MIN, HOSTS, CLUSTERS, SERVICES, svcErr, svcSlow, svcRate, hostBusy, hostMem, burst, hash } from './model.mjs';
import { clock, targets, collect, isDown } from './metrics.mjs';

const MODE = process.argv[2] || 'serve';
const STATE = process.env.DEMO_STATE || '/state';
const PROM_DATA = process.env.PROM_DATA || '/prometheus';
const PROMTOOL = process.env.PROMTOOL || 'promtool';
const DAYS = Number(process.env.DEMO_DAYS || 8);
const PORT = Number(process.env.PORT || 9101);
const ADDRESS = process.env.DEMO_ADDRESS || 'demo:9101';
const LOKI = (process.env.LOKI_URL ?? 'http://loki:3100').replace(/\/$/, '');
const TEMPO = (process.env.TEMPO_OTLP_URL ?? 'http://tempo:4318').replace(/\/$/, '');
const LOG_HOURS = Number(process.env.DEMO_LOG_HOURS || 6);
const log = (...a) => console.log(new Date().toISOString(), ...a);

fs.mkdirSync(STATE, { recursive: true });
const clockFile = path.join(STATE, 'clock.json');
const nowSec = () => Date.now() / 1000;
const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const lbl = (o) => { const e = Object.entries(o).filter(([, v]) => v !== '' && v != null); return e.length ? `{${e.map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}` : ''; };
const num = (v) => (Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : v.toPrecision(12)) : 'NaN');

// =====================================================================================
// seed: metric history (OpenMetrics files turned into TSDB blocks by promtool)
// =====================================================================================
function seed() {
  if (fs.existsSync(path.join(STATE, 'seeded'))) { log('history already written, nothing to do'); return; }
  const now = Math.floor(nowSec() / 60) * 60;
  const start = now - DAYS * DAY;
  clock.t0 = start - HOUR; clock.ref = now;
  fs.writeFileSync(clockFile, JSON.stringify(clock));
  const all = targets();
  fs.mkdirSync(PROM_DATA, { recursive: true });
  const tmp = path.join(STATE, 'chunk.om');
  log(`writing ${DAYS} days of history for ${all.length} targets`);
  for (let a = start; a < now; a += DAY) {
    const b = Math.min(now + 1, a + DAY);
    const series = new Map();
    for (let t = a; t < b; t += t < now - 26 * HOUR ? 120 : 60) {
      for (const tg of all) {
        const down = isDown(tg, t);
        push(series, 'up', tg.labels, down ? 0 : 1, t);
        if (down) continue;
        for (const [name, l, v] of collect(tg, t)) push(series, name, { ...tg.labels, ...l }, v, t);
      }
    }
    const keys = [...series.keys()].sort();
    const fd = fs.openSync(tmp, 'w');
    let buf = '';
    for (const k of keys) {
      const s = series.get(k);
      for (let i = 0; i < s.ts.length; i++) {
        buf += `${k} ${num(s.v[i])} ${s.ts[i]}\n`;
        if (buf.length > 1 << 20) { fs.writeSync(fd, buf); buf = ''; }
      }
    }
    fs.writeSync(fd, `${buf}# EOF\n`);
    fs.closeSync(fd);
    const r = spawnSync(PROMTOOL, ['tsdb', 'create-blocks-from', 'openmetrics', '--max-block-duration=24h', tmp, PROM_DATA], { encoding: 'utf8' });
    if (r.status !== 0) { console.error(r.stdout, r.stderr); throw new Error('promtool failed'); }
    log(`day ${new Date(a * 1000).toISOString().slice(0, 10)} done (${keys.length} series)`);
  }
  fs.rmSync(tmp, { force: true });
  spawnSync('chown', ['-R', '65534:65534', PROM_DATA]); // the Prometheus image runs as "nobody"
  fs.writeFileSync(path.join(STATE, 'seeded'), new Date().toISOString());
  log('history written');
}
function push(map, name, labels, v, t) {
  const k = name + lbl(labels);
  let s = map.get(k);
  if (!s) map.set(k, (s = { ts: [], v: [] }));
  s.ts.push(t); s.v.push(v);
}

// =====================================================================================
// serve: live exporter + http service discovery
// =====================================================================================
function serve() {
  if (fs.existsSync(clockFile)) Object.assign(clock, JSON.parse(fs.readFileSync(clockFile, 'utf8')));
  else { clock.t0 = nowSec() - HOUR; clock.ref = nowSec(); fs.writeFileSync(clockFile, JSON.stringify(clock)); }
  const all = targets();
  const byId = new Map(all.map((t) => [t.id, t]));
  const t0 = Date.now();
  for (const tg of all) collect(tg, nowSec()); // warm the counters once
  log(`ready in ${Date.now() - t0} ms: ${all.length} targets`);

  http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/sd') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(all.map((tg) => ({ targets: [ADDRESS], labels: { __metrics_path__: `/metrics/${tg.id}`, ...tg.labels } }))));
    }
    if (u.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
    const tg = u.pathname.startsWith('/metrics/') && byId.get(decodeURIComponent(u.pathname.slice(9)));
    if (!tg) { res.writeHead(404); return res.end('not found'); }
    const t = nowSec();
    if (isDown(tg, t)) { res.writeHead(503); return res.end('host is down (demo)'); }
    let out = '';
    for (const [name, l, v] of collect(tg, t)) out += `${name}${lbl(l)} ${num(v)}\n`;
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(out);
  }).listen(PORT, () => log(`exporter on :${PORT}`));

  if (LOKI || TEMPO) startEvents();
}

// =====================================================================================
// logs (Loki) and traces (Tempo)
// =====================================================================================
const hex = (n) => crypto.randomBytes(n).toString('hex');
const rand = Math.random;
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const svc = Object.fromEntries(SERVICES.map((s) => [s.name, s]));
const prodPods = Object.fromEntries(CLUSTERS[0].workloads.map((w) => [w.name, CLUSTERS[0].pods.filter((p) => p.w.name === w.name && p.phase === 'Running')]));
function latency(name, t) {
  const s = svc[name];
  const slow = rand() < svcSlow(s, t);
  const med = s.p50 * (slow ? 5 : 1);
  return Math.max(0.001, med * Math.exp(0.55 * Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand())));
}
const FLOWS = [
  ['checkout', 0.45, [['auth', 'GET /api/auth/validate'], ['inventory', 'POST /api/inventory/reserve', 'SELECT stock'], ['payments-api', 'POST /api/payments/charge', 'POST card-gateway'], ['orders', 'POST /api/orders', 'INSERT orders'], ['notification', 'POST /api/notify']]],
  ['search', 0.25, [['auth', 'GET /api/auth/validate']]],
  ['mule-gateway', 0.3, [['mule-runtime', 'POST /flows/account-sync', 'SELECT accounts']]],
];
const ERRORS = {
  inventory: 'Failed to reserve stock: connection timeout to prod-db-01:5432 after 2000 ms',
  'payments-api': 'Card gateway returned HTTP 503 Service Unavailable',
  checkout: 'Downstream call failed, returning 502 to client',
  orders: 'Deadlock detected while inserting order, transaction rolled back',
  search: 'Search index shard 3 not available',
  'mule-runtime': 'Flow account-sync failed: com.mulesoft.connectivity.ConnectionException: Read timed out',
  'mule-gateway': 'Upstream mule-runtime returned 500',
  auth: 'Token signature validation failed',
  notification: 'SMTP relay refused connection',
};

/** one request through several services: returns { spans: resourceSpans[], logs: [labels, ns, line][] } */
function flow(t) {
  let r = rand(), f = FLOWS[0];
  for (const x of FLOWS) { if (r < x[1]) { f = x; break; } r -= x[1]; }
  const [rootName, , calls] = f;
  const traceId = hex(16), rootId = hex(8);
  const rs = new Map(), logs = [];
  const res = (name) => {
    if (!rs.has(name)) {
      const s = svc[name], pod = pick(prodPods[name] || [{ pod: `${name}-0`, node: 'k8s-node-01' }]);
      rs.set(name, { pod, s, spans: [] });
    }
    return rs.get(name);
  };
  const add = (name, id, parent, opName, start, dur, err, kind, attrs) => {
    res(name).spans.push({
      traceId, spanId: id, ...(parent ? { parentSpanId: parent } : {}), name: opName, kind,
      startTimeUnixNano: String(Math.round(start * 1e9)), endTimeUnixNano: String(Math.round((start + dur) * 1e9)),
      attributes: Object.entries(attrs).map(([key, v]) => ({ key, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: String(v) } })),
      status: err ? { code: 2, message: ERRORS[name] || 'error' } : { code: 1 },
    });
  };
  const logLine = (name, ts, level, msg, extra = '') => {
    const { pod, s } = res(name);
    logs.push([{ service_name: name, level, env: s.env, namespace: s.ns, cluster: s.cluster, host: pod.node, pod: pod.pod, job: 'k8s-pods' }, ts, `${new Date(ts * 1000).toISOString()} ${level.toUpperCase().padEnd(5)} [${name}] ${msg}${extra} trace_id=${traceId}`]);
  };
  let cursor = t + 0.002, anyErr = false;
  for (const [name, op, dbOp] of calls) {
    const id = hex(8), d = latency(name, t), err = rand() < svcErr(svc[name], t);
    anyErr = anyErr || err;
    const [method, route] = op.split(' ');
    add(name, id, rootId, op, cursor, d, err, 2, { 'http.request.method': method, 'http.route': route, 'http.response.status_code': err ? 500 : 200 });
    if (dbOp) {
      const isDb = /^(SELECT|INSERT)/.test(dbOp);
      add(name, hex(8), id, dbOp, cursor + d * 0.1, d * 0.75, err, 3, isDb ? { 'db.system': 'postgresql', 'db.namespace': name === 'mule-runtime' ? 'accounts' : name, 'db.query.text': `${dbOp} ...`, 'server.address': 'prod-db-01' } : { 'http.request.method': 'POST', 'server.address': 'gateway.cards.example', 'http.response.status_code': err ? 503 : 200 });
    }
    if (err) logLine(name, cursor + d, 'error', ERRORS[name] || 'request failed', ` status=500 duration_ms=${Math.round(d * 1000)}`);
    else if (d > svc[name].p50 * 5) logLine(name, cursor + d, 'warn', `Slow request ${op}`, ` duration_ms=${Math.round(d * 1000)}`);
    else if (rand() < 0.35) logLine(name, cursor + d, 'info', `${op} completed`, ` status=200 duration_ms=${Math.round(d * 1000)}`);
    cursor += d + 0.002;
  }
  const total = cursor - t + latency(rootName, t) * 0.3;
  const s0 = svc[rootName];
  const route = s0.route;
  add(rootName, rootId, null, `${s0.method} ${route}`, t, total, anyErr, 2, { 'http.request.method': s0.method, 'http.route': route, 'http.response.status_code': anyErr ? 502 : 200, 'client.address': `10.20.${Math.floor(rand() * 250)}.${Math.floor(rand() * 250)}` });
  logLine(rootName, t + total, anyErr ? 'error' : 'info', anyErr ? ERRORS[rootName] : `${s0.method} ${route} completed`, ` status=${anyErr ? 502 : 200} duration_ms=${Math.round(total * 1000)}`);
  const spans = [...rs.entries()].map(([name, { pod, s, spans: sp }]) => ({
    resource: { attributes: [['service.name', name], ['deployment.environment.name', s.env], ['k8s.namespace.name', s.ns], ['k8s.cluster.name', s.cluster], ['k8s.pod.name', pod.pod], ['host.name', pod.node]].map(([key, v]) => ({ key, value: { stringValue: v } })) },
    scopeSpans: [{ scope: { name: 'observaone-demo' }, spans: sp }],
  }));
  return { spans, logs };
}

const SYSLOG = {
  sshd: () => `Accepted publickey for deploy from 10.0.4.${Math.floor(rand() * 200)} port ${40000 + Math.floor(rand() * 20000)} ssh2`,
  cron: () => '(root) CMD (/usr/local/bin/backup.sh --incremental)',
  java: () => pick(['GC pause (G1 Evacuation Pause) 38ms', 'Request pool stats: active=42 idle=158', 'Refreshed configuration from config-server']),
  nginx: () => `10.20.${Math.floor(rand() * 250)}.${Math.floor(rand() * 250)} - - "GET /health HTTP/1.1" 200 2 "-" "kube-probe/1.31"`,
  postgres: () => pick(['LOG:  checkpoint complete: wrote 1824 buffers (2.8%)', 'LOG:  automatic vacuum of table "payments.public.ledger": index scans: 1']),
  kubelet: () => pick(['Successfully probed container', 'SyncLoop (PLEG): event for pod']),
  containerd: () => 'shim disconnected id=' + hex(6),
  w3wp: () => 'GET /portal/default.aspx 200 0 0 31',
  lsass: () => 'EventID=4624 An account was successfully logged on. Account: svc-backup',
  MsMpEng: () => 'Security intelligence updated to version 1.419.' + Math.floor(rand() * 900),
};
function hostLogs(t) {
  const out = [];
  for (const h of HOSTS) {
    if (h.downFor && t >= clock.ref - h.downFor) continue;
    if (rand() > 0.25) continue;
    const p = pick(h.procs.filter((x) => SYSLOG[x]).concat(['sshd']));
    const svcName = h.os === 'windows' ? 'windows-eventlog' : (SYSLOG[p] ? p : 'system');
    let level = 'info', line = (SYSLOG[p] || SYSLOG.sshd)();
    if (h.host === 'prod-app-01' && rand() < 0.4 && hostBusy(h, t) > 0.85) { level = 'warn'; line = 'java: thread pool saturated (200/200 active), requests queued'; }
    if (h.host === 'prod-app-02' && rand() < 0.15) { level = 'error'; line = 'filebeat.service: Main process exited, code=exited, status=1/FAILURE'; }
    if (h.host === 'k8s-node-02' && rand() < 0.3 && hostMem(h, t) > 0.88) { level = 'warn'; line = 'kubelet: eviction manager: attempting to reclaim memory, available 1.1Gi below threshold'; }
    if (h.host === 'win-srv-01' && rand() < 0.2) { level = 'warn'; line = 'EventID=2013 The C: disk is at or near capacity. You may need to delete some files.'; }
    if (h.host === 'dev-node-02' && rand() < 0.3) { level = 'error'; line = 'kubelet: PLEG is not healthy: pleg was last seen active 3m12s ago'; }
    if (h.host === 'prod-db-01' && burst(hash('prod-db-01'), t, 6 * HOUR, 45 * MIN) > 0.5 && rand() < 0.5) { level = 'warn'; line = 'LOG:  duration: 2412.334 ms  statement: SELECT * FROM ledger WHERE account_id = $1'; }
    out.push([{ service_name: svcName, host: h.host, env: h.env, level, job: h.os === 'windows' ? 'windows-eventlog' : 'syslog', ...(h.cluster ? { cluster: h.cluster } : {}) }, t + rand(), `${level.toUpperCase().padEnd(5)} ${h.host} ${p}: ${line}`]);
  }
  return out;
}
function k8sEvents(t, every) {
  const out = [];
  const ev = (c, ns, type, reason, obj, msg) => out.push([{ job: 'kubernetes-events', cluster: c, namespace: ns, level: type === 'Warning' ? 'warn' : 'info', reason, kind: obj.split('/')[0] }, t + rand(), `${type} ${reason} ${obj}: ${msg}`]);
  const chance = (perHour) => rand() < (perHour * every) / 3600;
  const [prod, , dev] = CLUSTERS;
  const crash = prod.pods.find((p) => p.crash);
  if (crash && chance(12)) ev(prod.cluster, 'payments', 'Warning', 'BackOff', `pod/${crash.pod}`, `Back-off restarting failed container ${crash.w.name}`);
  if (crash && chance(2.4)) ev(prod.cluster, 'payments', 'Normal', 'Pulled', `pod/${crash.pod}`, `Container image "registry.local/${crash.w.name}:1.4" already present on machine`);
  if (chance(6)) ev(dev.cluster, 'shop', 'Warning', 'FailedScheduling', 'pod/search-indexer-0', '0/2 nodes are available: 1 Insufficient memory, 1 node(s) had untolerated taint {node.kubernetes.io/not-ready}.');
  if (chance(2)) ev(dev.cluster, 'kube-system', 'Warning', 'NodeNotReady', 'node/dev-node-02', 'Node dev-node-02 status is now: NodeNotReady');
  if (chance(1)) ev(dev.cluster, 'shop', 'Warning', 'BackoffLimitExceeded', 'job/batch-report', 'Job has reached the specified backoff limit');
  if (chance(4)) { const p = pick(prod.pods); ev(prod.cluster, p.w.ns, 'Normal', 'Scheduled', `pod/${p.pod}`, `Successfully assigned ${p.w.ns}/${p.pod} to ${p.node}`); }
  if (chance(3)) ev(prod.cluster, 'shop', 'Normal', 'ScalingReplicaSet', 'deployment/checkout', 'Scaled up replica set checkout to 3');
  if (chance(2)) ev(prod.cluster, 'kube-system', 'Warning', 'EvictionThresholdMet', 'node/k8s-node-02', 'Attempting to reclaim memory');
  return out;
}

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
}
async function send(logs, spans) {
  let failed = 0;
  // Loki refuses lines older than what it already has for a stream (e.g. after the demo state was reset):
  // the other lines in the batch are still stored, so that is not worth retrying
  const fail = (e) => { if (/too far behind|out of order/.test(e.message)) return; failed++; log(e.message); };
  if (LOKI && logs.length) {
    const streams = new Map();
    logs.sort((a, b) => a[1] - b[1]);
    for (const [labels, ts, line] of logs) {
      const k = JSON.stringify(labels);
      if (!streams.has(k)) streams.set(k, { stream: labels, values: [] });
      streams.get(k).values.push([String(Math.round(ts * 1e9)), line]);
    }
    await post(`${LOKI}/loki/api/v1/push`, { streams: [...streams.values()] }).catch(fail);
  }
  if (TEMPO && spans.length) await post(`${TEMPO}/v1/traces`, { resourceSpans: spans }).catch(fail);
  return failed;
}
function events(from, to, flowEvery) {
  const logs = [], spans = [];
  for (let t = from; t < to; t += flowEvery * (0.5 + rand())) {
    // fewer requests at night, like the metrics
    const busy = svcRate(svc.checkout, t) / svc.checkout.rps;
    if (rand() > Math.min(1, busy + 0.25)) continue;
    const f = flow(t);
    logs.push(...f.logs); spans.push(...f.spans);
  }
  for (let t = from; t < to; t += 10) logs.push(...hostLogs(t), ...k8sEvents(t, 10));
  return { logs, spans };
}
async function ready(url, name) {
  for (let i = 0; ; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); if (r.ok) return true; } catch { /* not up yet */ }
    if (i % 12 === 0) log(`waiting for ${name} to be ready...`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
async function startEvents() {
  const marker = path.join(STATE, 'events-seeded');
  if (LOKI) await ready(`${LOKI}/ready`, 'Loki');
  if (TEMPO) await ready(`${TEMPO.replace(/:4318$/, ':3200')}/ready`, 'Tempo');
  let last = nowSec();
  if (!fs.existsSync(marker) && LOG_HOURS > 0) {
    log(`pushing ${LOG_HOURS} h of past logs and traces`);
    let failed = 0;
    for (let a = last - LOG_HOURS * HOUR; a < last; a += 10 * MIN) {
      const { logs, spans } = events(a, Math.min(last, a + 10 * MIN), 6);
      failed += await send(logs, spans);
    }
    if (!failed) fs.writeFileSync(marker, new Date().toISOString());
    log(failed ? `past logs and traces pushed with ${failed} failed batches (will retry on next start)` : 'past logs and traces pushed');
  }
  setInterval(async () => {
    const now = nowSec();
    const { logs, spans } = events(last, now, 1);
    last = now;
    await send(logs, spans);
  }, 5000);
}

if (MODE === 'seed') seed();
else serve();
