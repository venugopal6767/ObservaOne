// Prometheus HTTP service discovery for ObservaOne Agents.
//
//   GET /api/v1/sd/agents?kind=pull   agents in pull mode -> scrape targets (job observaone-agents)
//   GET /api/v1/sd/agents?kind=ping   every enrolled agent's address -> blackbox ICMP probe
//   GET /api/v1/sd/agents?kind=port   pull agents' address:port -> blackbox TCP probe
//
// Prometheus authenticates with the token in AGENT_PROMETHEUS_DIR/sd-token (Authorization: Bearer).
// Identity labels (host, agent_id, env, role, custom labels) come from the database, so a rename on the
// Agents page or a new IP address reported in a heartbeat reaches Prometheus at the next refresh (30 s).
import express from 'express';
import net from 'node:net';
import { q } from '../db.js';
import { sdTokenOk } from '../agentpki.js';
import { rateLimited } from './agent-control.js';
import { clientIp } from '../store.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const hostPort = (h, port) => (net.isIPv6(h) ? `[${h}]:${port}` : `${h}:${port}`);

// The address Prometheus (and the probes) should use for this agent. Only addresses the agent reported
// for itself are used for pull, because its certificate covers exactly those.
export function agentAddress(a) {
  const pull = a.pull || {};
  if (a.mode === 'pull' && pull.port) {
    if (pull.dns?.length) return { host: pull.dns[0], port: pull.port, why: 'pull.advertise' };
    const ips = pull.ips || [];
    if (a.ip && ips.includes(a.ip)) return { host: a.ip, port: pull.port, why: 'address the server sees, also on the host' };
    if (ips.length) return { host: ips[0], port: pull.port, why: 'first address of the host (the server sees another one: NAT or proxy)' };
    return null;
  }
  // push agents: probe the address the heartbeats come from, if it is one of the host's own addresses;
  // otherwise (NAT, proxy) the first reported address
  const own = Array.isArray(a.addresses) ? a.addresses : [];
  if (a.ip && (own.includes(a.ip) || !own.length) && net.isIP(a.ip)) return { host: a.ip, port: null, why: 'heartbeat source' };
  if (own.length) return { host: own[0], port: null, why: 'first address of the host' };
  return null;
}

export function sdLabels(a) {
  const l = { host: a.host, agent_id: a.id, platform: a.platform, os: 'linux', agent: 'observaone', job: a.platform };
  if (a.env) l.env = a.env;
  if (a.role) l.role = a.role;
  for (const [k, v] of Object.entries(a.labels || {})) if (!(k in l)) l[k] = String(v);
  return l;
}

export function sdGroups(rows, kind) {
  const out = [];
  for (const a of rows) {
    if (!a.credential_hash || a.blocked) continue;
    const addr = agentAddress(a);
    if (!addr) continue;
    if (kind === 'pull' || kind === 'port') {
      if (a.mode !== 'pull' || !addr.port) continue;
      const labels = sdLabels(a);
      if (kind === 'port') { delete labels.job; labels.probe = 'tcp'; }
      out.push({ targets: [hostPort(addr.host, addr.port)], labels });
    } else {
      const labels = sdLabels(a);
      delete labels.job;
      labels.probe = 'icmp';
      out.push({ targets: [addr.host], labels });
    }
  }
  return out;
}

export const agentSdRouter = express.Router();

agentSdRouter.get('/v1/sd/agents', wrap(async (req, res) => {
  // Only Prometheus inside the stack calls this, directly. Anything that came through the reverse proxy (it adds
  // forwarding headers) is from outside: answer as if the path did not exist (Nginx also blocks it).
  if (req.get('x-forwarded-for') || req.get('x-forwarded-proto') || req.get('x-real-ip')) return res.status(404).json({ error: 'Not found.' });
  const tok = (/^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '') || [])[1] || '';
  if (!sdTokenOk(tok)) {
    if (rateLimited(`sdfail:${clientIp(req)}`, 30, 60_000)) { res.set('Retry-After', '60'); return res.status(429).json({ error: 'Too many failed requests.' }); }
    return res.status(401).json({ error: 'Service discovery token missing or wrong.' });
  }
  const kind = ['pull', 'ping', 'port'].includes(req.query.kind) ? req.query.kind : 'pull';
  const { rows } = await q(`SELECT id, host, platform, env, role, labels, ip, mode, pull, addresses, blocked, credential_hash
                            FROM agents WHERE credential_hash IS NOT NULL AND NOT blocked ORDER BY host`);
  res.set('Cache-Control', 'no-store');
  res.json(sdGroups(rows, kind));
}));
