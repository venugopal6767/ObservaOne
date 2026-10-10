// Sample data for the Developer dashboard: services, endpoints, error groups and traces.
// Each service, endpoint and error is seeded by its own name, so its numbers stay the same
// whatever filter you look at it through (only the time range changes the charts).
import { rng, hash, series, between, int, pick, SERVICES } from './mock.js';

const ROUTES = {
  checkout: ['POST /checkout', 'GET /cart', 'POST /cart/items', 'DELETE /cart/items/{id}'],
  'payments-api': ['POST /payments', 'GET /payments/{id}', 'POST /refunds'],
  orders: ['GET /orders', 'GET /orders/{id}', 'POST /orders', 'PATCH /orders/{id}/status'],
  catalog: ['GET /products', 'GET /products/{id}', 'GET /categories'],
  search: ['GET /search', 'GET /suggest'],
  recommendations: ['GET /recommendations/{userId}', 'POST /events'],
  auth: ['POST /login', 'POST /token/refresh', 'GET /userinfo'],
  notifications: ['POST /notify', 'GET /templates'],
  inventory: ['GET /stock/{sku}', 'POST /reservations', 'DELETE /reservations/{id}'],
  'api-gateway': ['GET /*', 'POST /*'],
};
const ERRORS = {
  Java: [['NullPointerException', 'Cannot invoke "Cart.getItems()" because "cart" is null'], ['SQLTransientConnectionException', 'HikariPool-1 - Connection is not available, request timed out after 30000ms'], ['IllegalStateException', 'Order already in final state SHIPPED']],
  Go: [['context deadline exceeded', 'calling ledger.Reserve: context deadline exceeded'], ['dial tcp 10.20.4.17:6379: connect: connection refused', 'redis: connection refused'], ['json: cannot unmarshal string into Go struct field Payment.amount of type int64', '']],
  'Node.js': [['TypeError', "Cannot read properties of undefined (reading 'id')"], ['ECONNRESET', 'socket hang up while calling inventory'], ['UnhandledPromiseRejection', 'Request failed with status code 502']],
  Python: [['KeyError', "'currency'"], ['TimeoutError', 'Elasticsearch query exceeded 5s'], ['ValidationError', '1 validation error for ProductIn: price must be greater than 0']],
};
const FRAMES = {
  Java: (svc) => [`com.example.${svc.replace(/-/g, '')}.service.CartService.total(CartService.java:142)`, `com.example.${svc.replace(/-/g, '')}.api.CheckoutController.submit(CheckoutController.java:88)`, 'org.springframework.web.servlet.FrameworkServlet.service(FrameworkServlet.java:897)', 'jakarta.servlet.http.HttpServlet.service(HttpServlet.java:614)'],
  Go: (svc) => [`github.com/example/${svc}/internal/handler.(*Handler).Create(handler.go:211)`, `github.com/example/${svc}/internal/client.(*Ledger).Reserve(ledger.go:64)`, 'net/http.HandlerFunc.ServeHTTP(server.go:2171)', 'net/http.serverHandler.ServeHTTP(server.go:3142)'],
  'Node.js': (svc) => [`at OrderService.toDto (/app/src/${svc}/order.service.js:57:21)`, `at async OrderController.get (/app/src/${svc}/order.controller.js:23:18)`, 'at async /app/node_modules/express/lib/router/layer.js:95:5', 'at async next (/app/node_modules/express/lib/router/route.js:149:13)'],
  Python: (svc) => [`File "/app/${svc}/api/routes.py", line 74, in get_product`, `File "/app/${svc}/domain/pricing.py", line 31, in price_for`, 'File "/usr/local/lib/python3.12/site-packages/fastapi/routing.py", line 301, in app', 'File "/usr/local/lib/python3.12/site-packages/starlette/routing.py", line 74, in app'],
};

