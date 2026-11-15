// P0 UI consistency rules: one status vocabulary, one set of counts, no duplicate alert rows, no meaningless
// change badges. Pure functions only: no database or network needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostStatusOfAgent, hostStatusOfScrape, countServers, showsLiveValues, agentHostHealth, dedupeOpenEpisodes, HOST_STATUSES } from '../src/health.js';
import { countAlerts } from '../src/routes/alerting.js';
import { changeOf, changeText, pctChange } from '../web/src/lib/format.ts';
import { STATUS_META, asStatus, countStatuses, statusParts, showsLive, HOST_STATUSES as UI_STATUSES } from '../web/src/lib/status.ts';

test('server and UI share exactly one status vocabulary', () => {
  assert.deepEqual(HOST_STATUSES, ['up', 'down', 'not_reporting', 'offline', 'disabled']);
  assert.deepEqual(UI_STATUSES, HOST_STATUSES);
  assert.deepEqual(UI_STATUSES.map((k) => STATUS_META[k].label), ['Up', 'Down', 'Not reporting', 'Offline', 'Disabled']);
});

test('agent statuses map onto the vocabulary', () => {
  assert.equal(hostStatusOfAgent('online'), 'up');
  assert.equal(hostStatusOfAgent('attention'), 'up', 'needs attention is a flag, not a status');
  assert.equal(hostStatusOfAgent('not_reporting'), 'not_reporting');
  assert.equal(hostStatusOfAgent('offline'), 'offline', 'offline is no longer folded into not reporting');
  assert.equal(hostStatusOfAgent('pending'), 'not_reporting');
  assert.equal(hostStatusOfAgent('blocked'), 'disabled');
  assert.equal(hostStatusOfAgent('???'), 'not_reporting', 'unknown never looks green or red');
  assert.equal(hostStatusOfScrape('up'), 'up');
  assert.equal(hostStatusOfScrape('down'), 'down');
  assert.equal(hostStatusOfScrape('unknown'), 'not_reporting');
  assert.equal(asStatus('unknown'), 'not_reporting');
});

test('a silent pushed agent goes not reporting, then offline', () => {
  const h = (age) => agentHostHealth({ nowSec: 10_000, lastSeenSec: 10_000 - age, upValue: true, onlineSeconds: 90, offlineSeconds: 600 }).health;
  assert.equal(h(10), 'up');
  assert.equal(h(120), 'not_reporting');
  assert.equal(h(900), 'offline');
});

test('only an up host shows live values', () => {
  for (const s of HOST_STATUSES) {
    assert.equal(showsLiveValues(s), s === 'up');
    assert.equal(showsLive(s), s === 'up');
  }
});

test('server counts: the same numbers from the server and the UI', () => {
  const rows = [{ health: 'up' }, { health: 'up' }, { health: 'down' }, { health: 'not_reporting' }, { health: 'offline' }, { health: 'disabled' }, { health: 'unknown' }];
  const want = { total: 7, up: 2, down: 1, notReporting: 2, offline: 1, disabled: 1 };
  assert.deepEqual(countServers(rows), want);
  assert.deepEqual(countStatuses(rows), want);
  assert.deepEqual(statusParts({ ...want, down: 0 }).map(([k]) => k), ['up', 'not_reporting', 'offline', 'disabled'], 'zero parts other than "up" are left out');
});

const ep = (o) => ({ id: 1, alertname: 'AgentNotReporting', state: 'firing', resolved_at: null, active_at: '2026-10-24T08:00:00Z', last_seen: '2026-10-24T08:10:00Z', ...o });

test('an alert open twice after an env edit is one row (vm / vm · lab)', () => {
  const old = ep({ id: 1, labels: { alertname: 'AgentNotReporting', host: 'vm', job: 'linux' }, last_seen: '2026-10-24T08:09:45Z' });
  const cur = ep({ id: 2, labels: { alertname: 'AgentNotReporting', host: 'vm', job: 'linux', env: 'lab' } });
  const out = dedupeOpenEpisodes([old, cur]);
  assert.deepEqual(out.map((e) => e.id), [2], 'the most recently seen label set is kept');
});

test('different alerts on one host are not merged', () => {
  const c = ep({ id: 1, alertname: 'DiskLow', labels: { alertname: 'DiskLow', host: 'vm', volume: 'C:' } });
  const d = ep({ id: 2, alertname: 'DiskLow', labels: { alertname: 'DiskLow', host: 'vm', volume: 'D:' } });
  const r = ep({ id: 3, labels: { alertname: 'AgentNotReporting', host: 'vm' }, resolved_at: '2026-10-24T07:00:00Z' });
  const r2 = ep({ id: 4, labels: { alertname: 'AgentNotReporting', host: 'vm', env: 'lab' }, resolved_at: '2026-10-24T07:30:00Z' });
  assert.equal(dedupeOpenEpisodes([c, d, r, r2]).length, 4, 'separate volumes and resolved history are kept');
});

test('alert counts: firing includes muted, critical/warning are of the firing ones', () => {
  const list = [
    { state: 'firing', severity: 'critical', silenced: false, inhibited: false },
    { state: 'firing', severity: 'warning', silenced: true, inhibited: false },
    { state: 'firing', severity: 'warning', silenced: false, inhibited: true },
    { state: 'pending', severity: 'critical', silenced: false, inhibited: false },
  ];
  assert.deepEqual(countAlerts(list), { firing: 3, active: 3, pending: 1, critical: 1, warning: 2, muted: 2 });
  assert.equal(countAlerts(list, false).muted, null, 'Alertmanager down: muted is unknown, not 0');
});

test('change badges: points for percentages, nothing from a ~0 base or an absurd jump', () => {
  assert.deepEqual(changeOf(27, 1.6, 'percent'), { value: 25.4, unit: 'pts' });
  assert.equal(changeText(changeOf(27, 1.6, 'percent')), '▲ 25.4 pts');
  assert.equal(changeOf(24771.3, 100, 'Bps'), null, 'no "▲ 24770.3%"');
  assert.equal(changeOf(5, 0, 'Bps'), null);
  assert.deepEqual(changeOf(150, 100, 'Bps'), { value: 50, unit: '%' });
  assert.equal(changeText(changeOf(50, 100, 'none')), '▼ 50.0%');
  assert.equal(changeOf(null, 1, 'none'), null);
  assert.equal(pctChange(1000, 1), null);
});
