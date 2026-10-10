// Sample data for the SRE dashboard: SLOs and error budgets, incidents (with a small in-browser
// store so status changes, notes and declared incidents survive navigation), on-call.
import { rng, hash, series, between, int, pick, SERVICES, TEAMS } from './mock.js';

const SLO_DEFS = [
  ['Availability', 'requests that do not fail', 'availability', [99.9, 99.95, 99.5]],
  ['Latency', 'requests faster than 300 ms', 'latency', [99, 95, 99.5]],
];
export const STATUS_FLOW = ['detected', 'acknowledged', 'investigating', 'mitigated', 'resolved'];
export const STATUS_LABEL = { detected: 'Detected', acknowledged: 'Acknowledged', investigating: 'Investigating', mitigated: 'Mitigated', resolved: 'Resolved' };
const PEOPLE = ['a.kumar', 'j.smith', 'm.garcia', 'l.chen', 'r.patel', 's.okafor', 'e.novak', 'p.iyer', 'd.wong', 'k.mensah'];

// ---------- SLOs ----------
export function slos({ env, start, end, team, service }) {
  const day = 86400;
  const now = end;
  return SERVICES.filter((s) => (!team || s.team === team) && (!service || s.name === service)).flatMap((s) => SLO_DEFS
    .filter(([, , kind]) => kind === 'availability' || s.tier <= 2)
    .map(([name, desc, kind, targets]) => {
      const r = rng(`sre|slo|${env}|${s.name}|${kind}`);
      const target = targets[s.tier - 1] ?? targets[0];
      const allowed = 100 - target;
      // how much of the 30-day budget is used (some SLOs are in trouble)
      const used = r() < 0.18 ? between(r, 0.92, 1.35) : r() < 0.3 ? between(r, 0.6, 0.9) : between(r, 0.05, 0.55);
      const current = 100 - allowed * used;
      const burn1h = used > 0.9 ? between(r, 2.5, 14) : used > 0.6 ? between(r, 1, 3) : between(r, 0.1, 1.2);
      const burn6h = burn1h * between(r, 0.5, 1);
      // remaining budget over the last 30 days, ending at today's value
      const pts = 30;
      const burnDown = Array.from({ length: pts + 1 }, (_, i) => {
        const frac = i / pts;
        const v = 100 - used * 100 * (frac ** between(r, 0.8, 1.6)) + (r() - 0.5) * 3 * (i ? 1 : 0);
        return [now - (pts - i) * day, Math.max(-60, Math.min(100, i === pts ? 100 - used * 100 : v))];
      });
      return {
        id: `slo-${hash(`${s.name}|${kind}`) % 90000 + 10000}`, service: s.name, team: s.team, tier: s.tier, kind,
        name: `${s.name} ${name.toLowerCase()}`, description: `${target}% of ${desc}, rolling 30 days`,
        target, current, budgetLeft: 100 - used * 100, burn1h, burn6h, burn24h: burn6h * between(r, 0.6, 1.1), burn3d: used * 30 / 30 * between(r, 0.8, 1.2) * 1.0,
        status: used >= 1 ? 'breached' : burn1h >= 2 || used > 0.75 ? 'at_risk' : 'healthy',
        burnDown,
        sli: series(r, { start, end, base: current, amp: allowed * 0.3, noise: allowed * 0.15, max: 100, min: target - allowed * 3, spikes: used > 0.75 ? 2 : 0 }),
        alerting: [`Page if burn rate > 14x for 1 h (2% of budget)`, `Page if burn rate > 6x for 6 h (5% of budget)`, `Ticket if burn rate > 1x for 3 days (10% of budget)`],
      };
    }));
}

