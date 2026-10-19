// Tenant scoping of PromQL (src/tenancy.js): every vector selector must carry tenant="<id>", whatever the query.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopePromQL, scopeMatchers, tenantFilter, tenantStore, currentTenant } from '../src/tenancy.js';

const T = 't_acme';
const s = (q) => scopePromQL(q, T);

test('every selector gets the tenant matcher', () => {
  const cases = {
    up: 'up{tenant="t_acme"}',
    'rate(node_cpu_seconds_total{mode="idle"}[5m])': 'rate(node_cpu_seconds_total{tenant="t_acme",mode="idle"}[5m])',
    '{__name__=~"node_.*"}': '{tenant="t_acme",__name__=~"node_.*"}',
    'sum by (host) (rate(x[5m])) / on(host) group_left(env) y': 'sum by (host) (rate(x{tenant="t_acme"}[5m])) / on(host) group_left(env) y{tenant="t_acme"}',
    'sum(x) by (a)': 'sum(x{tenant="t_acme"}) by (a)',
    'count without (cpu) (x)': 'count without (cpu) (x{tenant="t_acme"})',
    'x offset 1h > bool 1e3': 'x{tenant="t_acme"} offset 1h > bool 1e3',
    'label_replace(up, "dst", "$1", "src", "(.*)")': 'label_replace(up{tenant="t_acme"}, "dst", "$1", "src", "(.*)")',
    'max_over_time(timestamp(up{agent="o"})[1h:15s])': 'max_over_time(timestamp(up{tenant="t_acme",agent="o"})[1h:15s])',
    'x and on() vector(1)': 'x{tenant="t_acme"} and on() vector(1)',
    'histogram_quantile(0.95, sum by (le) (rate(h_bucket[5m])))': 'histogram_quantile(0.95, sum by (le) (rate(h_bucket{tenant="t_acme"}[5m])))',
    'x > Inf or y < NaN': 'x{tenant="t_acme"} > Inf or y{tenant="t_acme"} < NaN',
    'x{a="}{weird"}': 'x{tenant="t_acme",a="}{weird"}',
  };
  for (const [q, want] of Object.entries(cases)) assert.equal(s(q), want, q);
});

test('a user cannot escape the scope', () => {
  // asking for another tenant explicitly: both matchers apply -> nothing from the other tenant
  assert.equal(s('up{tenant="t_other"}'), 'up{tenant="t_acme",tenant="t_other"}');
  assert.throws(() => s('up{a="b"'), /unbalanced/);
  assert.throws(() => s('up{a="b}'), /unterminated|unbalanced/);
  assert.throws(() => scopePromQL('up', 't_"x'), /bad tenant/);
});

test('label value lookups are scoped too', () => {
  assert.deepEqual(scopeMatchers(undefined, T), ['{tenant="t_acme"}']);
  assert.deepEqual(scopeMatchers(['up{job="linux"}'], T), ['up{tenant="t_acme",job="linux"}']);
});

test('the request tenant scopes SQL only for non-default tenants', async () => {
  assert.equal(currentTenant(), 't_default');
  const p = [];
  assert.equal(tenantFilter('a.tenant_id', p), '');
  await tenantStore.run({ tenant: T }, async () => {
    await Promise.resolve();
    const q = ['x'];
    assert.equal(tenantFilter('a.tenant_id', q), ' AND a.tenant_id = $2');
    assert.deepEqual(q, ['x', T]);
  });
});
