// Sample data for the Security Team dashboard: detections, sign-ins, vulnerabilities, hosts, certificates.
// IP addresses come only from the ranges reserved for documentation (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24).
import { rng, hash, between, int, pick } from './mock.js';

export const CATEGORIES = [['auth', 'Sign-in'], ['network', 'Network'], ['host', 'Host'], ['config', 'Configuration'], ['data', 'Data access']];
const RULES = [
  { rule: 'Many failed sign-ins from one address', cat: 'auth', sev: 'high', technique: 'Password guessing' },
  { rule: 'Sign-in from a new country', cat: 'auth', sev: 'medium', technique: 'Use of stolen credentials' },
  { rule: 'Admin role granted outside change window', cat: 'config', sev: 'high', technique: 'Privilege change' },
  { rule: 'Port scan detected', cat: 'network', sev: 'medium', technique: 'Network discovery' },
  { rule: 'Unexpected outbound connection', cat: 'network', sev: 'high', technique: 'Command and control' },
  { rule: 'Shell started inside a container', cat: 'host', sev: 'critical', technique: 'Command execution' },
  { rule: 'SSH password sign-in (keys only expected)', cat: 'host', sev: 'medium', technique: 'Remote access' },
  { rule: 'Large export from orders database', cat: 'data', sev: 'high', technique: 'Data collection' },
  { rule: 'MFA turned off for a user', cat: 'config', sev: 'high', technique: 'Weakened defences' },
  { rule: 'Storage bucket made public', cat: 'config', sev: 'critical', technique: 'Data exposure' },
];
const IPS = [...Array.from({ length: 6 }, (_, i) => `203.0.113.${17 + i * 23}`), ...Array.from({ length: 5 }, (_, i) => `198.51.100.${9 + i * 31}`), ...Array.from({ length: 4 }, (_, i) => `192.0.2.${40 + i * 19}`)];
const COUNTRIES = ['Netherlands', 'United States', 'Brazil', 'Singapore', 'Germany', 'India', 'Romania', 'Vietnam'];
export const HOSTS = ['web-01', 'web-02', 'web-07', 'api-03', 'db-01', 'db-02', 'cache-01', 'bastion-01', 'k8s-node-04', 'k8s-node-11'];
const USERS = ['a.kumar', 'j.smith', 'm.garcia', 'svc-backup', 'l.chen', 'r.patel', 'admin', 'svc-reports'];
const PKGS = [['openssl', '3.0.13', '3.0.15'], ['glibc', '2.35-0ubuntu3.6', '2.35-0ubuntu3.8'], ['log4j-core', '2.17.0', '2.17.2'], ['nginx', '1.24.0', '1.26.2'], ['jackson-databind', '2.13.4', '2.15.4'], ['sudo', '1.9.9', '1.9.15'], ['curl', '8.4.0', '8.9.1'], ['openssh-server', '8.9p1', '9.8p1'], ['libxml2', '2.9.13', '2.12.7'], ['python3-urllib3', '1.26.5', '1.26.19']];

