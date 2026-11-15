// Notification policies (src/policies.js + notify.js renderConfig): conversion from the team setup, which policy an
// alert goes to (same rules as Alertmanager), and the routes / receivers written for Alertmanager.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertLegacy, routeFor, matchesAll, parseMatcher, matcherString, cleanPolicy } from '../src/policies.js';
import { renderConfig } from '../src/notify.js';
import { encrypt } from '../src/secrets.js';

const BASE = {
  global: { resolve_timeout: '5m' },
  route: { receiver: 'platform-team', group_by: ['alertname', 'severity', 'env'], repeat_interval: '4h', routes: [
    { matchers: ['team="infra"'], receiver: 'infra-team' },
    { matchers: ['team="ops"'], receiver: 'ops-team' },
    { matchers: ['severity="critical"', 'env="prod"'], receiver: 'platform-team', repeat_interval: '1h' },
  ] },
  receivers: [{ name: 'platform-team' }, { name: 'infra-team' }, { name: 'ops-team' }],
  inhibit_rules: [{ source_matchers: ['alertname="ServerDown"'], target_matchers: ['severity="warning"'], equal: ['host'] }],
};
const CH = [
  { id: 1, team: 'platform', type: 'email', enabled: true, send_resolved: true, settings: { to: 'oncall@bank.local' }, secret: null },
  { id: 2, team: 'ops', type: 'webhook', enabled: true, send_resolved: true, settings: {}, secret: encrypt(JSON.stringify({ url: 'https://itsm.local/h' })) },
  { id: 3, team: 'payments', type: 'slack', enabled: true, send_resolved: true, settings: {}, secret: encrypt(JSON.stringify({ url: 'https://hooks.slack.com/s/x' })) },
];
const withIds = (conv) => [...conv.policies.map((p, i) => ({ ...p, id: i + 1, position: i + 1, isDefault: false })), { ...conv.defaultPolicy, id: 99, position: 0, isDefault: true }];

test('matchers: parse the base file forms, write Alertmanager form, match like Alertmanager (anchored regex)', () => {
  assert.deepEqual(parseMatcher('team="infra"'), { label: 'team', op: '=', value: 'infra' });
  assert.deepEqual(parseMatcher('severity=~"critical|warning"'), { label: 'severity', op: '=~', value: 'critical|warning' });
  assert.deepEqual(parseMatcher('env != dev'), { label: 'env', op: '!=', value: 'dev' });
  assert.equal(matcherString({ label: 'service', op: '=', value: 'pay "x"' }), 'service="pay \\"x\\""');
  assert.ok(matchesAll([{ label: 'severity', op: '=~', value: 'critical|warning' }], { severity: 'warning' }));
  assert.ok(!matchesAll([{ label: 'severity', op: '=~', value: 'crit' }], { severity: 'critical' }), 'regex is anchored');
  assert.ok(matchesAll([{ label: 'env', op: '!=', value: 'dev' }], {}), 'missing label = empty value');
});

test('the team setup becomes policies that send every alert where it went before', () => {
  const conv = convertLegacy(BASE, CH);
  assert.deepEqual(conv.policies.map((p) => p.name), ['Team payments', 'Team infra', 'Team ops', 'Critical alerts in prod']);
  assert.deepEqual(conv.policies.map((p) => p.channels), [[3], [], [2], [1]]);
  assert.equal(conv.policies[3].repeatInterval, '1h');
  assert.deepEqual(conv.defaultPolicy.channels, [1]);
  assert.deepEqual(conv.defaultPolicy.groupBy, ['alertname', 'severity', 'env']);
  const P = withIds(conv);
  const to = (labels) => routeFor(P, labels).map((p) => p.name);
  assert.deepEqual(to({ team: 'payments', severity: 'critical', env: 'prod' }), ['Team payments']);
  assert.deepEqual(to({ team: 'infra' }), ['Team infra'], 'infra had a route without channels: still not sent elsewhere');
  assert.deepEqual(to({ severity: 'critical', env: 'prod' }), ['Critical alerts in prod']);
  assert.deepEqual(to({ severity: 'warning', env: 'uat' }), ['Default']);
});