function serviceStats(s, env, start, end) {
  const r = rng(`dev|svc|${env}|${s.name}`);
  const rps = between(r, 8, s.tier === 1 ? 420 : 160);
  const errorRate = r() < 0.25 ? between(r, 1.2, 4.8) : between(r, 0.05, 0.9);
  const p50 = between(r, 18, 90), p95 = p50 * between(r, 2.4, 5.5);
  const major = int(r, 1, 4), minor = int(r, 0, 25), patch = int(r, 0, 9);
  const prevErr = errorRate * between(r, 0.4, 1.2), prevP95 = p95 * between(r, 0.75, 1.15);
  const rs = rng(`dev|svcseries|${env}|${s.name}|${start - (start % 60)}`);
  return {
    ...s, rps, errorRate, p50, p95, apdex: Math.max(0.6, Math.min(0.99, 1 - errorRate / 20 - p95 / 4000)),
    version: `v${major}.${minor}.${patch}`, previous: `v${major}.${minor}.${Math.max(0, patch - 1)}`,
    prevErrorRate: prevErr, prevP95, lastDeployAt: end * 1000 - between(r, 0.3, 72) * 3600_000,
    rpsSeries: series(rs, { start, end, base: rps, amp: rps * 0.25, noise: rps * 0.06, min: 0 }),
    errSeries: series(rs, { start, end, base: errorRate, amp: errorRate * 0.4, noise: errorRate * 0.2, min: 0, spikes: errorRate > 1 ? 2 : 0 }),
    p95Series: series(rs, { start, end, base: p95, amp: p95 * 0.15, noise: p95 * 0.08, min: 1, spikes: 1 }),
    p50Series: series(rs, { start, end, base: p50, amp: p50 * 0.1, noise: p50 * 0.05, min: 1 }),
    deps: (s.name === 'api-gateway' ? ['auth', 'orders', 'catalog', 'search'] : [pick(r, ['postgres', 'mysql', 'mongodb']), 'redis', pick(r, SERVICES.filter((x) => x.name !== s.name)).name]).map((d) => ({ name: d, p95: between(r, 2, 140), calls: int(r, 1, 6), errorRate: r() < 0.2 ? between(r, 0.5, 3) : between(r, 0, 0.3) })),
  };
}

function endpointsOf(svc, env) {
  return (ROUTES[svc.name] || ['GET /']).map((route, i) => {
    const r = rng(`dev|ep|${env}|${svc.name}|${route}`);
    const p95 = svc.p95 * between(r, 0.4, 2.2);
    return {
      id: `${svc.name}~${i}`, service: svc.name, route, method: route.split(' ')[0], path: route.split(' ')[1],
      rps: svc.rps * between(r, 0.05, 0.5), p95, p50: p95 / between(r, 2.2, 4.5), p99: p95 * between(r, 1.3, 2.4),
      errorRate: svc.errorRate * between(r, 0.2, 2.4),
    };
  });
}

function errorsOf(svc, env, end) {
  const r = rng(`dev|err|${env}|${svc.name}`);
  const n = svc.errorRate > 1 ? int(r, 2, 3) : int(r, 0, 2);
  const kinds = ERRORS[svc.lang] || ERRORS.Go;
  return Array.from({ length: n }, (_, i) => {
    const [type, msg] = kinds[(i + int(r, 0, 2)) % kinds.length];
    const eps = ROUTES[svc.name] || ['GET /'];
    const firstSeen = end * 1000 - between(r, 0.2, 240) * 3600_000;
    return {
      id: `err-${hash(`${svc.name}|${i}|${type}`) % 9000000 + 1000000}`, service: svc.name, team: svc.team, lang: svc.lang, type, message: msg || type,
      endpoint: pick(r, eps), count: int(r, 12, svc.errorRate > 1 ? 4200 : 600), users: int(r, 3, 900),
      firstSeen, lastSeen: end * 1000 - between(r, 0.01, 0.9) * 3600_000, isNew: firstSeen > end * 1000 - 24 * 3600_000,
      status: pick(r, ['unresolved', 'unresolved', 'unresolved', 'investigating']),
      frames: (FRAMES[svc.lang] || FRAMES.Go)(svc.name),
      version: svc.version,
    };
  });
}

export function developerData({ env, start, end, team, service, empty = false }) {
  const pickSvcs = empty ? [] : SERVICES.filter((s) => (!team || s.team === team) && (!service || s.name === service));
  const services = pickSvcs.map((s) => serviceStats(s, env, start, end));
  const endpoints = services.flatMap((s) => endpointsOf(s, env));
  const errors = services.flatMap((s) => errorsOf(s, env, end)).sort((a, b) => b.count - a.count);
  const total = services.reduce((a, s) => a + s.rps, 0);
  const wavg = (k) => (total ? services.reduce((a, s) => a + s[k] * s.rps, 0) / total : 0);
  const sumSeries = (k) => (services.length ? services[0][k].map(([t], i) => [t, services.reduce((a, s) => a + s[k][i][1] * (k === 'rpsSeries' ? 1 : s.rps / total), 0)]) : []);
  const p95 = sumSeries('p95Series');
  return {
    services, endpoints, errors,
    kpi: {
      rps: total, errorRate: wavg('errorRate'), prevErrorRate: wavg('prevErrorRate'), p95: wavg('p95'), prevP95: wavg('prevP95'),
      errorEvents: errors.reduce((a, e) => a + e.count, 0), newErrors: errors.filter((e) => e.isNew).length,
      slowest: [...endpoints].sort((a, b) => b.p95 - a.p95)[0] || null,
      apdex: wavg('apdex'),
    },
    series: {
      rps: sumSeries('rpsSeries'), err: sumSeries('errSeries'), p95,
      p50: sumSeries('p50Series'), p99: p95.map(([t, v]) => [t, v * 1.7]),
    },
  };
}

export function serviceDetail({ env, start, end }, name) {
  const s = SERVICES.find((x) => x.name === name);
  if (!s) return null;
  const svc = serviceStats(s, env, start, end);
  return { svc, endpoints: endpointsOf(svc, env), errors: errorsOf(svc, env, end) };
}

