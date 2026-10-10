// Health rules, kept free of I/O so they can be unit-tested (tests/health.test.js).
// The rule everywhere: a status needs evidence. Missing data is "unknown", never "healthy",
// never "down", never 0.

// One application service from its request rate (rps), error rate (%) and p95 latency (ms).
// Any of the three may be null (not reported).
export function classifyService(s, t) {
  // Zero requests: no traffic. Not down, and error rate / latency mean nothing without requests.
  if (!s.rps) return { ...s, rps: s.rps ?? 0, errorRate: null, p95: null, status: 'no_traffic' };
  const e = s.errorRate, p = s.p95;
  const status = (e !== null && e >= t.downErrorRate) || (p !== null && p >= t.downP95Ms) ? 'down'
    : (e !== null && e >= t.degradedErrorRate) || (p !== null && p >= t.degradedP95Ms) ? 'degraded' : 'healthy';
  return { ...s, status };
}

// Totals for a list of classified services. No traffic at all = no error rate (null), never 0%.
export function summarizeServices(list) {
  const totalRps = list.reduce((a, s) => a + (s.rps || 0), 0);
  const weightedErr = totalRps ? list.reduce((a, s) => a + (s.rps || 0) * (s.errorRate || 0), 0) / totalRps : null;
  return {
    total: list.length,
    healthy: list.filter((s) => s.status === 'healthy').length,
    degraded: list.filter((s) => s.status === 'degraded').length,
    down: list.filter((s) => s.status === 'down').length,
    noTraffic: list.filter((s) => s.status === 'no_traffic').length,
    totalRps,
    errorRate: weightedErr,
  };
}

// A host that sends through the ObservaOne Agent.
//   lastSeenSec: when we last got data; upValue: what the agent said about its local exporter.
// Silent agent = "not_reporting" (the host may be fine; the agent or network may have stopped).
// "down" only when the agent itself reports the exporter as down.
export function agentHostHealth({ nowSec, lastSeenSec, upValue, onlineSeconds }) {
  const stale = !lastSeenSec || nowSec - lastSeenSec > onlineSeconds;
  if (stale) return { health: 'not_reporting', reason: 'The agent stopped sending data' };
  return upValue ? { health: 'up', reason: '' } : { health: 'down', reason: 'The agent cannot read the local exporter' };
}
