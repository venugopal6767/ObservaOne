// The ObservaOne agent CA: certificates for pull mode.
//
//   - agent server certificates: issued to an enrolled agent (authenticated by its credential) for the
//     addresses it reports; the agent makes its own key and sends only the public key.
//   - the Prometheus client certificate: Prometheus presents it when it scrapes agents; agents accept
//     only this CA and only the name below, so nobody else can read their metrics.
//
// X.509 is written here directly (DER, ECDSA P-256 + SHA-256) with node:crypto, so no extra package is
// needed. Files live in AGENT_PKI_DIR (default <DATA_DIR>/agent-pki); the CA key never leaves it.
// For Prometheus the CA certificate, its client certificate + key and the service-discovery token are
// copied to AGENT_PROMETHEUS_DIR (a volume shared with the Prometheus container).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { config } from './config.js';

export const PROMETHEUS_CLIENT_NAME = 'observaone-prometheus';
export const AGENT_CERT_DAYS = 90;
const CA_DAYS = 3650;
const CLIENT_DAYS = 365;

// ---------------- DER ----------------
const len = (n) => (n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x82, n >> 8, n & 255]) : Buffer.from([0x83, n >> 16, (n >> 8) & 255, n & 255]));
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...p) => tlv(0x30, Buffer.concat(p));
const set = (...p) => tlv(0x31, Buffer.concat(p));
const explicit = (n, body) => tlv(0xa0 + n, body);
const int = (buf) => tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const octets = (b) => tlv(0x04, b);
const bits = (b, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), b]));
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
function oid(s) {
  const a = s.split('.').map(Number);
  const out = [40 * a[0] + a[1]];
  for (const v of a.slice(2)) {
    const tmp = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) tmp.unshift((x & 0x7f) | 0x80);
    out.push(...tmp);
  }
  return tlv(0x06, Buffer.from(out));
}
function time(d) { // UTCTime until 2049, GeneralizedTime after (RFC 5280)
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2))) : tlv(0x18, Buffer.from(iso));
}

const OID = {
  ecdsaSha256: '1.2.840.10045.4.3.2', cn: '2.5.4.3', o: '2.5.4.10',
  basic: '2.5.29.19', keyUsage: '2.5.29.15', eku: '2.5.29.37', san: '2.5.29.17', ski: '2.5.29.14', aki: '2.5.29.35',
  serverAuth: '1.3.6.1.5.5.7.3.1', clientAuth: '1.3.6.1.5.5.7.3.2',
};
const name = (cn) => seq(set(seq(oid(OID.o), utf8('ObservaOne'))), set(seq(oid(OID.cn), utf8(cn))));
const ext = (id, critical, value) => (critical ? seq(oid(id), bool(true), octets(value)) : seq(oid(id), octets(value)));
const keyId = (spkiDer) => {
  // SHA-1 of the subjectPublicKey BIT STRING contents (RFC 5280 4.2.1.2 method 1)
  const k = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' }).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha1').update(k.subarray(k.length - 65)).digest(); // P-256: last 65 bytes = 04||X||Y
};

