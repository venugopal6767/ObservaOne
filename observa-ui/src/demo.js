// Demo data for pages whose real backend is not connected yet.
// Every response built here is marked demo: true and the UI shows a DEMO badge.

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed) {
  let a = typeof seed === 'number' ? seed : hash(String(seed));
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// smooth noise in [0,1] that changes slowly with time
function wave(key, t, periodSec = 900) {
  const r = rng(key);
  const p1 = r() * 6.28, p2 = r() * 6.28;
  const x = t / periodSec;
  const n = rng(`${key}|${Math.floor(t / 30)}`)();
  return 0.5 + 0.28 * Math.sin(x * 6.28 + p1) + 0.12 * Math.sin(x * 17.3 + p2) + 0.1 * (n - 0.5);
}

const MAIN = [
  ['mule-app', 'integration'], ['payment-service', 'checkout'], ['order-service', 'orders'], ['inventory', 'orders'],
  ['user-service', 'identity'], ['notification', 'messaging'], ['auth-service', 'identity'], ['api-gateway', 'edge'],
  ['cart-service', 'checkout'], ['catalog-service', 'catalog'], ['shipping-service', 'delivery'], ['search-service', 'catalog'],
  ['pricing-service', 'catalog'], ['review-service', 'catalog'], ['email-service', 'messaging'], ['recommendation', 'catalog'],
];
const EXTRA = ['batch', 'report', 'sync', 'audit', 'search', 'cache', 'mailer', 'scheduler'];

export const DEMO_SERVICES = (() => {
  const list = MAIN.map(([name, ns]) => ({ name, namespace: ns }));
  let i = 0;
  while (list.length < 48) {
    const base = EXTRA[i % EXTRA.length];
    list.push({ name: `${base}-worker-${String(Math.floor(i / EXTRA.length) + 1).padStart(2, '0')}`, namespace: 'platform' });
    i++;
  }
  // fixed health mix like the design: 36 healthy, 8 degraded, 4 down
  const degraded = new Set(['payment-service', 'shipping-service', 'report-worker-01', 'sync-worker-02', 'cache-worker-03', 'review-service', 'search-worker-01', 'mailer-worker-02']);
  const down = new Set(['user-service', 'audit-worker-02', 'scheduler-worker-03', 'batch-worker-04']);
  return list.map((s) => ({ ...s, health: down.has(s.name) ? 'down' : degraded.has(s.name) ? 'degraded' : 'healthy' }));
})();

function baseRps(name) {
  const r = rng(`rps|${name}`);
  if (name === 'mule-app') return 1240;
  if (name === 'api-gateway') return 2100;
  return Math.round(40 + r() * (MAIN.some((m) => m[0] === name) ? 900 : 120));
}

export function serviceAt(s, t) {
  const w = wave(s.name, t);
  if (s.health === 'down') return { rps: 0, p95: null, errorRate: 100 };
  const rps = baseRps(s.name) * (0.75 + 0.5 * w);
  const r = rng(`lat|${s.name}`);
  let p95 = 120 + r() * 250 + 120 * w;
  let errorRate = 0.1 + r() * 0.4 + 0.2 * w;
  if (s.health === 'degraded') {
    p95 = 900 + 600 * w;
    errorRate = 1.5 + 1.5 * w;
  }
  return { rps, p95, errorRate };
}

export function demoServices(now = Date.now() / 1000) {
  return DEMO_SERVICES.map((s) => ({ name: s.name, namespace: s.namespace, status: s.health, ...serviceAt(s, now) }));
}

export function demoServiceSeries(metric, start, end, step, names) {
  const pick = names?.length ? DEMO_SERVICES.filter((s) => names.includes(s.name)) : DEMO_SERVICES.slice(0, 5);
  return pick.map((s) => {
    const values = [];
    for (let t = start; t <= end; t += step) {
      const v = serviceAt(s, t)[metric];
      values.push([t, v === null ? null : Number(v.toFixed(2))]);
    }
    return { metric: { service: s.name }, values };
  });
}

// ---------------- Logs ----------------
const MESSAGES = {
  ERROR: ['Payment processing failed for order {order}', 'Connection timeout while calling downstream service', 'Database connection timeout', 'NullPointerException in PaymentProcessor.process', 'HTTP 503 from shipping-provider API', 'Failed to publish event to Kafka topic order-events'],
  WARN: ['High response time: 1.2s', 'Slow response time detected (2450 ms)', 'High memory usage detected', 'Retrying request (attempt 2/3)', 'Connection pool 85% used'],
  INFO: ['Cache refreshed successfully', 'Stock level updated: {stock}', 'Request processed successfully', 'User login successful', 'Payment captured for order {order}', 'Order {order} created'],
  DEBUG: ['Cache hit for key account:summary', 'Outgoing request headers prepared', 'Parsed 42 records from batch file'],
};
const LEVEL_WEIGHT = [['INFO', 0.62], ['DEBUG', 0.22], ['WARN', 0.11], ['ERROR', 0.05]];

function podName(svc) {
  const r = rng(`pod|${svc}`);
  const id = Math.floor(r() * 0xfffff).toString(16).padStart(5, '0');
  return `${svc}-${id.slice(0, 4)}d-${Math.floor(r() * 0xffff).toString(36).slice(0, 5)}`;
}

function parseLogQuery(q) {
  const out = { labels: {}, contains: [], notContains: [], regex: [] };
  const sel = /\{([^}]*)\}/.exec(q || '');
  if (sel) {
    for (const m of sel[1].matchAll(/(\w+)\s*(=~|=)\s*"([^"]*)"/g)) out.labels[m[1]] = { op: m[2], v: m[3] };
  }
  for (const m of (q || '').matchAll(/(\|=|!=|\|~)\s*"([^"]*)"/g)) {
    if (m[1] === '|=') out.contains.push(m[2].toLowerCase());
    else if (m[1] === '!=') out.notContains.push(m[2].toLowerCase());
    else {
      try { out.regex.push(new RegExp(m[2], 'i')); } catch { /* ignore bad regex */ }
    }
  }
  return out;
}

