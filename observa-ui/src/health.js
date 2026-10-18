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

// ---------------- ObservaOne Agent status ----------------
// One set of rules for the API, the Agents page and Infrastructure. Every time is the SERVER's time of
// receipt (the agent's own clock is never used to decide a state).
//
//   blocked        an admin blocked the agent
//   pending        enrolled, no heartbeat received yet
//   online         heartbeat within onlineSeconds and nothing wrong
//   attention      heartbeat within onlineSeconds, but a real problem is reported (see agentProblems)
//   not_reporting  no heartbeat for more than onlineSeconds (the host itself may still be fine)
//   offline        no heartbeat for more than offlineSeconds
// Agents installed before heartbeats existed (version 1.0, Windows, Docker, Kubernetes) are judged by their
// last data upload instead (lastDataMs).
export function agentStatus({ nowMs, blocked, lastHeartbeatMs, lastDataMs, problems = [], onlineSeconds, offlineSeconds }) {
  if (blocked) return { status: 'blocked', ageSeconds: null, reason: 'Blocked by an administrator: uploads and heartbeats are refused.' };
  const last = lastHeartbeatMs || lastDataMs || null;
  if (!last) return { status: 'pending', ageSeconds: null, reason: 'Enrolled. Waiting for the first heartbeat.' };
  const ageSeconds = Math.max(0, Math.round((nowMs - last) / 1000)); // never negative, whatever the clocks say
  const what = lastHeartbeatMs ? 'heartbeat' : 'data';
  if (ageSeconds <= onlineSeconds) {
    return problems.length ? { status: 'attention', ageSeconds, reason: problems.join(' ') } : { status: 'online', ageSeconds, reason: '' };
  }
  if (ageSeconds <= offlineSeconds) {
    return { status: 'not_reporting', ageSeconds, reason: `No ${what} for ${fmtAge(ageSeconds)}. The host may still be running; the agent or the network may have stopped.` };
  }
  return { status: 'offline', ageSeconds, reason: `No ${what} for ${fmtAge(ageSeconds)}.` };
}

// Problems an agent reports in its heartbeat, plus what the server knows (version, data path).
// Only real, current problems: an empty list means healthy.
export function agentProblems({ version, minVersion, diag = {}, nowMs, lastDataMs, lastHeartbeatMs, onlineSeconds }) {
  const out = [];
  if (version && minVersion && compareVersions(version, minVersion) < 0) out.push(`Agent ${version} is no longer supported (${minVersion} or newer is needed). Re-run the installer.`);
  const c = diag.collectors || {};
  const errs = diag.collectorErrors || {};
  // "error" = the collector is broken; "unavailable" (permission, not supported here) is shown but is not a fault
  const failing = Object.keys(c).filter((k) => c[k] === 'error' || c[k] === 'failed' || c[k] === 'stopped').sort();
  for (const k of failing) out.push(`Collector ${k} is failing${errs[k] ? `: ${errs[k]}` : ''}.`);
  if (Number(diag.droppedPayloads) > 0 && Number(diag.bufferedPayloads) > 0) out.push(`Upload backlog: ${diag.bufferedPayloads} collections waiting, ${diag.droppedPayloads} dropped (buffer full).`);
  if (Number(diag.uploadFailures) > 0) out.push(`${diag.uploadFailures} uploads failed since the last heartbeat.`);
  // heartbeat fine but no data arriving = the data path (Nginx/Prometheus/token) is broken, not the agent
  if (lastHeartbeatMs && nowMs - lastHeartbeatMs <= onlineSeconds * 1000 && diag.collectors && (!lastDataMs || nowMs - lastDataMs > 3 * onlineSeconds * 1000)) {
    out.push('Heartbeats arrive but no metrics have been received recently.');
  }
  if (diag.lastError) out.push(`Agent reports: ${diag.lastError}`);
  return out;
}

export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0), pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  return 0;
}

// Counter delta that survives restarts: a counter that went down was reset, so the new value is the delta.
export function counterDelta(prev, cur) {
  if (!Number.isFinite(cur) || cur < 0) return null;
  if (!Number.isFinite(prev) || prev < 0) return 0; // first sample: nothing to compare yet
  return cur >= prev ? cur - prev : cur;
}

function fmtAge(s) {
  if (s < 120) return `${s} s`;
  if (s < 7200) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
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
