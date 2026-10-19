// Metric definitions used by the UI (web/src/lib/catalog.ts): every screen reads CPU, memory, disk and network
// through these, so they must follow the same rules as the server (src/queries.js).
// Regression for the audit of 2026-10-19: "100 - rate(idle)" read 20-83 points too high after any gap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, cpuPerHost, procCpuShare, matchers } from '../web/src/lib/catalog.ts';

const q = (metric, extra = {}) => buildQuery({ metric, filters: {}, ...extra });

test('CPU = 1 - idle / total (never "100 - rate(idle)")', () => {
  const e = q('cpu');
  assert.doesNotMatch(e, /100 - (avg by \([^)]*\) \()?rate\(node_cpu_seconds_total\{mode="idle"/);
  assert.match(e, /1 - sum by \(host, env, role\) \(rate\(node_cpu_seconds_total\{mode="idle", agent_id=""\}\[5m\]\)\) \/ sum by \(host, env, role\) \(rate\(node_cpu_seconds_total\{agent_id=""\}\[5m\]\)\)/);
  assert.match(e, /1 - sum by \(host, env, role\) \(rate\(windows_cpu_time_total\{mode="idle", core!=""\}\[5m\]\)\) \/ sum by \(host, env, role\) \(rate\(windows_cpu_time_total\{core!=""\}\[5m\]\)\)/);
});

test('the Go agent\'s own CPU value is used, from the last 120 s only', () => {
  assert.match(q('cpu'), /last_over_time\(observaone_cpu_utilization_ratio\{\}\[120s\]\)/);
});

test('pushed series without fresh samples give no value (no stale value repeated)', () => {
  for (const m of ['cpu', 'memory', 'disk', 'network']) {
    const e = q(m);
    assert.ok(/\[120s\]\)/.test(e) || /> time\(\) - 120\)/.test(e), `${m} has no freshness rule`);
  }
});

test('disk = the fullest filesystem of each server, then combined', () => {
  const e = q('disk');
  assert.match(e, /^avg by \(host\) \(max by \(host, env, role\) \(100 - 100 \* last_over_time\(node_filesystem_avail_bytes/);
});

test('Linux and Windows servers are combined together (one aggregation over both)', () => {
  for (const m of ['cpu', 'memory', 'disk', 'network']) {
    const e = buildQuery({ metric: m, filters: {}, by: 'env', fn: 'avg' });
    assert.ok(e.startsWith('avg by (env) ('), `${m}: ${e.slice(0, 40)}`);
    const inner = e.slice('avg by (env) ('.length, -1);
    assert.ok(inner.includes('node_') && inner.includes('windows_'), `${m} should combine both platforms inside one avg`);
    assert.ok(!/\) or avg by \(env\)/.test(e), `${m} combines each platform separately`);
  }
});

test('platform and host filters reach every selector', () => {
  const lin = buildQuery({ metric: 'cpu', filters: { platform: 'linux', host: 'web-1', env: 'prod' } });
  assert.ok(!lin.includes('windows_'));
  for (const sel of lin.match(/(node_cpu_seconds_total|observaone_cpu_utilization_ratio)\{[^}]*\}/g)) assert.match(sel, /env="prod", host="web-1"/);
  const win = cpuPerHost(matchers({ platform: 'windows' }));
  assert.ok(!win.includes('node_') && !win.includes('observaone_'));
});

test('process CPU is a share of the whole server (cores used / cores of the server)', () => {
  const e = q('processes_cpu');
  assert.match(e, /100 \* sum by \(groupname, host\) \(rate\(namedprocess_namegroup_cpu_seconds_total\{\}\[5m\]\)\) \/ on \(host\) group_left count by \(host\) \(node_cpu_seconds_total\{mode="idle"\}\)/);
  assert.match(procCpuShare('c', 'process', '{}', '{mode="idle"}', 'w'), /\/ on \(host\) group_left count by \(host\)/);
});