export function sanEntries({ ips = [], dns = [] }) {
  const parts = [];
  for (const d of dns) parts.push(tlv(0x82, Buffer.from(d, 'ascii')));
  for (const ip of ips) {
    if (net.isIPv4(ip)) parts.push(tlv(0x87, Buffer.from(ip.split('.').map(Number))));
    else if (net.isIPv6(ip)) parts.push(tlv(0x87, ipv6Bytes(ip)));
  }
  return seq(...parts);
}
function ipv6Bytes(ip) {
  let [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [], t = tail !== undefined ? (tail ? tail.split(':') : []) : null;
  const groups = t === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return Buffer.from(groups.flatMap((g) => { const v = parseInt(g, 16); return [v >> 8, v & 255]; }));
}

// Build and sign one certificate. spkiDer: subject public key; issuer: { name, key, ski } or null (self-signed).
export function issueCert({ cn, spkiDer, days, ca = false, usage, ips, dns, issuer, signKey, notBefore = new Date(Date.now() - 5 * 60_000) }) {
  const serial = crypto.randomBytes(16); serial[0] &= 0x7f; serial[0] |= 0x01;
  const notAfter = new Date(notBefore.getTime() + days * 86_400_000 + 5 * 60_000);
  const ski = keyId(spkiDer);
  const exts = [
    ext(OID.basic, true, ca ? seq(bool(true), int(Buffer.from([0]))) : seq()),
    ext(OID.keyUsage, true, ca ? bits(Buffer.from([0x06]), 1) : bits(Buffer.from([0x80]), 7)),
    ext(OID.ski, false, octets(ski)),
  ];
  if (!ca) exts.push(ext(OID.eku, false, seq(oid(usage === 'client' ? OID.clientAuth : OID.serverAuth))));
  if (ips?.length || dns?.length) exts.push(ext(OID.san, false, sanEntries({ ips, dns })));
  if (issuer) exts.push(ext(OID.aki, false, seq(tlv(0x80, issuer.ski))));
  const sigAlg = seq(oid(OID.ecdsaSha256));
  const tbs = seq(
    explicit(0, int(Buffer.from([2]))), int(serial), sigAlg,
    issuer ? issuer.name : name(cn),
    seq(time(notBefore), time(notAfter)),
    name(cn), spkiDer, explicit(3, seq(...exts)),
  );
  const sig = crypto.sign('sha256', tbs, signKey);
  const der = seq(tbs, sigAlg, bits(sig));
  return { der, pem: toPem(der), notAfter, serial: serial.toString('hex') };
}

const toPem = (der) => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;

// ---------------- the CA on disk ----------------
let state = null;

const pkiDir = () => config.agent.pkiDir || path.join(config.dataDir, 'agent-pki');

function writeSecret(file, data, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

function genKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey, spki: publicKey.export({ type: 'spki', format: 'der' }) };
}

function needsNew(certPem, minDaysLeft) {
  try {
    const x = new crypto.X509Certificate(certPem);
    return new Date(x.validTo).getTime() - Date.now() < minDaysLeft * 86_400_000;
  } catch { return true; }
}

