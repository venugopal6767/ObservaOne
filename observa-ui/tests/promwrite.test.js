// Unit tests for agent metrics intake: text parser, relabelling (server-side identity), remote-write encoding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExposition, encodeWriteRequest, snappyEncode, snappyDecode } from '../src/promwrite.js';
import { relabel } from '../src/routes/agent-control.js';

test('parser accepts valid samples with labels, escapes and timestamps', () => {
  const { series, errors } = parseExposition('# HELP x y\n# TYPE x gauge\nx{a="1",b="q\\"\\\\"} 1.5e3 1700000000000\nup 1\n');
  assert.equal(errors.length, 0);
  assert.deepEqual(series[0], { name: 'x', labels: { a: '1', b: 'q"\\' }, value: 1500, ts: 1700000000000 });
  assert.deepEqual(series[1], { name: 'up', labels: {}, value: 1, ts: null });
});

test('parser refuses NaN, Inf, bad names, bad labels, duplicate labels', () => {
  const bad = ['x NaN', 'x +Inf', 'x -Inf', '1x 1', 'x{1a="b"} 1', 'x{a="b",a="c"} 1', 'x{a="unterminated} 1', 'x 1 notatime', 'x'];
  const { series, errors } = parseExposition(bad.join('\n'));
  assert.equal(series.length, 0);
  assert.equal(errors.length, bad.length);
});

test('parser caps the number of series', () => {
  const text = Array.from({ length: 50 }, (_, i) => `m${i} 1`).join('\n');
  const { series, errors } = parseExposition(text, { maxSeries: 10 });
  assert.equal(series.length, 10);
  assert.equal(errors[0].reason, 'too many series');
});

test('relabel: identity labels come from the database, never from the agent', () => {
  const row = { id: 'agt_1', host: 'web1', platform: 'linux', env: 'prod', role: '', labels: { team: 'core' } };
  const now = 1_800_000_000_000;
  const { out } = relabel([{ name: 'node_load1', labels: { host: 'evil', agent_id: 'agt_2', job: 'windows', team: 'x', cpu: '0' }, value: 1, ts: now }], row, { nowMs: now });
  const l = out[0].labels;
  assert.equal(l.host, 'web1');
  assert.equal(l.agent_id, 'agt_1');
  assert.equal(l.job, 'linux');
  assert.equal(l.team, 'core');
  assert.equal(l.cpu, '0');
  assert.equal(l.role, undefined); // empty role is not invented
  assert.equal(out[1].labels.__name__, 'up');
});

test('relabel: clock skew is corrected; too old / future samples are dropped', () => {
  const row = { id: 'a', host: 'h', platform: 'linux', labels: {} };
  const now = 1_800_000_000_000;
  const s = (ts) => ({ name: 'm', labels: {}, value: 1, ts });
  // host clock 10 min behind: its "now" is server now - 600 s; skew +600 s brings it back
  let r = relabel([s(now - 600_000)], row, { nowMs: now, skewMs: 600_000 });
  assert.equal(r.out[0].ts, now);
  r = relabel([s(now - 3 * 3_600_000), s(now + 3_600_000), s(now - 3_600_000), s(now)], row, { nowMs: now }); // 1 h late is kept (disk buffers, gateways), 3 h is not
  assert.equal(r.dropped, 2);
});

test('remote write encoding round-trips through snappy', () => {
  const body = encodeWriteRequest([{ labels: { b: '2', __name__: 'm', a: '1' }, value: 1.25, ts: 1700000000000 }]);
  const big = Buffer.concat(Array(5000).fill(body)); // > 64 KiB: several literal chunks
  for (const b of [body, big]) assert.deepEqual(snappyDecode(snappyEncode(b)), b);
  // labels are written sorted by name: __name__ (0x5f) < a < b
  const s = body.toString('latin1');
  assert.ok(s.indexOf('__name__') < s.indexOf('\na') || s.indexOf('__name__') < s.indexOf('a\u0012'));
});

test('relabel: the tenant label comes from the agent record, never from the agent', () => {
  const now = 1_800_000_000_000;
  const series = [{ name: 'm', labels: { tenant: 't_evil', gateway: 'x' }, value: 1, ts: now }];
  const a = relabel(series, { id: 'a', host: 'h', platform: 'linux', labels: {}, tenant_id: 't_acme' }, { nowMs: now });
  assert.equal(a.out[0].labels.tenant, 't_acme');
  assert.equal(a.out[0].labels.gateway, undefined);
  const d = relabel(series, { id: 'a', host: 'h', platform: 'linux', labels: {}, tenant_id: 't_default' }, { nowMs: now });
  assert.equal(d.out[0].labels.tenant, undefined, 'default tenant: no label (no change for existing series)');
});
