// Guards for the shared server queries (src/queries.js). Checked end to end against Prometheus 3.5 with the
// Linux Go agent, the previous-generation Windows / Docker / Kubernetes / Linux 1.0 pipelines (otelcol 0.162)
// and a directly scraped node_exporter; these tests keep the rules from silently regressing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpuByHost, memByHost, diskFreeByHost, SERVERS_UP } from '../src/queries.js';

test('previous-generation agents are not filtered out (they carry agent="observaone")', () => {
  for (const q of [cpuByHost(), memByHost(), diskFreeByHost()]) {
    assert.ok(!q.includes('agent!="observaone"'), 'must not exclude previous-generation agents');
    assert.ok(q.includes('agent_id=""'), 'node_exporter data from the Go agent is excluded by agent_id instead');
  }
});

test('CPU is idle time divided by total time (right from the second sample)', () => {
  const q = cpuByHost();
  assert.match(q, /1 - sum by \(host\) \(rate\(windows_cpu_time_total\{mode="idle"/);
  assert.match(q, /\/ sum by \(host\) \(rate\(windows_cpu_time_total\{core!=""\}/);
  assert.match(q, /\/ sum by \(host\) \(rate\(node_cpu_seconds_total\{agent_id=""\}/);
});

test('every value needs fresh data, so a stopped agent shows no value', () => {
  for (const q of [cpuByHost(), memByHost(), diskFreeByHost()]) {
    assert.match(q, /last_over_time\(observaone_[a-z_]+(\{[^}]*\})?\[120s\]\)/);
    assert.match(q, /timestamp\(windows_[a-z_]+/);
    assert.match(q, /timestamp\(node_[a-zA-Z_]+/);
  }
});

test('offset queries move the freshness window with them', () => {
  assert.match(cpuByHost('1h'), /> time\(\) - 3720\)/);
  assert.match(memByHost('1h'), /offset 1h/);
});

test('servers up counts agents by recent data and scraped servers by up', () => {
  assert.match(SERVERS_UP, /last_over_time\(up\{agent="observaone",job=~"windows\|linux"\}\[120s\]\)/);
  assert.match(SERVERS_UP, /up\{job=~"windows\|linux",agent!="observaone"\}/);
});
