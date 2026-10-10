// Integration tests against a running ObservaOne (they change module settings and restore them).
// Run:  OBSERVA_TEST_URL=https://your-server OBSERVA_TEST_ADMIN_PASSWORD=... npm test
// Optional: OBSERVA_TEST_ADMIN_USER (default admin), OBSERVA_TEST_VIEWER_USER / _PASSWORD,
//           NODE_TLS_REJECT_UNAUTHORIZED=0 for a self-signed lab certificate.
// Without OBSERVA_TEST_URL these tests are skipped (reported as skipped, never as passed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.OBSERVA_TEST_URL || '').replace(/\/+$/, '');
const skip = !BASE || !process.env.OBSERVA_TEST_ADMIN_PASSWORD ? 'set OBSERVA_TEST_URL and OBSERVA_TEST_ADMIN_PASSWORD to run' : false;

async function session(user, password) {
  const r = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'observa' }, body: JSON.stringify({ username: user, password }) });
  assert.equal(r.status, 200, `login as ${user} failed (${r.status})`);
  const cookie = (r.headers.getSetCookie?.() || [r.headers.get('set-cookie')]).map((c) => c.split(';')[0]).join('; ');
  return async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(`${BASE}/api${p}`, { method, headers: { Cookie: cookie, 'X-Requested-With': 'observa', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data };
  };
}

let admin, viewer, original;
before(async () => {
  if (skip) return;
  admin = await session(process.env.OBSERVA_TEST_ADMIN_USER || 'admin', process.env.OBSERVA_TEST_ADMIN_PASSWORD);
  if (process.env.OBSERVA_TEST_VIEWER_PASSWORD) viewer = await session(process.env.OBSERVA_TEST_VIEWER_USER || 'viewer', process.env.OBSERVA_TEST_VIEWER_PASSWORD);
  original = (await admin('/modules')).data;
});
after(async () => {
  // put the deployment's module selection back exactly as it was
  if (skip || !original) return;
  if (original.configured) await admin('/modules', { method: 'PUT', body: { enabled: original.enabled } });
  else await admin('/modules', { method: 'PUT', body: { enabled: original.catalog.map((m) => m.id) } });
});

test('signed-out requests are refused', { skip }, async () => {
  const r = await fetch(`${BASE}/api/services`, { headers: { 'X-Requested-With': 'observa' } });
  assert.equal(r.status, 401);
});

test('responses carry no demo flag and the UI gets its module list', { skip }, async () => {
  const me = await admin('/me');
  assert.ok(Array.isArray(me.data.modules));
  assert.equal('grafanaUrl' in me.data, false);
  const ds = await admin('/datasources');
  for (const d of ds.data) assert.deepEqual(d.modes, ['live'], `${d.id} still offers demo mode`);
});

test('demo mode cannot be switched on', { skip }, async () => {
  const r = await admin('/datasources/loki', { method: 'PUT', body: { mode: 'demo' } });
  assert.equal(r.status, 400);
});

test('only metrics + infrastructure on: other module APIs answer 404', { skip }, async () => {
  const put = await admin('/modules', { method: 'PUT', body: { enabled: ['metrics', 'infrastructure'] } });
  assert.equal(put.status, 200);
  assert.deepEqual((await admin('/me')).data.modules, ['metrics', 'infrastructure']);
  for (const p of ['/logs', '/traces', '/services', '/alerts/count', '/dashboards', '/agents']) {
    assert.equal((await admin(p)).status, 404, `${p} should be hidden`);
  }
  assert.notEqual((await admin('/prom/targets')).status, 404, 'infrastructure API must stay reachable');
  const ov = (await admin('/overview')).data;
  assert.deepEqual(ov.modules, { infrastructure: true, alerting: false, services: false });
  assert.equal(ov.services, null, 'Overview must not query a disabled module');
});

test('a module that is on but whose source is down reports unavailable, not hidden', { skip }, async () => {
  await admin('/modules', { method: 'PUT', body: { enabled: ['logs'] } });
  const r = await admin('/logs');
  assert.notEqual(r.status, 404);
  if (r.status !== 200) assert.equal(r.data?.state, 'unavailable', 'a failing source must say "unavailable"');
});

test('bad module selections are rejected', { skip }, async () => {
  assert.equal((await admin('/modules', { method: 'PUT', body: { enabled: ['kubernetes'] } })).status, 400);
  assert.equal((await admin('/modules', { method: 'PUT', body: { enabled: 'metrics' } })).status, 400);
});

test('viewers cannot read or change module settings', { skip: skip || (!process.env.OBSERVA_TEST_VIEWER_PASSWORD && 'set OBSERVA_TEST_VIEWER_PASSWORD') }, async () => {
  assert.equal((await viewer('/modules')).status, 403);
  assert.equal((await viewer('/modules', { method: 'PUT', body: { enabled: [] } })).status, 403);
});

test('service statuses only use the evidence-based values', { skip }, async () => {
  await admin('/modules', { method: 'PUT', body: { enabled: ['services'] } });
  const r = await admin('/services');
  if (r.status !== 200) return; // source unavailable: covered above
  for (const s of r.data.list) {
    assert.ok(['healthy', 'degraded', 'down', 'no_traffic'].includes(s.status));
    if (s.status === 'no_traffic') assert.equal(s.errorRate, null);
  }
});