export function demoLogs({ query, start, end, limit = 500 }) {
  const f = parseLogQuery(query);
  const svcs = DEMO_SERVICES.filter((s) => s.health !== 'down' || true).slice(0, 16);
  const entries = [];
  const stepMs = 1500;
  const endMs = Math.floor(end * 1000 / stepMs) * stepMs;
  for (let t = endMs; t >= start * 1000 && entries.length < limit; t -= stepMs) {
    const r = rng(`log|${t}`);
    const s = svcs[Math.floor(r() * svcs.length)];
    let x = r(), level = 'INFO';
    let acc = 0;
    const errBoost = s.health === 'degraded' ? 2.5 : s.health === 'down' ? 6 : 1;
    for (const [lv, w] of LEVEL_WEIGHT) {
      acc += lv === 'ERROR' || lv === 'WARN' ? w * errBoost : w;
      if (x * (1 + 0.16 * (errBoost - 1)) <= acc) { level = lv; break; }
    }
    const msgs = MESSAGES[level];
    const order = 10000 + Math.floor(r() * 90000);
    const message = msgs[Math.floor(r() * msgs.length)].replace('{order}', order).replace('{stock}', 100 + Math.floor(r() * 2000));
    const traceId = traceIdFor(s.name, Math.floor(r() * 1e6), t);
    remember(traceId, s.name, t / 1000);
    const e = {
      id: `${t}-${s.name}`, ts: t, level, service: s.name, namespace: s.namespace, pod: podName(s.name), message, traceId,
      attrs: { orderId: String(order), userId: `user-${100 + Math.floor(r() * 900)}`, environment: 'production' },
    };
    // filters
    let ok = true;
    for (const [k, { op, v }] of Object.entries(f.labels)) {
      const val = k === 'app' || k === 'service' || k === 'service_name' || k === 'job' ? e.service : k === 'namespace' ? e.namespace : k === 'level' ? e.level.toLowerCase() : k === 'pod' ? e.pod : null;
      if (val === null) continue;
      if (op === '=' && val !== v && !(k === 'level' && val === v.toLowerCase())) ok = false;
      if (op === '=~') { try { if (!new RegExp(`^(?:${v})$`).test(val)) ok = false; } catch { ok = false; } }
    }
    const line = `${e.level} ${e.message}`.toLowerCase();
    if (f.contains.some((c) => !line.includes(c))) ok = false;
    if (f.notContains.some((c) => line.includes(c))) ok = false;
    if (f.regex.some((re) => !re.test(line))) ok = false;
    if (ok) entries.push(e);
  }
  return entries;
}

