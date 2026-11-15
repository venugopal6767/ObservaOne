// The alerting layer's own logic (src/alerting.js, src/routes/alerting.js): alert identity, threshold parsing,
// display rows and rule expressions. Prometheus evaluates the rules; these keep what ObservaOne shows right.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertKey, splitThreshold, unitOf, resourceOf } from '../src/alerting.js';
import { toRow, buildExpr } from '../src/routes/alerting.js';

test('an alert keeps the same key whatever the label order; another label set gets another key', () => {
  const a = alertKey({ alertname: 'HighCPU', host: 'web-1', severity: 'critical' });
  assert.equal(a, alertKey({ severity: 'critical', host: 'web-1', alertname: 'HighCPU' }));
  assert.notEqual(a, alertKey({ alertname: 'HighCPU', host: 'web-2', severity: 'critical' }));
});

test('threshold and comparison are read from the rule expression', () => {
  assert.deepEqual(splitThreshold('(observaone:host_cpu_usage:percent) > 80'), { left: 'observaone:host_cpu_usage:percent', op: '>', threshold: 80 });
  assert.deepEqual(splitThreshold('100 * x / y < 10.5'), { left: '100 * x / y', op: '<', threshold: 10.5 });
  assert.equal(splitThreshold('max_over_time(up[24h]) unless max_over_time(up[3m])'), null);
  // outer parentheses kept when they do not wrap the whole left side
  assert.equal(splitThreshold('(a) / (b) >= 2').left, '(a) / (b)');
  // a trailing comment (as in the shipped rules) is ignored
  assert.equal(splitThreshold('rate(x[5m]) > 90  # idle / total').threshold, 90);
});

test('rule expressions from the form: query + comparison + threshold', () => {
  assert.equal(buildExpr({ query: 'up', op: '<', threshold: 1 }), '(up) < 1');
  assert.equal(buildExpr({ query: 'up', threshold: '' }), 'up');
  assert.equal(buildExpr({ query: 'up', op: 'DROP', threshold: 5 }), '(up) > 5'); // unknown comparison -> '>'
  assert.equal(buildExpr({ expr: 'up == 0' }), 'up == 0');
  assert.throws(() => buildExpr({ query: 'up', threshold: 'x' }), /Threshold must be a number/);
  assert.throws(() => buildExpr({}), /Query is required/);
});

test('unit and resource shown for an alert', () => {
  assert.equal(unitOf({}, {}, 'HighCPU'), 'percent');
  assert.equal(unitOf({ unit: 'bytes' }, {}, 'HighCPU'), 'bytes');
  assert.equal(unitOf({}, {}, 'AgentNotReporting'), 'none');
  assert.equal(resourceOf({ host: 'h', instance: 'i' }), 'h');
  assert.equal(resourceOf({ instance: 'i:9100' }), 'i:9100');
});

const ep = (o) => ({
  id: 7, alert_key: 'k', alertname: 'HighCPU', severity: 'critical', host: 'web-1', labels: { team: 'infra', env: 'prod' }, annotations: { summary: 's' },
  state: 'firing', value: 91.5, peak: 95, active_at: '2026-10-20T10:00:00Z', fired_at: '2026-10-20T10:05:00Z', resolved_at: null, rule_expr: 'x > 90', ...o,
});
test('rows: state, duration from when it fired, value only for threshold rules, silence state from Alertmanager', () => {
  const now = Date.parse('2026-10-20T10:17:00Z');
  const r = toRow(ep(), new Map([['k', { silenced: true, inhibited: false }]]), now);
  assert.equal(r.state, 'firing'); assert.equal(r.durationSec, 12 * 60); assert.equal(r.value, 91.5); assert.equal(r.silenced, true);
  assert.equal(r.team, 'infra'); assert.equal(r.unit, 'percent');
  const res = toRow(ep({ state: 'firing', resolved_at: '2026-10-20T10:30:00Z' }), null, now);
  assert.equal(res.state, 'resolved'); assert.equal(res.durationSec, 25 * 60); assert.equal(res.neverFired, false);
  const cleared = toRow(ep({ state: 'pending', fired_at: null, resolved_at: '2026-10-20T10:02:00Z' }), null, now);
  assert.equal(cleared.neverFired, true);
  const pend = toRow(ep({ state: 'pending', fired_at: null }), null, now);
  assert.equal(pend.durationSec, 17 * 60, 'pending counts from when the condition became true');
  assert.equal(toRow(ep({ rule_expr: 'a unless b', value: 1 }), null, now).value, null, 'no threshold, no value');
});
