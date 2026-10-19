// Signals from outside the agent, for the diagnosis (health.js diagnoseAgent):
//   - Prometheus scrape state of pull-mode agents (targets API: health + last error)
//   - blackbox probes: ICMP ping of every agent's address, TCP connect to pull ports
// One Prometheus round-trip set per 15 s for the whole fleet, whatever the number of page views.
// Anything that cannot be read is "not measured" (null), never "down".
import { prom, promInstant } from './datasources.js';
import { diagnoseAgent } from './health.js';
import { agentAddress } from './routes/agent-sd.js';

let cache = { at: 0, data: null, pending: null };
const TTL = 15_000;

async function byAgent(query) {
  try {
    const r = await promInstant(query);
    return new Map(r.map((x) => [x.metric.agent_id, Number(x.value[1]) === 1]));
  } catch {
    return new Map();
  }
}

async function scrapeTargets() {
  try {
    const d = await prom('/api/v1/targets', { state: 'active', scrapePool: 'observaone-agents' });
    const m = new Map();
    for (const t of d.activeTargets || []) {
      const id = t.labels?.agent_id;
      if (!id) continue;
      m.set(id, { up: t.health === 'up' ? 1 : t.health === 'down' ? 0 : null, lastError: t.lastError || '', lastScrape: t.lastScrape || null, url: t.scrapeUrl || '' });
    }
    return m;
  } catch {
    return new Map();
  }
}

export async function fleetSignals() {
  if (cache.data && Date.now() - cache.at < TTL) return cache.data;
  if (cache.pending) return cache.pending;
  cache.pending = (async () => {
    const [ping, port, scrape] = await Promise.all([
      byAgent('probe_success{agent="observaone",probe="icmp"}'),
      byAgent('probe_success{agent="observaone",probe="tcp"}'),
      scrapeTargets(),
    ]);
    const data = { ping, port, scrape };
    cache = { at: Date.now(), data, pending: null };
    return data;
  })().catch((e) => { cache.pending = null; throw e; });
  return cache.pending;
}

export function resetFleetSignals() { cache = { at: 0, data: null, pending: null }; }

// row: agents table row; d: describeAgent(row); s: fleetSignals()
export function diagnosisFor(row, d, s, { nowMs = Date.now(), onlineSeconds }) {
  const addr = agentAddress(row);
  const lastData = row.last_seen ? new Date(row.last_seen).getTime() : null;
  const mode = row.mode || 'push';
  const scrape = s.scrape.get(row.id) || null;
  return diagnoseAgent({
    status: d.status,
    mode,
    dataFresh: mode === 'push' && row.credential_hash ? !!(lastData && nowMs - lastData <= 3 * onlineSeconds * 1000) : null,
    scrape: mode === 'pull' ? scrape : null,
    ping: s.ping.has(row.id) ? s.ping.get(row.id) : null,
    port: mode === 'pull' && s.port.has(row.id) ? s.port.get(row.id) : null,
    pull: row.pull || {},
    uptimeSeconds: row.diag?.uptimeSeconds ?? null,
    address: addr ? (addr.port ? `${addr.host}:${addr.port}` : addr.host) : null,
  });
}