export function endpointDetail({ env, start, end }, id) {
  const [name, idx] = id.split('~');
  const d = serviceDetail({ env, start, end }, name);
  const ep = d?.endpoints[Number(idx)];
  if (!ep) return null;
  const r = rng(`dev|epd|${env}|${id}`);
  const buckets = ['<25ms', '25-50', '50-100', '100-250', '250-500', '500ms-1s', '1-2.5s', '>2.5s'];
  const peak = ep.p50 < 50 ? 1 : ep.p50 < 100 ? 2 : 3;
  const histogram = buckets.map((b, i) => Math.round(1000 * Math.exp(-((i - peak) ** 2) / 2.2) * between(r, 0.7, 1.2)));
  const traces = Array.from({ length: 8 }, (_, i) => ({
    id: (hash(`${id}|${i}`).toString(16) + hash(`${i}|${id}`).toString(16)).padEnd(16, '0').slice(0, 16),
    durationMs: ep.p95 * between(r, 0.9, 3.2), status: r() < Math.min(0.5, ep.errorRate / 10 + 0.1) ? 'error' : 'ok', at: end * 1000 - between(r, 0.01, 1) * 3600_000, spans: int(r, 6, 24),
  })).sort((a, b) => b.durationMs - a.durationMs);
  return { ...d, ep, buckets, histogram, traces, latency: [
    { label: 'p50', points: series(r, { start, end, base: ep.p50, amp: ep.p50 * 0.1, noise: ep.p50 * 0.05, min: 1 }) },
    { label: 'p95', points: series(r, { start, end, base: ep.p95, amp: ep.p95 * 0.15, noise: ep.p95 * 0.08, min: 1, spikes: 1 }) },
    { label: 'p99', points: series(r, { start, end, base: ep.p99, amp: ep.p99 * 0.2, noise: ep.p99 * 0.1, min: 1, spikes: 2 }) },
  ] };
}

export function errorDetail({ env, start, end }, id) {
  for (const s of SERVICES) {
    const d = serviceDetail({ env, start, end }, s.name);
    const e = d.errors.find((x) => x.id === id);
    if (e) {
      const r = rng(`dev|errd|${id}`);
      return {
        ...d, err: e,
        occurrences: series(r, { start, end, base: e.count / 60, amp: e.count / 150, noise: e.count / 200, min: 0, spikes: 2 }),
        logs: Array.from({ length: 6 }, (_, i) => ({ at: e.lastSeen - i * between(r, 20, 400) * 1000, level: 'ERROR', text: `${e.type}: ${e.message} (route=${e.endpoint.split(' ')[1]}, user=user-${int(r, 100, 999)})` })),
        traces: Array.from({ length: 4 }, (_, i) => (hash(`${id}|t${i}`).toString(16) + hash(`t${i}|${id}`).toString(16)).padEnd(16, '0').slice(0, 16)),
        versions: [[e.version, e.count], [d.svc.previous, Math.round(e.count * between(r, 0, 0.3))]],
      };
    }
  }
  return null;
}

// A made-up but consistent trace: gateway -> service -> its dependencies
export function traceDetail({ env }, id, hint) {
  const r = rng(`dev|trace|${id}`);
  const root = SERVICES.find((s) => s.name === hint) || pick(r, SERVICES.filter((s) => s.name !== 'api-gateway'));
  const svc = serviceStats(root, env, 0, 60);
  const route = pick(r, ROUTES[root.name] || ['GET /']);
  const total = between(r, svc.p95 * 0.8, svc.p95 * 3);
  const spans = [{ id: 's0', name: route, service: 'api-gateway', start: 0, dur: total, depth: 0, status: 'ok' }];
  spans.push({ id: 's1', name: route, service: root.name, start: total * 0.03, dur: total * 0.94, depth: 1, status: 'ok' });
  let t = total * 0.06;
  for (const d of svc.deps) {
    const dur = Math.min(total * 0.88 - t, between(r, total * 0.08, total * 0.4));
    if (dur <= 0) break;
    const kind = ['postgres', 'mysql', 'mongodb'].includes(d.name) ? 'db' : d.name === 'redis' ? 'cache' : 'http';
    spans.push({ id: `s${spans.length}`, name: kind === 'db' ? 'SELECT orders WHERE customer_id = ?' : kind === 'cache' ? 'GET cart:{id}' : `POST /internal/${d.name}`, service: d.name, start: t, dur, depth: 2, status: 'ok', kind });
    t += dur + total * 0.02;
  }
  const failed = r() < 0.35;
  if (failed) { spans[spans.length - 1].status = 'error'; spans[1].status = 'error'; spans[0].status = 'error'; }
  return { id, service: root.name, route, total, spans, failed, at: Date.now() - between(r, 1, 50) * 60_000 };
}
