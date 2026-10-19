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
  if (Number(diag.diskBuffered) > 0) out.push(`${diag.diskBuffered} collections waiting in the disk buffer (they are sent oldest first once uploads work).`);
  // heartbeat fine but no data arriving = the data path (Nginx/Prometheus/token) is broken, not the agent.
  // (pull mode: the agent uploads nothing; whether Prometheus scrapes it is judged by diagnoseAgent)
  if (diag.mode !== 'pull' && lastHeartbeatMs &&nowMs - lastHeartbeatMs <= onlineSeconds * 1000 && diag.collectors && (!lastDataMs || nowMs - lastDataMs > 3 * onlineSeconds * 1000)) {
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

// ---------------- diagnosis: WHY an agent looks the way it does ----------------
// Combines what the agent says (heartbeat), what the data path shows (push uploads / Prometheus scrapes)
// and what the server can see from outside (blackbox ping + TCP to the pull port). Each signal may be
// missing (null = not measured); a conclusion is only drawn from signals that exist.
//
//   status          from agentStatus (online / attention / not_reporting / offline / pending / blocked)
//   mode            push | pull
//   dataFresh       push: an upload arrived recently (true/false)
//   scrape          pull: { up: 1|0, lastError } from Prometheus (null = not discovered yet)
//   ping, port      blackbox results: true / false / null (no probe)
//   pull            what the agent reported about its endpoint { listening, error, lastScrapeAgoSeconds }
//   uptimeSeconds   from the last heartbeat
//   address         where the server looks for the host (for the messages)
// -> { code, severity: ok|info|warning|critical, title, detail, evidence: [{ signal, value, ok }] }
export function diagnoseAgent(x) {
  const ev = [];
  const sig = (signal, value, ok) => ev.push({ signal, value, ok });
  const addr = x.address || 'the host';
  const hbFresh = x.status === 'online' || x.status === 'attention';
  sig('heartbeat', x.status === 'pending' ? 'none yet' : hbFresh ? 'arriving' : x.status === 'blocked' ? 'refused (blocked)' : 'missing', hbFresh);
  if (x.ping != null) sig('ping', x.ping ? 'answers' : 'no answer', !!x.ping);
  if (x.mode === 'pull') {
    if (x.port != null) sig('pull port', x.port ? 'open' : 'closed / filtered', !!x.port);
    if (x.scrape) sig('Prometheus scrape', x.scrape.up === 1 ? 'ok' : x.scrape.lastError || 'failing', x.scrape.up === 1);
    else sig('Prometheus scrape', 'not discovered yet', null);
  } else if (x.dataFresh != null) {
    sig('metric uploads', x.dataFresh ? 'arriving' : 'missing', !!x.dataFresh);
  }
  const out = (code, severity, title, detail) => ({ code, severity, title, detail, evidence: ev });
  const rebooted = x.uptimeSeconds != null && x.uptimeSeconds < 900;
  const healthy = (what) => (rebooted
    ? out('rebooted', 'info', 'Healthy, rebooted recently', `The host started ${Math.max(1, Math.round(x.uptimeSeconds / 60))} min ago.`)
    : out('healthy', 'ok', 'Healthy', what));

  if (x.status === 'blocked') return out('blocked', 'info', 'Blocked', 'An administrator blocked this agent: its uploads and heartbeats are refused.');
  if (x.status === 'pending') {
    if (x.ping === false) return out('pending_unreachable', 'warning', 'Enrolled, host not reachable', `No heartbeat yet and ${addr} does not answer ping. Check that the service started: systemctl status observaone-agent.`);
    return out('pending', 'info', 'Waiting for the first heartbeat', 'Enrolled. The first heartbeat arrives within a minute of the service starting.');
  }

  if (hbFresh) {
    if (x.mode === 'pull') {
      const p = x.pull || {};
      if (p.listening === false) return out('pull_not_listening', 'critical', 'Pull endpoint not running', p.error ? `The agent reports: ${p.error}` : 'The agent has not opened its pull port yet (it waits for its certificate).');
      if (x.scrape && x.scrape.up === 1) return healthy('Heartbeats arrive and Prometheus scrapes the agent.');
      if (!x.scrape) return out('pull_not_discovered', 'warning', 'Not scraped yet', 'Prometheus has not picked this agent up. Discovery refreshes every 30 s; if this stays, check the observaone-agents job in prometheus.yml.');
      const err = String(x.scrape.lastError || '');
      if (x.port === false || /connection refused|i\/o timeout|no route to host|context deadline exceeded|network is unreachable/i.test(err)) {
        return out('pull_blocked', 'critical', 'Prometheus cannot reach the agent', `The agent is running (heartbeats arrive) but ${addr} cannot be reached from ObservaOne on its pull port: a firewall or security group blocks it, or the address is not routable (set pull.advertise).${err ? ` Prometheus: ${err}` : ''}`);
      }
      if (Number(p.refused) > 0 && /EOF|connection reset|broken pipe/i.test(err)) {
        return out('pull_allow', 'critical', 'The agent refuses ObservaOne', `The agent closed ${p.refused} connections from addresses outside pull.allow in its configuration, so Prometheus cannot scrape it. Add ObservaOne's address to pull.allow (or remove the setting) and reload the agent.`);
      }
      if (/certificate|x509|tls|handshake/i.test(err)) {
        return out('pull_tls', 'critical', 'Certificate problem on the pull endpoint', `Prometheus and the agent do not agree on the certificate: ${err}. The agent renews its certificate when its addresses change; restart it to force a renewal.`);
      }
      return out('pull_scrape_failed', 'critical', 'Scrape failing', err || 'Prometheus reports the target as down.');
    }
    if (x.dataFresh === false) return out('data_path', 'critical', 'Heartbeats arrive, metrics do not', "The agent is running but its uploads do not reach Prometheus: check the agent's last error, Nginx, and that Prometheus accepts remote write.");
    if (x.status === 'attention') return out('agent_problem', 'warning', 'Running with a problem', 'The agent reports a problem (see the list).');
    return healthy('Heartbeats and metrics arrive.');
  }

  // no heartbeat
  if (x.mode === 'pull' && x.scrape && x.scrape.up === 1) {
    return out('heartbeat_blocked', 'warning', 'Scraped, but no heartbeats', 'Prometheus still reads the agent, so the host and agent are up, but heartbeats do not reach ObservaOne: outbound HTTPS from the host is blocked or the server address changed.');
  }
  if (x.ping === true || x.port === true) {
    return out('agent_stopped', 'critical', 'Host up, agent silent', `${addr} answers ${x.ping ? 'ping' : 'on the pull port'}, so the machine is running: the agent stopped or crashed, or outbound HTTPS (443) to ObservaOne is blocked. On the host: systemctl status observaone-agent; journalctl -u observaone-agent.`);
  }
  if (x.ping === false) {
    return out('host_unreachable', 'critical', 'Host not reachable', `${addr} does not answer ping from ObservaOne: the machine is down or rebooting, or the network path is broken. (Where ICMP is blocked by policy this probe cannot tell.)`);
  }
  return out('no_heartbeat', 'warning', 'No heartbeat', 'The agent stopped reporting. There is no reachability probe for this host, so it is unknown whether the machine itself is up.');
}
