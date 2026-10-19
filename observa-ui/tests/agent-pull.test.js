// Pull mode, service discovery, registration replay check and the diagnosis matrix. No database or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oo-pki-'));
process.env.AGENT_PKI_DIR = path.join(tmp, 'pki');
process.env.AGENT_PROMETHEUS_DIR = path.join(tmp, 'prom');

const { diagnoseAgent } = await import('../src/health.js');
const { agentAddress, sdGroups } = await import('../src/routes/agent-sd.js');
const { replayCheck } = await import('../src/routes/agent-control.js');
const { initAgentPki, parseCertRequest, issueAgentCert, sdTokenOk, PROMETHEUS_CLIENT_NAME } = await import('../src/agentpki.js');

const pullRow = { id: 'agt_aaaaaaaaaaaaaaaaaaaa', host: 'web01', platform: 'linux', env: 'prod', role: 'web', labels: { team: 'pay', host: 'evil' },
  ip: '10.0.0.5', mode: 'pull', pull: { port: 9110, ips: ['10.0.0.5', '192.168.1.5'], dns: [] }, addresses: ['10.0.0.5'], credential_hash: 'x', blocked: false };

test('scrape address: the address the server sees when the host has it, else the host\'s first, advertise name wins', () => {
  assert.equal(agentAddress(pullRow).host, '10.0.0.5');
  assert.equal(agentAddress({ ...pullRow, ip: '203.0.113.9' }).host, '10.0.0.5');
  assert.equal(agentAddress({ ...pullRow, pull: { ...pullRow.pull, dns: ['web01.lan'] } }).host, 'web01.lan');
  assert.equal(agentAddress({ ...pullRow, pull: { port: 9110, ips: [], dns: [] } }), null);
  assert.equal(agentAddress({ ...pullRow, mode: 'push', ip: '203.0.113.9', addresses: ['10.0.0.5'] }).host, '10.0.0.5');
});

test('service discovery: pull targets with identity labels; custom labels cannot override host', () => {
  const g = sdGroups([pullRow, { ...pullRow, id: 'agt_b', mode: 'push' }, { ...pullRow, id: 'agt_c', blocked: true }], 'pull');
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].targets, ['10.0.0.5:9110']);
  assert.equal(g[0].labels.host, 'web01');
  assert.equal(g[0].labels.team, 'pay');
  assert.equal(g[0].labels.agent_id, pullRow.id);
  const ping = sdGroups([pullRow, { ...pullRow, id: 'agt_b', mode: 'push' }], 'ping');
  assert.equal(ping.length, 2);
  assert.ok(ping.every((x) => x.labels.probe === 'icmp' && !x.labels.job));
  const v6 = sdGroups([{ ...pullRow, ip: 'fd00::5', pull: { port: 9110, ips: ['fd00::5'], dns: [] } }], 'port');
  assert.deepEqual(v6[0].targets, ['[fd00::5]:9110']);
});

test('registration replay check: 1.2 must send nonce + timestamp within 5 minutes; 1.1 still accepted', () => {
  const now = 1_800_000_000_000;
  assert.equal(replayCheck({ version: '1.1.0' }, now), null);
  assert.match(replayCheck({ version: '1.2.0' }, now), /nonce/);
  assert.equal(replayCheck({ version: '1.2.0', nonce: 'a'.repeat(32), timestamp: now - 60_000 }, now), null);
  assert.match(replayCheck({ version: '1.2.0', nonce: 'a'.repeat(32), timestamp: now - 6 * 60_000 }, now), /NTP/);
});

