// Notification channels (src/notify.js): what ObservaOne writes into Alertmanager's configuration, and the input checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderConfig, cleanChannel, teamsOf } from '../src/notify.js';
import { encrypt } from '../src/secrets.js';

const BASE = {
  global: { resolve_timeout: '5m' },
  route: { receiver: 'platform-team', group_by: ['alertname', 'severity', 'env'], routes: [
    { matchers: ['team="infra"'], receiver: 'infra-team' },
    { matchers: ['severity="critical"'], receiver: 'platform-team', repeat_interval: '1h' },
  ] },
  receivers: [{ name: 'platform-team' }, { name: 'infra-team' }],
  inhibit_rules: [{ source_matchers: ['alertname="ServerDown"'], target_matchers: ['severity="warning"'], equal: ['host'] }],
};
const row = (o) => ({ enabled: true, send_resolved: true, settings: {}, secret: null, ...o });
const SMTP = { configured: true, smarthost: 'mail.bank.local:587', from: 'monitoring@bank.local', requireTls: true, username: 'mon', password: 'pw' };

test('channels are added to their team receiver; the base routes, grouping and inhibition stay', () => {
  const cfg = renderConfig(BASE, [
    row({ type: 'email', team: 'platform', settings: { to: 'oncall@bank.local' } }),
    row({ type: 'webhook', team: 'infra', secret: encrypt(JSON.stringify({ url: 'https://itsm.local/hook', token: 't0k' })), send_resolved: false }),
  ], SMTP);
  assert.deepEqual(cfg.receivers.find((r) => r.name === 'platform-team').email_configs, [{ to: 'oncall@bank.local', send_resolved: true }]);
  assert.deepEqual(cfg.receivers.find((r) => r.name === 'infra-team').webhook_configs,
    [{ url: 'https://itsm.local/hook', send_resolved: false, http_config: { authorization: { type: 'Bearer', credentials: 't0k' } } }]);
  assert.deepEqual(cfg.route.group_by, BASE.route.group_by);
  assert.deepEqual(cfg.inhibit_rules, BASE.inhibit_rules);
  assert.equal(cfg.global.smtp_smarthost, 'mail.bank.local:587');
  assert.equal(cfg.global.smtp_auth_password, 'pw');
  assert.equal(cfg.global.resolve_timeout, '5m');
  assert.equal(BASE.receivers[0].email_configs, undefined, 'the base object is not changed');
});

test('a new team gets a receiver and a route before the severity routes; the default team needs none', () => {
  const cfg = renderConfig(BASE, [
    row({ type: 'teams', team: 'payments', secret: encrypt(JSON.stringify({ url: 'https://x.webhook.office.com/a' })) }),
    row({ type: 'slack', team: 'platform', settings: { channel: '#alerts' }, secret: encrypt(JSON.stringify({ url: 'https://hooks.slack.com/s/1' })) }),
  ], null);
  assert.deepEqual(cfg.route.routes[0], { matchers: ['team="payments"'], receiver: 'payments-team' });
  assert.equal(cfg.route.routes.length, 3);
  const tm = cfg.receivers.find((r) => r.name === 'payments-team').msteamsv2_configs;
  assert.equal(tm.length, 1); assert.equal(tm[0].webhook_url, 'https://x.webhook.office.com/a'); assert.equal(tm[0].send_resolved, true);
  assert.match(tm[0].title, /FIRING/);
  const sl = cfg.receivers.find((r) => r.name === 'platform-team').slack_configs;
  assert.equal(sl.length, 1); assert.equal(sl[0].api_url, 'https://hooks.slack.com/s/1'); assert.equal(sl[0].channel, '#alerts');
  assert.ok(sl[0].text && sl[0].color && sl[0].fallback, 'Slack messages use the ObservaOne layout');
});

test('disabled channels and email without a mail server are left out (Alertmanager would refuse the file)', () => {
  const cfg = renderConfig(BASE, [
    row({ type: 'email', team: 'platform', settings: { to: 'a@b.local' } }),
    row({ type: 'pagerduty', team: 'infra', enabled: false, secret: encrypt(JSON.stringify({ routingKey: 'R'.repeat(32) })) }),
  ], { configured: false });
  assert.equal(cfg.receivers.find((r) => r.name === 'platform-team').email_configs, undefined);
  assert.equal(cfg.receivers.find((r) => r.name === 'infra-team').pagerduty_configs, undefined);
  assert.equal(cfg.global.smtp_smarthost, undefined);
});

