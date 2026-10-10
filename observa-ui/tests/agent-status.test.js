// Unit tests for the ObservaOne Agent status rules (src/health.js). No database or network needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentStatus, agentProblems, compareVersions, counterDelta } from '../src/health.js';

const NOW = 1_800_000_000_000;
const T = { onlineSeconds: 150, offlineSeconds: 900 };
const at = (secAgo) => NOW - secAgo * 1000;

test('enrolled but no heartbeat yet = pending (never online, never offline)', () => {
  assert.equal(agentStatus({ nowMs: NOW, ...T }).status, 'pending');
});

test('recent heartbeat = online', () => {
  const s = agentStatus({ nowMs: NOW, lastHeartbeatMs: at(20), ...T });
  assert.equal(s.status, 'online');
  assert.equal(s.ageSeconds, 20);
});

test('one missed heartbeat does not change the state (threshold, not a single timeout)', () => {
  assert.equal(agentStatus({ nowMs: NOW, lastHeartbeatMs: at(65), ...T }).status, 'online');
  assert.equal(agentStatus({ nowMs: NOW, lastHeartbeatMs: at(150), ...T }).status, 'online');
});

test('stale heartbeat = not_reporting with the age; later = offline', () => {
  const s = agentStatus({ nowMs: NOW, lastHeartbeatMs: at(151), ...T });
  assert.equal(s.status, 'not_reporting');
  assert.match(s.reason, /may still be running/);
  assert.equal(agentStatus({ nowMs: NOW, lastHeartbeatMs: at(901), ...T }).status, 'offline');
});

test('a heartbeat time in the future (clock skew) counts as age 0, not negative', () => {
  const s = agentStatus({ nowMs: NOW, lastHeartbeatMs: NOW + 60_000, ...T });
  assert.equal(s.status, 'online');
  assert.equal(s.ageSeconds, 0);
});

test('online with a reported problem = attention; blocked wins over everything', () => {
  assert.equal(agentStatus({ nowMs: NOW, lastHeartbeatMs: at(5), problems: ['x'], ...T }).status, 'attention');
  assert.equal(agentStatus({ nowMs: NOW, lastHeartbeatMs: at(5), blocked: true, ...T }).status, 'blocked');
});

test('a stale agent with a problem is not_reporting (the problem may be old)', () => {
  assert.equal(agentStatus({ nowMs: NOW, lastHeartbeatMs: at(400), problems: ['x'], ...T }).status, 'not_reporting');
});

test('legacy agents without heartbeats are judged by their last data upload', () => {
  assert.equal(agentStatus({ nowMs: NOW, lastDataMs: at(30), ...T }).status, 'online');
  assert.match(agentStatus({ nowMs: NOW, lastDataMs: at(300), ...T }).reason, /No data/);
});

test('problems: unsupported version, stopped collectors, upload failures, agent error', () => {
  const p = agentProblems({
    version: '0.9.0', minVersion: '1.0.0', nowMs: NOW, lastHeartbeatMs: at(5), lastDataMs: at(5), onlineSeconds: 150,
    diag: { collectors: { forwarder: 'stopped', exporter: 'running' }, uploadFailures: 12, lastError: 'disk full' },
  });
  assert.equal(p.length, 4);
  assert.match(p.join(' '), /no longer supported/);
  assert.match(p.join(' '), /forwarder \(otelcol\) is stopped/);
  assert.match(p.join(' '), /12 metric points failed/);
  assert.match(p.join(' '), /disk full/);
});

test('problems: healthy agent has none', () => {
  const p = agentProblems({ version: '1.1.0', minVersion: '1.0.0', nowMs: NOW, lastHeartbeatMs: at(5), lastDataMs: at(20), onlineSeconds: 150,
    diag: { collectors: { forwarder: 'running', exporter: 'running' }, uploadFailures: 0 } });
  assert.deepEqual(p, []);
});

test('problems: heartbeats arrive but no metrics = data path problem, told apart from agent down', () => {
  const p = agentProblems({ version: '1.1.0', minVersion: '1.0.0', nowMs: NOW, lastHeartbeatMs: at(5), lastDataMs: at(3600), onlineSeconds: 150,
    diag: { collectors: { forwarder: 'running', exporter: 'running' } } });
  assert.match(p.join(' '), /no metrics have been received/);
});

test('versions compare numerically', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.1.0', '1.1.0'), 0);
  assert.equal(compareVersions('0.9', '1.0.0'), -1);
});

test('counter deltas: normal, reset after restart, first sample, invalid', () => {
  assert.equal(counterDelta(10, 15), 5);
  assert.equal(counterDelta(1000, 3), 3); // counter went down = restarted: no huge negative or false spike
  assert.equal(counterDelta(undefined, 50), 0);
  assert.equal(counterDelta(5, NaN), null);
  assert.equal(counterDelta(5, -1), null);
});