test('order, continue, disabled, and a rule that names its policy', () => {
  const P = [
    { id: 1, name: 'A', position: 1, enabled: true, isDefault: false, continue: true, matchers: [{ label: 'severity', op: '=', value: 'critical' }], channels: [] },
    { id: 2, name: 'B', position: 2, enabled: true, isDefault: false, continue: false, matchers: [{ label: 'env', op: '=', value: 'prod' }], channels: [] },
    { id: 3, name: 'C', position: 3, enabled: false, isDefault: false, continue: false, matchers: [], channels: [] },
    { id: 9, name: 'Default', position: 0, enabled: true, isDefault: true, matchers: [], channels: [] },
  ];
  const to = (l) => routeFor(P, l).map((p) => p.name);
  assert.deepEqual(to({ severity: 'critical', env: 'prod' }), ['A', 'B'], 'continue also checks the next ones');
  assert.deepEqual(to({ severity: 'critical', env: 'uat' }), ['A']);
  assert.deepEqual(to({ env: 'dev' }), ['Default'], 'disabled C (match-all) is skipped');
  assert.deepEqual(to({ env: 'dev', observaone_policy: 'p2' }), ['B'], 'named policy wins');
});

test('Alertmanager config from policies: one receiver per policy, explicit routes first, base inhibition kept', () => {
  const P = withIds(convertLegacy(BASE, CH));
  const cfg = renderConfig(BASE, CH, { configured: true, smarthost: 'mail.local:25', from: 'm@bank.local', requireTls: false }, P);
  assert.equal(cfg.route.receiver, 'default');
  assert.equal(cfg.route.repeat_interval, '4h');
  assert.deepEqual(cfg.receivers.map((r) => r.name), ['default', 'policy-1', 'policy-2', 'policy-3', 'policy-4']);
  assert.deepEqual(cfg.receivers[0].email_configs, [{ to: 'oncall@bank.local', send_resolved: true }]);
  assert.equal(cfg.receivers[1].slack_configs[0].api_url, 'https://hooks.slack.com/s/x');
  assert.deepEqual(cfg.route.routes.slice(0, 4).map((r) => r.matchers[0]), ['observaone_policy="p1"', 'observaone_policy="p2"', 'observaone_policy="p3"', 'observaone_policy="p4"']);
  assert.deepEqual(cfg.route.routes[7], { matchers: ['severity="critical"', 'env="prod"'], receiver: 'policy-4', repeat_interval: '1h' });
  assert.deepEqual(cfg.inhibit_rules, BASE.inhibit_rules);
  assert.equal(cfg.global.smtp_smarthost, 'mail.local:25');
  // email without a mail server is left out; a disabled channel too
  const noMail = renderConfig(BASE, CH.map((c) => (c.id === 2 ? { ...c, enabled: false } : c)), { configured: false }, P);
  assert.equal(noMail.receivers[0].email_configs, undefined);
  assert.equal(noMail.receivers[3].webhook_configs, undefined);
});

test('policy input checks', () => {
  assert.throws(() => cleanPolicy({ name: '' }), /name/);
  assert.throws(() => cleanPolicy({ name: 'x', matchers: [{ label: 'bad-label', op: '=', value: 'a' }] }), /label name/);
  assert.throws(() => cleanPolicy({ name: 'x', matchers: [{ label: 'env', op: '~', value: 'a' }] }), /comparison/);
  assert.throws(() => cleanPolicy({ name: 'x', matchers: [{ label: 'env', op: '=~', value: '(' }] }), /pattern/);
  assert.throws(() => cleanPolicy({ name: 'x', repeatInterval: '4 hours' }), /duration/);
  assert.throws(() => cleanPolicy({ name: 'x', channels: [7] }, { channelIds: new Set([1]) }), /Unknown channel: 7/);
  const p = cleanPolicy({ name: 'Prod critical', matchers: [{ label: 'severity', op: '=', value: 'critical' }], channels: ['1', 1, 2], groupBy: ['alertname', 'env'], repeatInterval: '1h', continue: true });
  assert.deepEqual(p.channels, [1, 2]);
  assert.equal(p.repeatInterval, '1h'); assert.equal(p.groupWait, null); assert.equal(p.continue, true);
  assert.equal(cleanPolicy({ name: 'Default', continue: true, matchers: [{ label: 'a', op: '=', value: 'b' }] }, { isDefault: true }).matchers.length, 0);
});