// ---------- incidents (sample + whatever was declared or changed in this browser) ----------
const STORE_KEY = 'oo.sre.incidents.v1';
let memory = null;
function loadStore() {
  if (memory) return memory;
  try { memory = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null'); } catch { memory = null; }
  memory ||= { created: [], changes: {} };
  return memory;
}
function saveStore() { try { sessionStorage.setItem(STORE_KEY, JSON.stringify(memory)); } catch { /* not kept after reload */ } }

const TITLES = [
  ['Checkout errors above 2%', 'checkout', 'critical'],
  ['Payment authorisations timing out', 'payments-api', 'critical'],
  ['Search latency P95 over 1 s', 'search', 'warning'],
  ['Order confirmation emails delayed', 'notifications', 'warning'],
  ['Login failures for SSO users', 'auth', 'critical'],
  ['Stock reservations failing intermittently', 'inventory', 'warning'],
  ['Recommendations empty on product pages', 'recommendations', 'info'],
  ['API gateway 502s from one zone', 'api-gateway', 'critical'],
  ['Catalog images slow to load', 'catalog', 'info'],
  ['Order history page errors', 'orders', 'warning'],
];

function baseIncidents(env) {
  const now = Date.now();
  return TITLES.map(([title, service, severity], i) => {
    const r = rng(`sre|inc|${env}|${i}`);
    const s = SERVICES.find((x) => x.name === service);
    const age = i < 4 ? between(r, 0.2, 5) : between(r, 8, 24 * 40);
    const startedAt = now - age * 3600_000;
    const status = i < 4 ? STATUS_FLOW[int(r, 0, 3)] : 'resolved';
    const ackMin = between(r, 1, 14), resMin = between(r, 18, 180);
    const idx = STATUS_FLOW.indexOf(status);
    const events = [
      { at: startedAt, kind: 'alert', actor: 'Alertmanager', text: `Alert fired: ${title}` },
      idx >= 1 ? { at: startedAt + ackMin * 60_000, kind: 'status', actor: pick(r, PEOPLE), text: 'Acknowledged' } : null,
      idx >= 2 ? { at: startedAt + (ackMin + 4) * 60_000, kind: 'status', actor: pick(r, PEOPLE), text: 'Investigating' } : null,
      idx >= 2 ? { at: startedAt + (ackMin + 9) * 60_000, kind: 'note', actor: pick(r, PEOPLE), text: `Error rate started right after ${service} ${pick(r, ['v3.2.0', 'v2.14.3', 'v1.9.1'])} went out.` } : null,
      idx >= 3 ? { at: startedAt + resMin * 0.7 * 60_000, kind: 'status', actor: pick(r, PEOPLE), text: 'Mitigated: rolled back to the previous version' } : null,
      idx >= 4 ? { at: startedAt + resMin * 60_000, kind: 'status', actor: pick(r, PEOPLE), text: 'Resolved' } : null,
    ].filter(Boolean);
    return {
      id: 2100 + i, title, service, team: s.team, severity, env: env || 'production', status, startedAt,
      ackAt: idx >= 1 ? startedAt + ackMin * 60_000 : null, resolvedAt: status === 'resolved' ? startedAt + resMin * 60_000 : null,
      commander: idx >= 1 ? pick(r, PEOPLE) : null, comms: idx >= 2 ? pick(r, PEOPLE) : null,
      customersAffected: severity === 'critical' ? int(r, 400, 12000) : int(r, 20, 900),
      events, checklist: {}, postmortem: status === 'resolved' && r() < 0.5 ? 'done' : status === 'resolved' ? 'todo' : null,
    };
  });
}

export function incidents(env) {
  const st = loadStore();
  const list = [...st.created, ...baseIncidents(env)].map((x) => ({ ...x, ...(st.changes[x.id] || {}) }));
  return list.sort((a, b) => (a.status === 'resolved') - (b.status === 'resolved') || b.startedAt - a.startedAt);
}

export function incidentById(env, id) { return incidents(env).find((x) => String(x.id) === String(id)) || null; }

export function updateIncident(env, id, patch, event) {
  const st = loadStore();
  const cur = incidentById(env, id);
  if (!cur) return null;
  const next = { ...(st.changes[id] || {}), ...patch };
  if (event) next.events = [...cur.events, { at: Date.now(), ...event }];
  const own = st.created.find((x) => String(x.id) === String(id));
  if (own) Object.assign(own, next);
  else st.changes[id] = next;
  saveStore();
  return incidentById(env, id);
}

export function declareIncident(env, { title, service, severity, user }) {
  const st = loadStore();
  const s = SERVICES.find((x) => x.name === service) || SERVICES[0];
  const id = 3000 + st.created.length + 1;
  const now = Date.now();
  st.created.unshift({
    id, title, service: s.name, team: s.team, severity, env: env || 'production', status: 'acknowledged', startedAt: now, ackAt: now, resolvedAt: null,
    commander: user, comms: null, customersAffected: 0, checklist: {}, postmortem: null, declared: true,
    events: [{ at: now, kind: 'status', actor: user, text: `Incident declared by ${user}` }],
  });
  saveStore();
  return id;
}

// ---------- on-call ----------
export function onCall() {
  const now = Date.now();
  const r = rng(`sre|oncall|${Math.floor(now / (7 * 86400_000))}`);
  return TEAMS.map((t) => ({ team: t, primary: pick(r, PEOPLE), secondary: pick(r, PEOPLE), until: now + between(r, 6, 140) * 3600_000, phone: `+1 555 0${int(r, 100, 199)}` }));
}

export function sreData({ env, start, end, team, service, empty = false }) {
  if (empty) return { slos: [], incidents: [], weeks: [], onCall: [], kpi: {} };
  const list = slos({ env, start, end, team, service });
  const inc = incidents(env).filter((x) => (!team || x.team === team) && (!service || x.service === service));
  const resolved = inc.filter((x) => x.resolvedAt && x.ackAt);
  const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const r = rng(`sre|weeks|${env}|${team}|${service}`);
  const weeks = Array.from({ length: 8 }, (_, i) => {
    const d = new Date(Date.now() - (7 - i) * 7 * 86400_000);
    return { start: d.getTime() - d.getDay() * 86400_000, critical: int(r, 0, 3), warning: int(r, 1, 5), info: int(r, 0, 4) };
  });
  return {
    slos: list, incidents: inc, weeks, onCall: onCall().filter((o) => !team || o.team === team),
    kpi: {
      slosOk: list.filter((s) => s.status === 'healthy').length, slosTotal: list.length,
      atRisk: list.filter((s) => s.status === 'at_risk').length, breached: list.filter((s) => s.status === 'breached').length,
      budgetMin: list.length ? Math.min(...list.map((s) => s.budgetLeft)) : 0,
      budgetAvg: list.length ? list.reduce((a, s) => a + Math.max(0, s.budgetLeft), 0) / list.length : 0,
      fastBurn: list.filter((s) => s.burn1h >= 2).length,
      open: inc.filter((x) => x.status !== 'resolved').length,
      openCritical: inc.filter((x) => x.status !== 'resolved' && x.severity === 'critical').length,
      mttaMin: median(resolved.map((x) => (x.ackAt - x.startedAt) / 60_000)),
      mttrMin: median(resolved.map((x) => (x.resolvedAt - x.startedAt) / 60_000)),
    },
  };
}
