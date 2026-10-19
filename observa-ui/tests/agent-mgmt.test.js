// Agent management rules (src/agentmgmt.js): settings validation, layers, what the agent receives, bundle scrubbing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSettings, mergeLayers, toAgentMap, scrubBundle } from '../src/agentmgmt.js';

test('only the allowed settings can be set from ObservaOne, with their ranges', () => {
  assert.deepEqual(validateSettings({ collect_interval: '30s', buffer_payloads: 80, disable: ['network', 'disk', 'network'], 'processes.top': 0, 'docker.enabled': true }).settings,
    { collect_interval: '30s', buffer_payloads: 80, disable: ['network', 'disk'], 'processes.top': 0, 'docker.enabled': true });
  for (const [bad, want] of [
    [{ server: 'https://evil' }, /cannot be set/],
    [{ ca_file: '/tmp/x' }, /cannot be set/],
    [{ mode: 'pull' }, /cannot be set/],
    [{ 'nginx.status_url': 'http://169.254.169.254/' }, /cannot be set/],
    [{ collect_interval: '1s' }, /5s to 5m/],
    [{ collect_interval: '10h' }, /5s to 5m/],
    [{ collect_interval: '30' }, /5s to 5m/],
    [{ buffer_payloads: 0 }, /1 to 1000/],
    [{ buffer_payloads: 1.5 }, /whole number/],
    [{ disable: ['cpu', 'rm -rf'] }, /unknown collector/],
    [{ 'docker.enabled': 'yes' }, /true or false/],
    [[], /object/],
  ]) assert.match(validateSettings(bad).err, want, JSON.stringify(bad));
  assert.deepEqual(validateSettings({ collect_interval: '', buffer_payloads: null }).settings, {}, 'empty = inherit again');
});

test('layers: environment -> target -> agent, later wins; version is the highest', () => {
  const m = mergeLayers([
    { scope: 'env', settings: { collect_interval: '60s', disable: ['network'] }, version: 3 },
    { scope: 'target', settings: { collect_interval: '30s' }, version: 9 },
    { scope: 'agent', settings: { buffer_payloads: 10 }, version: 5 },
  ]);
  assert.deepEqual(m.settings, { collect_interval: '30s', disable: ['network'], buffer_payloads: 10 });
  assert.deepEqual(m.from, { collect_interval: 'target', disable: 'env', buffer_payloads: 'agent' });
  assert.equal(m.version, 9);
  assert.deepEqual(mergeLayers([]), { settings: {}, from: {}, version: 0 });
});

test('the agent receives strings in its own config keys', () => {
  assert.deepEqual(toAgentMap({ collect_interval: '30s', disable: ['network', 'disk'], buffer_payloads: 10, 'docker.enabled': false }),
    { collect_interval: '30s', disable: 'network,disk', buffer_payloads: '10', 'docker.enabled': 'false' });
});

test('diagnostics bundles: anything that looks like a secret is removed on the way in', () => {
  const b = scrubBundle({
    logs: ['token oat_1234abcd_AAAAAAAAAAAAAAAAAAAAAAAA used', 'cred oac_aaaaaaaaaaaaaaaaaaaa_BBBBBBBBBBBB', 'password=hunter2xx ok'],
    credential: 'oac_x', nested: { privateKey: 'x', key: '-----BEGIN EC PRIVATE KEY-----\nabc\n-----END EC PRIVATE KEY-----' },
    settings: [{ setting: 'server', value: 'https://obs.example.com' }],
  });
  const text = JSON.stringify(b);
  assert.ok(!/oat_1234|oac_aaaa|hunter2|abc\\n|BEGIN EC/.test(text), text);
  assert.equal(b.credential, '[removed]');
  assert.equal(b.settings[0].value, 'https://obs.example.com');
});