// Create (first start) or load the CA, the Prometheus client certificate and the SD token.
export function initAgentPki() {
  const dir = pkiDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = (n) => path.join(dir, n);
  let caKey, caPem;
  if (fs.existsSync(f('ca.key')) && fs.existsSync(f('ca.crt'))) {
    caKey = crypto.createPrivateKey(fs.readFileSync(f('ca.key')));
    caPem = fs.readFileSync(f('ca.crt'), 'utf8');
  } else {
    const k = genKey();
    const id = crypto.randomBytes(3).toString('hex');
    caKey = k.privateKey;
    caPem = issueCert({ cn: `ObservaOne Agent CA ${id}`, spkiDer: k.spki, days: CA_DAYS, ca: true, signKey: caKey }).pem;
    writeSecret(f('ca.key'), k.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeSecret(f('ca.crt'), caPem, 0o644);
    console.log('[agent-pki] created the agent CA in', dir);
  }
  const caX = new crypto.X509Certificate(caPem);
  const caDer = caX.raw;
  const caSpki = caX.publicKey.export({ type: 'spki', format: 'der' });
  const issuer = { name: subjectOf(caDer), ski: keyId(caSpki), key: caKey };

  // Prometheus client certificate (renewed when less than 30 days are left)
  let cliPem = fs.existsSync(f('prometheus.crt')) ? fs.readFileSync(f('prometheus.crt'), 'utf8') : '';
  if (!cliPem || !fs.existsSync(f('prometheus.key')) || needsNew(cliPem, 30) || !signedBy(cliPem, caX)) {
    const k = genKey();
    cliPem = issueCert({ cn: PROMETHEUS_CLIENT_NAME, spkiDer: k.spki, days: CLIENT_DAYS, usage: 'client', issuer, signKey: caKey }).pem;
    writeSecret(f('prometheus.key'), k.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeSecret(f('prometheus.crt'), cliPem, 0o644);
  }
  if (!fs.existsSync(f('sd-token'))) writeSecret(f('sd-token'), crypto.randomBytes(32).toString('base64url'));
  const sdToken = fs.readFileSync(f('sd-token'), 'utf8').trim();
  state = { caPem, caX, issuer, sdToken, dir };
  exportForPrometheus();
  return state;
}

function subjectOf(certDer) {
  // tbsCertificate fields: [0]version, serial, sigAlg, issuer, validity, subject -> return subject DER
  const r = readTlv(certDer, 0); const tbs = readTlv(certDer, r.start);
  let p = tbs.start; const fields = [];
  while (p < tbs.end && fields.length < 6) { const t = readTlv(certDer, p); fields.push(certDer.subarray(p, t.end)); p = t.end; }
  return fields[5];
}
function readTlv(b, p) {
  let l = b[p + 1], start = p + 2;
  if (l & 0x80) { const n = l & 0x7f; l = 0; for (let i = 0; i < n; i++) l = (l << 8) | b[p + 2 + i]; start = p + 2 + n; }
  return { start, end: start + l };
}
function signedBy(pem, caX) {
  try { return new crypto.X509Certificate(pem).verify(caX.publicKey); } catch { return false; }
}

// Copy what Prometheus needs into the shared folder. Prometheus re-reads these files on every scrape/refresh.
export function exportForPrometheus() {
  const out = config.agent.prometheusDir;
  if (!out || !state) return false;
  try {
    fs.mkdirSync(out, { recursive: true });
    const copy = (from, to, mode) => {
      const data = fs.readFileSync(path.join(state.dir, from));
      const dst = path.join(out, to);
      if (fs.existsSync(dst) && fs.readFileSync(dst).equals(data)) return;
      writeSecret(dst, data, mode);
      // Prometheus runs as "nobody" (65534): the folder is setgid 65534 (docker-entrypoint.sh), so 0640 files are
      // readable by Prometheus and nobody else. Running as root (lab, tests): set the group directly.
      if (mode === 0o640 && process.getuid?.() === 0) { try { fs.chownSync(dst, 0, 65534); } catch { /* not supported */ } }
    };
    copy('ca.crt', 'ca.crt', 0o644);
    copy('prometheus.crt', 'prometheus.crt', 0o644);
    copy('prometheus.key', 'prometheus.key', 0o640);
    copy('sd-token', 'sd-token', 0o640);
    return true;
  } catch (e) {
    console.error('[agent-pki] cannot write the Prometheus files to', out, e.message);
    return false;
  }
}

export function pkiState() { return state || initAgentPki(); }

export function sdTokenOk(tokenGiven) {
  const s = pkiState();
  const a = Buffer.from(String(tokenGiven || '')), b = Buffer.from(s.sdToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------- agent server certificates ----------------
const DNS_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

// Validate what the agent asked for. Returns { spki, ips, dns } or { err }.
export function parseCertRequest(b) {
  if (!b || typeof b !== 'object') return { err: 'Body must be a JSON object.' };
  let spki;
  try {
    const raw = Buffer.from(String(b.publicKey || ''), 'base64');
    if (raw.length < 50 || raw.length > 200) throw new Error('size');
    const k = crypto.createPublicKey({ key: raw, format: 'der', type: 'spki' });
    if (k.asymmetricKeyType !== 'ec' || k.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return { err: 'publicKey must be an ECDSA P-256 key.' };
    spki = k.export({ type: 'spki', format: 'der' });
  } catch { return { err: 'publicKey must be a base64 DER (SPKI) public key.' }; }
  const ips = Array.isArray(b.ips) ? b.ips : [], dns = Array.isArray(b.dns) ? b.dns : [];
  if (ips.length > 8 || dns.length > 4) return { err: 'At most 8 IP addresses and 4 names.' };
  for (const ip of ips) if (typeof ip !== 'string' || !net.isIP(ip) || ip.startsWith('127.') || ip === '::1') return { err: `Not a usable IP address: ${String(ip).slice(0, 50)}` };
  for (const d of dns) if (typeof d !== 'string' || !DNS_RE.test(d) || d === 'localhost') return { err: `Not a valid DNS name: ${String(d).slice(0, 50)}` };
  if (!ips.length && !dns.length) return { err: 'At least one address is needed.' };
  const port = Number(b.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { err: 'port must be 1..65535.' };
  return { spki, ips: [...new Set(ips)], dns: [...new Set(dns.map((d) => d.toLowerCase()))], port };
}

export function issueAgentCert(agentId, { spki, ips, dns }) {
  const s = pkiState();
  const c = issueCert({ cn: agentId, spkiDer: spki, days: AGENT_CERT_DAYS, usage: 'server', ips, dns, issuer: s.issuer, signKey: s.issuer.key });
  return { certificate: c.pem, ca: s.caPem, clientName: PROMETHEUS_CLIENT_NAME, notAfter: c.notAfter.toISOString(), serial: c.serial };
}

// node src/agentpki.js : create / renew the files and exit (docker compose service agent-pki-init)
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const s = initAgentPki();
  console.log(`[agent-pki] ready in ${s.dir}${config.agent.prometheusDir ? `; Prometheus files in ${config.agent.prometheusDir}` : ''}`);
}
