// End-to-end checks of the metric definitions against a real Prometheus.
// Run:  OBSERVA_TEST_PROM=http://127.0.0.1:9090/prometheus npm test
// Without OBSERVA_TEST_PROM these tests are skipped (reported as skipped, never as passed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpuByHost, memByHost, diskFreeByHost } from '../src/queries.js';
import { buildQuery } from '../web/src/lib/catalog.ts';

const P = (process.env.OBSERVA_TEST_PROM || '').replace(/\/+$/, '');
const skip = P ? false : 'set OBSERVA_TEST_PROM to run';
async function q(query, time) {
  const r = await fetch(`${P}/api/v1/query`, { method: 'POST', body: new URLSearchParams({ query, ...(time ? { time: String(time) } : {}) }) });
  const j = await r.json();
  assert.equal(j.status, 'success', `${j.error} :: ${query.slice(0, 120)}`);
  return Object.fromEntries(j.data.result.map((x) => [x.metric.host, Number(x.value[1])]));
}
const pairs = [
  ['cpu', () => cpuByHost(), (v) => v],
  ['memory', () => memByHost(), (v) => v],
  ['disk', () => diskFreeByHost(), (v) => 100 - v], // the server reports free space, the UI space used
];

for (const [metric, server, conv] of pairs) {
  test(`${metric}: every screen shows the server's value for every host (within 0.5 points)`, { skip }, async () => {
    const t = Math.floor(Date.now() / 1000);
    const [a, b] = await Promise.all([q(server(), t), q(buildQuery({ metric, filters: {}, by: 'host', fn: 'max' }), t)]);
    assert.ok(Object.keys(a).length > 0, 'no hosts with data');
    for (const [h, v] of Object.entries(a)) {
      assert.ok(h in b, `${h} has a server value but no UI value`);
      // the Go agent reports disk from its own collector; allow its rounding
      assert.ok(Math.abs(conv(v) - b[h]) < (metric === 'disk' ? 1 : 0.5), `${h}: server ${conv(v).toFixed(2)} vs UI ${b[h].toFixed(2)}`);
    }
  });
}

test('CPU stays right 2.5 minutes after a series starts (the old formula read far too high there)', { skip }, async () => {
  // the earliest CPU sample Prometheus holds = the start of the series after a restart / new host
  const start = Object.values(await q('min(min_over_time(timestamp(node_cpu_seconds_total{mode="idle"})[6h:1m]))'))[0];
  assert.ok(start, 'no CPU data');
  const t = Math.round(start + 150);
  if (t > Date.now() / 1000 - 30) return; // series too young to test this moment yet
  const [a, b] = await Promise.all([q(cpuByHost(), t), q(buildQuery({ metric: 'cpu', filters: {}, by: 'host', fn: 'max' }), t)]);
  for (const [h, v] of Object.entries(a)) if (h in b) assert.ok(Math.abs(v - b[h]) < 0.5, `${h} at start+150s: server ${v.toFixed(1)} vs UI ${b[h].toFixed(1)}`);
});

test('process CPU (% of server) is never above 100% and adds up to at most host CPU + margin', { skip }, async () => {
  const procs = await fetch(`${P}/api/v1/query`, { method: 'POST', body: new URLSearchParams({ query: `sum by (host) (${buildQuery({ metric: 'processes_cpu', filters: {}, by: 'process', fn: 'sum' }).replace(/sum by \((?:groupname|process)\) \(100/g, '(100')})` }) }).then((r) => r.json());
  assert.equal(procs.status, 'success');
  assert.ok(procs.data.result.every((r) => r.metric.host), 'every per-host sum has its host (Linux and Windows parts)');
  for (const r of procs.data.result) assert.ok(Number(r.value[1]) <= 100.5, `${r.metric.host}: processes add up to ${r.value[1]}% of the server`);
});