const STORE_KEY = 'oo.sec.state.v1';
let mem = null;
function store() {
  if (mem) return mem;
  try { mem = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null'); } catch { mem = null; }
  mem ||= { events: {}, blocked: [] };
  return mem;
}
function save() { try { sessionStorage.setItem(STORE_KEY, JSON.stringify(mem)); } catch { /* not kept after reload */ } }

export function setEventStatus(id, status, by) { store().events[id] = { status, by, at: Date.now() }; save(); }
export function blockIp(ip) { const s = store(); if (!s.blocked.includes(ip)) s.blocked.push(ip); save(); }
export function isBlocked(ip) { return store().blocked.includes(ip); }

function ipInfo(ip) {
  const r = rng(`sec|ip|${ip}`);
  return { ip, country: pick(r, COUNTRIES), owner: pick(r, ['Hosting provider', 'Residential ISP', 'Cloud provider', 'VPN service', 'Mobile carrier']), reputation: ip.startsWith('203.') ? 'known bad' : ip.startsWith('198.') ? 'suspicious' : 'unknown' };
}

function allEvents(env, end) {
  const r = rng(`sec|events|${env}`);
  const now = end * 1000;
  const n = 90;
  return Array.from({ length: n }, (_, i) => {
    const def = RULES[Math.floor(Math.pow(r(), 1.4) * RULES.length)];
    const ip = pick(r, IPS);
    const at = now - Math.pow(r(), 1.3) * 7 * 86400_000;
    const id = `sev-${hash(`${env}|${i}`) % 900000 + 100000}`;
    const st = store().events[id];
    return {
      id, ...def, at, ip, host: def.cat === 'auth' ? 'sso' : pick(r, HOSTS), user: pick(r, USERS), count: def.cat === 'auth' ? int(r, 8, 420) : int(r, 1, 6),
      status: st?.status || (r() < 0.55 ? 'new' : r() < 0.6 ? 'investigating' : 'closed'), handledBy: st?.by || null, env: env || 'production',
    };
  }).sort((a, b) => b.at - a.at);
}

function hostsData(env) {
  return HOSTS.map((name) => {
    const r = rng(`sec|host|${env}|${name}`);
    const vulns = Array.from({ length: int(r, 0, 6) }, (_, i) => {
      const [pkg, have, fixed] = pick(r, PKGS);
      const sev = pick(r, ['critical', 'high', 'high', 'medium', 'medium', 'low']);
      return { id: `VULN-${hash(`${name}|${i}|${pkg}`) % 9000 + 1000}`, pkg, have, fixed, severity: sev, host: name, ageDays: int(r, 1, 120), exploitable: sev === 'critical' && r() < 0.6 };
    }).filter((v, i, a) => a.findIndex((x) => x.pkg === v.pkg) === i);
    const ports = name.startsWith('web') || name.startsWith('bastion') ? [443, ...(r() < 0.3 ? [22] : []), ...(r() < 0.15 ? [8080] : [])] : r() < 0.15 ? [5432] : [];
    const w = { critical: 30, high: 12, medium: 4, low: 1 };
    const risk = Math.min(100, vulns.reduce((s, v) => s + w[v.severity] * (v.exploitable ? 1.5 : 1), 0) + ports.filter((p) => p !== 443).length * 15);
    return { name, vulns, ports, exposed: ports.length > 0, risk: Math.round(risk), os: pick(r, ['Ubuntu 22.04', 'Ubuntu 24.04', 'RHEL 9', 'Windows Server 2022']), lastScan: Date.now() - between(r, 0.5, 30) * 3600_000 };
  }).sort((a, b) => b.risk - a.risk);
}

function certs(env) {
  const r = rng(`sec|certs|${env}`);
  return ['storefront.example.local', 'api.example.local', 'partner.example.local', 'sso.example.local', 'admin.example.local', 'grafana.example.local'].map((d, i) => ({ domain: d, days: i === 1 ? int(r, 4, 21) : int(r, 25, 200), issuer: pick(r, ['Internal CA', "Let's Encrypt", 'Commercial CA']) })).sort((a, b) => a.days - b.days);
}

export function securityData({ env, start, end, severity, category, empty = false }) {
  if (empty) return { events: [], hosts: [], certs: [], buckets: [], topIps: [], kpi: {} };
  const events = allEvents(env, end).filter((e) => (!severity || e.severity === severity || e.sev === severity) && (!category || e.cat === category));
  const inRange = events.filter((e) => e.at >= start * 1000);
  const hosts = hostsData(env);
  const vulns = hosts.flatMap((h) => h.vulns);
  // events over the selected range, 24 buckets
  const step = (end - start) / 24;
  const buckets = Array.from({ length: 24 }, (_, i) => {
    const from = (start + i * step) * 1000, to = from + step * 1000;
    const b = inRange.filter((e) => e.at >= from && e.at < to);
    return { from, to, critical: b.filter((e) => e.sev === 'critical').length, high: b.filter((e) => e.sev === 'high').length, medium: b.filter((e) => e.sev === 'medium').length };
  });
  const byIp = {};
  for (const e of inRange) byIp[e.ip] = (byIp[e.ip] || 0) + e.count;
  const topIps = Object.entries(byIp).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([ip, n]) => ({ ...ipInfo(ip), count: n, blocked: isBlocked(ip) }));
  const failed = inRange.filter((e) => e.cat === 'auth').reduce((s, e) => s + e.count, 0);
  return {
    events: inRange, allEvents: events, hosts, certs: certs(env), buckets, topIps, vulns,
    kpi: {
      events: inRange.length, critical: inRange.filter((e) => e.sev === 'critical').length, open: inRange.filter((e) => e.status !== 'closed').length,
      failedSignins: failed, locked: Math.floor(failed / 120),
      vulnCritical: vulns.filter((v) => v.severity === 'critical').length, vulnHigh: vulns.filter((v) => v.severity === 'high').length,
      exposed: hosts.filter((h) => h.ports.some((p) => p !== 443)).length,
      certsSoon: certs(env).filter((c) => c.days <= 30).length,
      privileged: inRange.filter((e) => e.cat === 'config').length,
    },
  };
}

export function eventDetail({ env, end }, id) {
  const all = allEvents(env, end);
  const e = all.find((x) => x.id === id);
  if (!e) return null;
  return { e, ip: { ...ipInfo(e.ip), blocked: isBlocked(e.ip) }, related: all.filter((x) => x.ip === e.ip && x.id !== id).slice(0, 8), host: hostsData(env).find((h) => h.name === e.host) || null };
}
export function hostDetail({ env, end }, name) {
  const host = hostsData(env).find((h) => h.name === name);
  return host ? { host, events: allEvents(env, end).filter((e) => e.host === name).slice(0, 10) } : null;
}
export function ipDetail({ env, end }, ip) {
  if (!IPS.includes(ip)) return null;
  const events = allEvents(env, end).filter((e) => e.ip === ip);
  return { info: { ...ipInfo(ip), blocked: isBlocked(ip) }, events, users: [...new Set(events.filter((e) => e.cat === 'auth').map((e) => e.user))] };
}
