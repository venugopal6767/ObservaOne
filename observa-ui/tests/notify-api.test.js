// Notification channels through the API, against a running ObservaOne that manages Alertmanager's config
// (AM_CONFIG_FILE set). Needs a receiver for the test send: OBSERVA_TEST_WEBHOOK=http://.../path (answers 200;
// a path starting with /missing answers 404). Creates channels and removes them afterwards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.OBSERVA_TEST_URL || '').replace(/\/+$/, '');
const HOOK = process.env.OBSERVA_TEST_WEBHOOK || '';
const skip = !BASE || !process.env.OBSERVA_TEST_ADMIN_PASSWORD || !HOOK ? 'set OBSERVA_TEST_URL, OBSERVA_TEST_ADMIN_PASSWORD and OBSERVA_TEST_WEBHOOK to run' : false;
const RUN = `n${Date.now().toString(36)}`;

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

let admin, ta, tid; const ids = [];
before(async () => {
  if (skip) return;
  admin = await session(process.env.OBSERVA_TEST_ADMIN_USER || 'admin', process.env.OBSERVA_TEST_ADMIN_PASSWORD);
  const t = await admin('/tenants', { method: 'POST', body: { name: `Notify ${RUN}` } });
  tid = t.data.id;
  const pw = `Tenant#Pass-${RUN}-12345`;
  await admin('/users', { method: 'POST', body: { username: `${RUN}u`, password: pw, role: 'admin' } });
  await admin(`/users/${RUN}u/tenant`, { method: 'PUT', body: { tenant: tid } });
  ta = await session(`${RUN}u`, pw);
});
after(async () => { if (!skip) for (const id of ids) await admin(`/notifications/channels/${id}`, { method: 'DELETE' }); });

test('a channel for a new team: stored, routed, secrets never returned, test send delivered', { skip }, async () => {
  const r = await admin('/notifications/channels', { method: 'POST', body: { name: `Hook ${RUN}`, type: 'webhook', team: `t-${RUN}`, url: `${HOOK}?k=SECRET1`, token: 'TOKEN1' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  ids.push(r.data.channel.id);
  assert.equal(r.data.apply.ok, true, r.data.apply.error);
  const list = await admin('/notifications');
  assert.ok(!JSON.stringify(list.data).includes('SECRET1') && !JSON.stringify(list.data).includes('TOKEN1'), 'secrets must not be returned');
  assert.ok(list.data.routes.some((x) => x.matchers.includes(`team="t-${RUN}"`) && x.team === `t-${RUN}`), 'Alertmanager runs the new route');
  assert.ok((await admin('/notifications/teams')).data.includes(`t-${RUN}`));
  const t = await admin(`/notifications/channels/${r.data.channel.id}/test`, { method: 'POST' });
  assert.equal(t.data.ok, true, t.data.error);
  const dup = await admin('/notifications/channels', { method: 'POST', body: { name: `hook ${RUN}`, type: 'webhook', team: 'ops', url: HOOK } });
  assert.equal(dup.status, 409, 'names are unique (any case)');
});

test('a failing channel reports why', { skip }, async () => {
  const u = new URL(HOOK); u.pathname = '/missing';
  const r = await admin('/notifications/channels', { method: 'POST', body: { name: `Bad ${RUN}`, type: 'webhook', team: 'ops', url: u.toString() } });
  ids.push(r.data.channel.id);
  const t = await admin(`/notifications/channels/${r.data.channel.id}/test`, { method: 'POST' });
  assert.equal(t.data.ok, false);
  assert.match(t.data.error, /HTTP 404/);
  const row = (await admin('/notifications')).data.channels.find((c) => c.id === r.data.channel.id);
  assert.equal(row.lastTest.ok, false);
});

test('tenant users cannot see or change channels', { skip }, async () => {
  const l = await ta('/notifications');
  assert.equal(l.status, 200);
  assert.equal(l.data.channels.length, 0);
  assert.equal(l.data.editable, false);
  assert.equal((await ta('/notifications/channels', { method: 'POST', body: { name: 'x', type: 'webhook', team: 'ops', url: HOOK } })).status, 403);
  assert.equal((await ta(`/notifications/channels/${ids[0]}/test`, { method: 'POST' })).status, 403);
  assert.equal((await ta(`/notifications/channels/${ids[0]}`, { method: 'DELETE' })).status, 403);
});
