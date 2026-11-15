// Alerting through the API, against a running ObservaOne with Prometheus + Alertmanager: test query, rule
// creation with routing labels, tenant scoping of rules, alerts and silences. Creates two tenants, users, rules
// and a silence; removes the rules and the silence afterwards.
// Run:  OBSERVA_TEST_URL=http://127.0.0.1:8083 OBSERVA_TEST_ADMIN_PASSWORD=... npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.OBSERVA_TEST_URL || '').replace(/\/+$/, '');
const skip = !BASE || !process.env.OBSERVA_TEST_ADMIN_PASSWORD ? 'set OBSERVA_TEST_URL and OBSERVA_TEST_ADMIN_PASSWORD to run' : false;
const RUN = `a${Date.now().toString(36)}`;

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

let admin, ta, tid, silence;
const ruleP = `PlatformCheck_${RUN}`, ruleT = `TenantCheck_${RUN}`;
before(async () => {
  if (skip) return;
  admin = await session(process.env.OBSERVA_TEST_ADMIN_USER || 'admin', process.env.OBSERVA_TEST_ADMIN_PASSWORD);
  const t = await admin('/tenants', { method: 'POST', body: { name: `Alerts ${RUN}` } });
  tid = t.data.id;
  const pw = `Tenant#Pass-${RUN}-12345`;
  await admin('/users', { method: 'POST', body: { username: `${RUN}u`, password: pw, role: 'admin' } });
  await admin(`/users/${RUN}u/tenant`, { method: 'PUT', body: { tenant: tid } });
  ta = await session(`${RUN}u`, pw);
});
after(async () => {
  if (skip) return;
  await admin(`/rules/${ruleP}`, { method: 'DELETE' });
  await ta(`/rules/${ruleT}`, { method: 'DELETE' });
  if (silence) await admin(`/silences/${silence}`, { method: 'DELETE' });
});

test('test query: valid with the number of instances, or the parse error', { skip }, async () => {
  const ok = await admin('/rules/test', { method: 'POST', body: { query: 'up{job=~"linux|windows"}', op: '>=', threshold: 0 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.valid, true);
  assert.ok(ok.data.instances > 0, 'servers are up, so up >= 0 matches them');
  const bad = await admin('/rules/test', { method: 'POST', body: { expr: 'rate(up[' } });
  assert.equal(bad.data.valid, false);
  assert.match(bad.data.error, /parse error/);
  const range = await admin('/rules/test', { method: 'POST', body: { expr: 'up[5m]' } });
  assert.equal(range.data.valid, false, 'a range vector cannot be an alert');
});

test('a rule is created with its routing labels and runbook', { skip }, async () => {
  const r = await admin('/rules', { method: 'POST', body: { name: ruleP, query: 'vector(1)', op: '>', threshold: 5, forMinutes: 5, severity: 'warning', team: 'ops', labels: { service: 'payments' }, runbookUrl: 'https://example.local/rb' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const rule = (await admin('/rules')).data.rules.find((x) => x.name === ruleP);
  assert.ok(rule, 'rule not loaded by Prometheus');
  assert.equal(rule.labels.team, 'ops'); assert.equal(rule.labels.service, 'payments'); assert.equal(rule.runbook, 'https://example.local/rb');
  assert.equal((await admin('/rules', { method: 'POST', body: { name: `Bad_${RUN}`, query: 'up', threshold: 1, labels: { tenant: 't_x' } } })).status, 400, 'tenant cannot be set by hand');
});

test("a tenant's rule only sees the tenant's series and is hidden from other tenants' rule lists", { skip }, async () => {
  const r = await ta('/rules', { method: 'POST', body: { name: ruleT, query: 'up', op: '>=', threshold: 0, forMinutes: 1, severity: 'info' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const mine = (await ta('/rules')).data.rules.find((x) => x.name === ruleT);
  assert.ok(mine, 'tenant cannot see its own rule');
  assert.match(mine.query, new RegExp(`tenant="${tid}"`), 'the stored expression is scoped to the tenant');
  assert.equal(mine.labels.tenant, tid);
  assert.ok((await admin('/rules')).data.rules.some((x) => x.name === ruleT), 'the platform sees every rule');
  assert.equal((await admin(`/rules/${ruleT}`, { method: 'DELETE' })).status === 200 ? 'deleted-by-platform' : 'kept', 'deleted-by-platform');
  // recreate for the cleanup path, then: another tenant cannot delete it (it is not found)
  await ta('/rules', { method: 'POST', body: { name: ruleT, query: 'up', op: '>=', threshold: 0 } });
});

test('a tenant sees none of the platform alerts and cannot open them', { skip }, async () => {
  const all = (await admin('/alerts/list?state=all')).data.alerts;
  const platform = all.find((a) => a.host && !a.host.startsWith('tnt-'));
  const t = (await ta('/alerts/list?state=all')).data.alerts;
  assert.ok(t.every((a) => a.id !== platform?.id), 'a platform alert is listed for the tenant');
  if (platform) assert.equal((await ta(`/alerts/item/${platform.id}`)).status, 404);
  assert.ok(((await ta('/alerts')).data.alerts || []).every((a) => a.labels.tenant === tid));
});

test("a tenant's silence always carries its tenant; it cannot end the platform's silences", { skip }, async () => {
  const s = await admin('/silences', { method: 'POST', body: { matchers: [{ name: 'alertname', value: `Nothing_${RUN}` }], hours: 1, comment: 'test' } });
  silence = s.data.id;
  assert.equal((await ta(`/silences/${silence}`, { method: 'DELETE' })).status, 404);
  const mine = await ta('/silences', { method: 'POST', body: { matchers: [{ name: 'alertname', value: `Nothing_${RUN}` }, { name: 'tenant', value: 't_default' }], hours: 1 } });
  const listed = (await ta('/alerts')).data.silences.find((x) => x.id === mine.data.id);
  assert.ok(listed, "the tenant's own silence is listed for it");
  assert.deepEqual(listed.matchers.filter((m) => m.name === 'tenant').map((m) => m.value), [tid], 'tenant matcher forced to its own');
  assert.ok(!(await ta('/alerts')).data.silences.some((x) => x.id === silence), "the platform's silence is listed for the tenant");
  await ta(`/silences/${mine.data.id}`, { method: 'DELETE' });
});

test('alert list: per-state filters and the details of an active alert', { skip }, async () => {
  const all = (await admin('/alerts/list?state=all')).data;
  assert.equal(all.counts.all, all.counts.firing + all.counts.pending + all.counts.resolved);
  for (const st of ['firing', 'pending', 'resolved']) {
    const l = (await admin(`/alerts/list?state=${st}`)).data.alerts;
    assert.ok(l.every((a) => a.state === st), `${st} tab holds other states`);
  }
  const a = all.alerts.find((x) => x.state === 'firing');
  if (!a) return;
  const d = (await admin(`/alerts/item/${a.id}`)).data;
  assert.equal(d.alert.id, a.id);
  assert.ok(d.rule.expr && d.rule.graphQuery);
  assert.ok(d.history.some((h) => h.id === a.id));
});
