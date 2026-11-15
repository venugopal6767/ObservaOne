// Access to metrics data across tenants, against a running ObservaOne (creates two tenants, two users and a few
// dashboards; dashboards are deleted afterwards).
// Run:  OBSERVA_TEST_URL=http://127.0.0.1:8083 OBSERVA_TEST_ADMIN_PASSWORD=... npm test
// Without them these tests are skipped (reported as skipped, never as passed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.OBSERVA_TEST_URL || '').replace(/\/+$/, '');
const skip = !BASE || !process.env.OBSERVA_TEST_ADMIN_PASSWORD ? 'set OBSERVA_TEST_URL and OBSERVA_TEST_ADMIN_PASSWORD to run' : false;
const RUN = `m${Date.now().toString(36)}`;

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

let admin, ta, tb, dashA, dashB, dashP;
before(async () => {
  if (skip) return;
  admin = await session(process.env.OBSERVA_TEST_ADMIN_USER || 'admin', process.env.OBSERVA_TEST_ADMIN_PASSWORD);
  const users = [];
  for (const k of ['a', 'b']) {
    const t = await admin('/tenants', { method: 'POST', body: { name: `Metrics ${k} ${RUN}` } });
    assert.equal(t.status, 201, JSON.stringify(t.data));
    const pw = `Tenant#Pass-${RUN}-${k}-12345`;
    assert.ok([200, 201].includes((await admin('/users', { method: 'POST', body: { username: `${RUN}${k}`, password: pw, role: 'admin' } })).status));
    assert.equal((await admin(`/users/${RUN}${k}/tenant`, { method: 'PUT', body: { tenant: t.data.id } })).status, 200);
    users.push(await session(`${RUN}${k}`, pw));
  }
  [ta, tb] = users;
  dashA = (await ta('/dashboards', { method: 'POST', body: { title: `A ${RUN}` } })).data.id;
  dashB = (await tb('/dashboards', { method: 'POST', body: { title: `B ${RUN}` } })).data.id;
  dashP = (await admin('/dashboards', { method: 'POST', body: { title: `Platform ${RUN}` } })).data.id;
});
after(async () => {
  if (skip) return;
  for (const id of [dashA, dashB, dashP]) if (id) await admin(`/dashboards/${id}`, { method: 'DELETE' });
});

test('a tenant lists only its own custom dashboards (plus the system ones)', { skip }, async () => {
  const ids = (await ta('/dashboards')).data.map((d) => d.id);
  assert.ok(ids.includes(dashA));
  assert.ok(!ids.includes(dashB), "another tenant's dashboard is listed");
  assert.ok(!ids.includes(dashP), "the platform's dashboard is listed");
});

test("another tenant's dashboard answers 404 to read, change and delete", { skip }, async () => {
  assert.equal((await ta(`/dashboards/${dashB}`)).status, 404);
  assert.equal((await ta(`/dashboards/${dashB}/panels`, { method: 'POST', body: { title: 'x', query: 'up' } })).status, 404);
  assert.equal((await ta(`/dashboards/${dashB}/panels/0`, { method: 'DELETE' })).status, 404);
  assert.equal((await ta(`/dashboards/${dashB}`, { method: 'DELETE' })).status, 404);
  assert.equal((await tb(`/dashboards/${dashB}`)).status, 200, 'the owner must still see it');
});

test('the platform (default tenant) sees and manages every dashboard', { skip }, async () => {
  const ids = (await admin('/dashboards')).data.map((d) => d.id);
  for (const id of [dashA, dashB, dashP]) assert.ok(ids.includes(id));
  assert.equal((await admin(`/dashboards/${dashA}/panels`, { method: 'POST', body: { title: 'p', query: 'up' } })).status, 200);
});

test('metric names are per tenant (a cached answer is never shared)', { skip }, async () => {
  const all = (await admin('/prom/metric-names')).data;
  const mine = (await ta('/prom/metric-names')).data;
  assert.ok(all.length > 0);
  assert.ok(mine.length < all.length, `tenant sees ${mine.length} of ${all.length} names`);
  const again = (await admin('/prom/metric-names')).data; // after the tenant filled its own cache
  assert.equal(again.length, all.length);
});

test('PromQL, label values and targets are scoped for a tenant', { skip }, async () => {
  const r = await ta('/prom/query?query=' + encodeURIComponent('count(up)'));
  assert.equal(r.status, 200);
  assert.ok(!r.data.result.length || Number(r.data.result[0].value[1]) < Number((await admin('/prom/query?query=' + encodeURIComponent('count(up)'))).data.result[0].value[1]));
  const x = await ta('/prom/query?query=' + encodeURIComponent('up{tenant="t_default"}'));
  assert.equal(x.data.result.length, 0, "asking for another tenant's series explicitly returns nothing");
  assert.equal((await ta('/prom/label-values?label=host')).data.length, 0);
  const t = (await ta('/prom/targets')).data;
  assert.equal(t.filter((s) => s.source === 'scrape').length, 0, "the platform's scraped servers are listed for a tenant");
});

test('signed-out and viewer access', { skip }, async () => {
  const r = await fetch(`${BASE}/api/prom/query?query=up`, { headers: { 'X-Requested-With': 'observa' } });
  assert.equal(r.status, 401);
});