// ---------------- Traces ----------------
const TRACE_SHAPES = {
  default: [
    { svc: '$root', name: 'POST /api/v1/payments', children: [
      { svc: 'payment-service', name: 'authorise', children: [{ svc: 'database', name: 'SELECT accounts' }] },
      { svc: 'order-service', name: 'create-order', children: [{ svc: 'external-api', name: 'POST /notify' }] },
    ] },
  ],
};

// Remember what the search produced so the detail view shows the same trace.
const traceMeta = new Map();
function remember(id, root, startSec) {
  traceMeta.set(id, { root, startSec });
  if (traceMeta.size > 5000) traceMeta.delete(traceMeta.keys().next().value);
}

function traceIdFor(service, i, bucket) {
  return hash(`${service}|${bucket}|${i}`).toString(16).padStart(8, '0') + hash(`x${i}|${bucket}|${service}`).toString(16).padStart(8, '0');
}

export function demoTraceSearch({ service, start, end, limit = 20, minDurationMs = 0 }) {
  const svcs = service ? [service] : ['mule-app', 'payment-service', 'order-service', 'inventory', 'api-gateway'];
  const out = [];
  const bucket = Math.floor(end / 60);
  for (let i = 0; i < limit * 2 && out.length < limit; i++) {
    const svc = svcs[i % svcs.length];
    const id = traceIdFor(svc, i, bucket);
    remember(id, svc, end - i * 37);
    const t = buildTrace(id);
    if (t.durationMs < minDurationMs) continue;
    if (t.startMs / 1000 < start) continue;
    out.push({ traceId: id, rootService: svc, rootName: t.spans[0].name, startMs: t.startMs, durationMs: t.durationMs, error: t.error, spanCount: t.spans.length });
  }
  return out;
}

export function buildTrace(id) {
  const meta = traceMeta.get(id);
  const r = rng(`trace|${id}`);
  const pick = Math.floor(r() * 4);
  const root = meta?.root || ['mule-app', 'payment-service', 'order-service', 'inventory'][pick];
  const startSec = meta?.startSec ?? null;
  const startMs = (startSec ?? Date.now() / 1000 - r() * 3600) * 1000;
  const slow = r() < 0.2;
  const error = r() < 0.18;
  const spans = [];
  let n = 0;
  function add(node, parentId, offset, budget) {
    const spanId = `${id.slice(0, 8)}${(n++).toString(16).padStart(8, '0')}`;
    const svc = node.svc === '$root' ? root : node.svc;
    const dur = Math.max(5, Math.round(budget * (0.6 + 0.35 * r())));
    const span = { spanId, parentId, service: svc, name: node.name, startMs: startMs + offset, durationMs: dur, error: false };
    spans.push(span);
    const kids = node.children || [];
    let cursor = offset + Math.round(dur * 0.05);
    for (const k of kids) {
      const kb = Math.round((dur * 0.85) / kids.length);
      const childStart = cursor;
      const child = add(k, spanId, childStart, kb);
      cursor = childStart + child.durationMs + Math.round(dur * 0.02);
    }
    return span;
  }
  const total = slow ? 900 + r() * 3600 : 180 + r() * 1100;
  add(TRACE_SHAPES.default[0], null, 0, total);
  if (error) {
    const victim = spans[spans.length - 1];
    victim.error = true;
    victim.statusMessage = 'upstream returned 503';
    spans[0].error = true;
  }
  const durationMs = Math.max(...spans.map((s) => s.startMs + s.durationMs)) - startMs;
  return { traceId: id, startMs, durationMs, error, spans };
}
