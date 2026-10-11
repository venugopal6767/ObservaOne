// The metric list on the Metrics page (public/js/pages/metrics-catalog.js). Every query was run against
// Prometheus 3.5 with the Go agent, the previous Windows/Docker/Kubernetes/Linux pipelines and a scraped server;
// these tests keep the list complete and the filters correctly applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, GROUPS, rawQuery, unitFor, INTERNAL } from '../public/js/pages/metrics-catalog.js';

const UNITS = new Set(['none', 'percent', 'bytes', 'Bps', 'bps', 's', 'iops']);
const noFilter = (n, b = '') => (b ? `${n}{${b}}` : n);
const withFilter = (n, b = '') => `${n}{${[b, 'host="web-1"'].filter(Boolean).join(',')}}`;

test('every metric has a name, a description, a unit, a group and a "worse" direction', () => {
  const ids = new Set();
  for (const m of CATALOG) {
    assert.ok(!ids.has(m.id), `duplicate id ${m.id}`); ids.add(m.id);
    assert.ok(m.label && m.desc && m.desc.length > 20, `${m.id}: label and a useful description`);
    assert.ok(UNITS.has(m.unit), `${m.id}: known unit`);
    assert.ok(['high', 'low'].includes(m.worse), `${m.id}: worse is high or low`);
    assert.ok(GROUPS.some(([g]) => g === m.group), `${m.id}: known group`);
  }
});

test('filters reach every metric name in every query', () => {
  for (const m of CATALOG) {
    const q = m.q(withFilter);
    const names = [...q.matchAll(/\b([a-z_][a-z0-9_]*)\{/gi)].map((x) => x[1]).filter((n) => !['by', 'on'].includes(n));
    assert.ok(names.length, `${m.id}: has metric selectors`);
    for (const n of names) {
      const sel = new RegExp(`${n}\\{[^}]*host="web-1"`);
      assert.match(q, sel, `${m.id}: ${n} is filtered`);
    }
    assert.ok(!m.q(noFilter).includes('{}'), `${m.id}: no empty selectors`);
  }
});

test('common metrics cover the Go agent, Windows and node_exporter data', () => {
  for (const id of ['cpu', 'memory', 'disk_free', 'disk_read', 'net_in', 'uptime']) {
    const q = CATALOG.find((m) => m.id === id).q(noFilter);
    assert.match(q, /observaone_/, `${id}: Go agent`);
    assert.match(q, /windows_/, `${id}: Windows`);
    assert.match(q, /node_[a-z_]+\{[^}]*agent_id=""/i, `${id}: node_exporter data without the Go agent's copy`);
  }
});

test('raw metrics: counters per second, gauges as they are', () => {
  assert.equal(rawQuery('node_load5', 'gauge', noFilter), 'max by (host) (node_load5)');
  assert.equal(rawQuery('node_network_receive_bytes_total', 'counter', noFilter), 'sum by (host) (rate(node_network_receive_bytes_total[5m]))');
  assert.equal(unitFor('node_network_receive_bytes_total', 'counter'), 'Bps');
  assert.equal(unitFor('node_memory_MemTotal_bytes', 'gauge'), 'bytes');
  assert.ok(INTERNAL.test('prometheus_tsdb_head_series') && INTERNAL.test('otelcol_process_memory_rss') && !INTERNAL.test('node_load1'));
});