test('agent CA: Prometheus client cert + agent server cert verify, cover the addresses, files exported', () => {
  const s = initAgentPki();
  const ca = new crypto.X509Certificate(s.caPem);
  assert.ok(ca.ca);
  const cli = new crypto.X509Certificate(fs.readFileSync(path.join(process.env.AGENT_PROMETHEUS_DIR, 'prometheus.crt')));
  assert.ok(cli.verify(ca.publicKey));
  assert.match(cli.subject, new RegExp(`CN=${PROMETHEUS_CLIENT_NAME}`));
  assert.ok(sdTokenOk(fs.readFileSync(path.join(process.env.AGENT_PROMETHEUS_DIR, 'sd-token'), 'utf8')));
  assert.ok(!sdTokenOk('nope'));

  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const req = parseCertRequest({ publicKey: spki, ips: ['10.0.0.5', 'fd00::5'], dns: ['web01.lan'], port: 9110 });
  assert.ok(!req.err, req.err);
  const c = issueAgentCert(pullRow.id, req);
  const x = new crypto.X509Certificate(c.certificate);
  assert.ok(x.verify(ca.publicKey));
  assert.ok(x.checkIP('10.0.0.5') && x.checkIP('fd00:0:0:0:0:0:0:5') && x.checkHost('web01.lan'));
  assert.ok(!x.checkIP('10.0.0.6'));
  assert.match(x.subject, new RegExp(`CN=${pullRow.id}`));

  // initAgentPki again keeps the same CA
  assert.equal(initAgentPki().caPem, s.caPem);
});

test('certificate requests are validated', () => {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.match(parseCertRequest({ publicKey: spki, ips: ['127.0.0.1'], port: 9110 }).err, /usable/);
  assert.match(parseCertRequest({ publicKey: spki, ips: [], dns: [], port: 9110 }).err, /At least one/);
  assert.match(parseCertRequest({ publicKey: spki, dns: ['bad name'], port: 9110 }).err, /DNS/);
  assert.match(parseCertRequest({ publicKey: spki, ips: ['10.0.0.1'], port: 0 }).err, /port/);
  assert.ok(parseCertRequest({ publicKey: rsa, ips: ['10.0.0.1'], port: 9110 }).err);
  assert.match(parseCertRequest({ publicKey: 'xx', ips: ['10.0.0.1'], port: 9110 }).err, /publicKey/);
});

test('diagnosis matrix: one reason per combination of signals', () => {
  const d = (x) => diagnoseAgent({ mode: 'push', address: '10.0.0.5', ...x }).code;
  assert.equal(d({ status: 'online', dataFresh: true }), 'healthy');
  assert.equal(d({ status: 'online', dataFresh: true, uptimeSeconds: 120 }), 'rebooted');
  assert.equal(d({ status: 'online', dataFresh: false }), 'data_path');
  assert.equal(d({ status: 'offline', ping: true }), 'agent_stopped');
  assert.equal(d({ status: 'offline', ping: false }), 'host_unreachable');
  assert.equal(d({ status: 'offline', ping: null }), 'no_heartbeat');
  assert.equal(d({ status: 'pending' }), 'pending');
  assert.equal(d({ status: 'pending', ping: false }), 'pending_unreachable');
  assert.equal(d({ status: 'blocked' }), 'blocked');
  const p = (x) => diagnoseAgent({ mode: 'pull', address: '10.0.0.5:9110', pull: { listening: true }, ...x }).code;
  assert.equal(p({ status: 'online', scrape: { up: 1 } }), 'healthy');
  assert.equal(p({ status: 'online', scrape: null }), 'pull_not_discovered');
  assert.equal(p({ status: 'online', pull: { listening: false, error: 'no cert' } }), 'pull_not_listening');
  assert.equal(p({ status: 'online', scrape: { up: 0, lastError: 'dial tcp 10.0.0.5:9110: i/o timeout' } }), 'pull_blocked');
  assert.equal(p({ status: 'online', port: false, scrape: { up: 0, lastError: '' } }), 'pull_blocked');
  assert.equal(p({ status: 'online', scrape: { up: 0, lastError: 'tls: bad certificate' } }), 'pull_tls');
  assert.equal(p({ status: 'online', scrape: { up: 0, lastError: 'server returned HTTP status 500' } }), 'pull_scrape_failed');
  assert.equal(p({ status: 'online', pull: { listening: true, refused: 4 }, scrape: { up: 0, lastError: 'Get "https://10.0.0.5:9110/metrics": EOF' } }), 'pull_allow');
  assert.equal(p({ status: 'offline', scrape: { up: 1 } }), 'heartbeat_blocked');
  assert.equal(p({ status: 'offline', port: true, scrape: { up: 0 } }), 'agent_stopped');
  const ev = diagnoseAgent({ mode: 'pull', status: 'online', ping: true, port: true, scrape: { up: 1 }, pull: { listening: true } }).evidence;
  assert.deepEqual(ev.map((e) => e.signal), ['heartbeat', 'ping', 'pull port', 'Prometheus scrape']);
});
