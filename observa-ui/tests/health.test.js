// Unit tests for the health rules (src/health.js). No database or network needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyService, summarizeServices, agentHostHealth } from '../src/health.js';

const T = { degradedErrorRate: 1, downErrorRate: 10, degradedP95Ms: 1000, downP95Ms: 5000 };

test('a service with zero requests is "no_traffic", not down, with no error rate or latency', () => {
  const s = classifyService({ name: 'batch', rps: 0, errorRate: 100, p95: 9000 }, T);
  assert.equal(s.status, 'no_traffic');
  assert.equal(s.errorRate, null);
  assert.equal(s.p95, null);
});

test('a service with no reported request rate is also "no_traffic" (rps shown as 0, not invented)', () => {
  const s = classifyService({ name: 'x', rps: null, errorRate: null, p95: null }, T);
  assert.equal(s.status, 'no_traffic');
  assert.equal(s.rps, 0);
});

test('thresholds: healthy, degraded and down need evidence', () => {
  assert.equal(classifyService({ rps: 5, errorRate: 0.2, p95: 100 }, T).status, 'healthy');
  assert.equal(classifyService({ rps: 5, errorRate: 2, p95: 100 }, T).status, 'degraded');
  assert.equal(classifyService({ rps: 5, errorRate: 0, p95: 1500 }, T).status, 'degraded');
  assert.equal(classifyService({ rps: 5, errorRate: 12, p95: 100 }, T).status, 'down');
  assert.equal(classifyService({ rps: 5, errorRate: 0, p95: 6000 }, T).status, 'down');
});

test('missing error rate or latency is not treated as 0 or as bad', () => {
  const s = classifyService({ rps: 5, errorRate: null, p95: null }, T);
  assert.equal(s.status, 'healthy');
  assert.equal(s.errorRate, null);
});

test('summary: no traffic at all gives error rate null, never 0%', () => {
  const list = [classifyService({ rps: 0 }, T), classifyService({ rps: null }, T)];
  const sum = summarizeServices(list);
  assert.equal(sum.errorRate, null);
  assert.equal(sum.noTraffic, 2);
  assert.equal(sum.totalRps, 0);
});

test('summary: error rate is weighted by traffic', () => {
  const sum = summarizeServices([
    classifyService({ rps: 90, errorRate: 0, p95: 10 }, T),
    classifyService({ rps: 10, errorRate: 10, p95: 10 }, T),
  ]);
  assert.equal(sum.errorRate, 1);
  assert.deepEqual([sum.healthy, sum.down], [1, 1]);
});

test('agent host: silent agent is "not_reporting", never "down"', () => {
  const r = agentHostHealth({ nowSec: 10_000, lastSeenSec: 10_000 - 3600, upValue: true, onlineSeconds: 150 });
  assert.equal(r.health, 'not_reporting');
});

test('agent host: never seen is "not_reporting"', () => {
  assert.equal(agentHostHealth({ nowSec: 10_000, lastSeenSec: 0, upValue: false, onlineSeconds: 150 }).health, 'not_reporting');
});

test('agent host: "down" only when the agent reports its exporter down', () => {
  assert.equal(agentHostHealth({ nowSec: 10_000, lastSeenSec: 9_990, upValue: false, onlineSeconds: 150 }).health, 'down');
  assert.equal(agentHostHealth({ nowSec: 10_000, lastSeenSec: 9_990, upValue: true, onlineSeconds: 150 }).health, 'up');
});