test('teams: the base file\'s "<team>-team" receivers and the channels\' teams', () => {
  assert.deepEqual(teamsOf(BASE, [{ team: 'payments' }, { team: 'infra' }]), ['infra', 'payments', 'platform']);
});

test('input checks: types, teams, addresses, URLs; secrets are stored encrypted and shown masked', () => {
  assert.throws(() => cleanChannel({ name: 'x', type: 'sms', team: 'ops' }), /channel type/);
  assert.throws(() => cleanChannel({ name: 'x', type: 'email', team: 'Ops Team', to: 'a@b.local' }), /Team/);
  assert.throws(() => cleanChannel({ name: 'x', type: 'email', team: 'ops', to: 'a@b.local, nope' }), /Not an email address: nope/);
  assert.throws(() => cleanChannel({ name: 'x', type: 'teams', team: 'ops', webhookUrl: 'http://x.local/a' }), /https/);
  assert.throws(() => cleanChannel({ name: 'x', type: 'webhook', team: 'ops', url: 'https://u:p@x.local/a' }), /credentials/);
  assert.throws(() => cleanChannel({ name: 'x', type: 'pagerduty', team: 'ops', routingKey: 'short' }), /routing/);
  const w = cleanChannel({ name: 'ITSM', type: 'webhook', team: 'ops', url: 'https://itsm.local/api/hook?key=SECRET', token: 'tok' });
  assert.equal(w.display, 'https://itsm.local/…');
  assert.ok(w.secret.startsWith('v1:') && !w.secret.includes('SECRET'));
  // editing: empty secret fields keep the stored ones
  const again = cleanChannel({ name: 'ITSM 2' }, { ...w, settings: w.settings, send_resolved: true, enabled: true });
  assert.equal(again.display, 'https://itsm.local/…');
  assert.equal(again.type, 'webhook', 'the type cannot change on edit');
  const e = cleanChannel({ name: 'Mail', type: 'email', team: 'platform', to: 'a@b.local; c@d.local' });
  assert.equal(e.settings.to, 'a@b.local, c@d.local');
});

test('Slack / Teams layouts: links to ObservaOne only with PUBLIC_URL, times in the message time zone', async () => {
  const { slackLayout, teamsLayout, zoneOf } = await import('../src/notify.js');
  const ist = zoneOf('Asia/Kolkata');
  assert.deepEqual(ist, { minutes: 330, label: 'IST' });
  assert.deepEqual(zoneOf('No/Such_Zone'), { minutes: 0, label: 'UTC' });
  const s = slackLayout('https://observaone.bank.local', ist);
  assert.match(s.text, /<https:\/\/observaone\.bank\.local\/alerting\/open\?name=\{\{ \$a\.Labels\.alertname \| urlquery \}\}&host=.*\|Details>/);
  assert.match(s.text, /\/metrics\/host\/\{\{ \. \| urlquery \}\}\|Host>/);
  assert.match(s.text, /Add 19800000000000\)\.Format "2006-01-02 15:04" \}\} IST/);
  assert.equal(s.actions[0].text, 'Open in ObservaOne');
  assert.match(s.color, /danger/);
  const bare = slackLayout('', zoneOf('UTC'));
  assert.ok(!/https?:\/\/|\|Details>/.test(bare.text) && !bare.actions && !bare.title_link, 'no links without PUBLIC_URL');
  assert.ok(!/\.Add /.test(bare.text), 'UTC needs no offset');
  const t = teamsLayout('https://observaone.bank.local', ist);
  assert.match(t.text, /\[Details\]\(https:\/\/observaone\.bank\.local\/alerting\/open\?/);
  assert.match(t.text, /since \{\{ \(\$a\.StartsAt\.UTC\.Add 19800000000000\)\.Format "Jan 2 15:04" \}\} IST/);
});
