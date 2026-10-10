// Role-based landing dashboards. One entry per persona: who may open it and how to draw it.
// Access is decided by the user's permissions, so it follows the existing roles (viewer / operator / admin / custom).
// The chosen landing dashboard is remembered in this browser (localStorage, per user).

export const PERSONAS = [
  { id: 'business', label: 'Business / Executive', short: 'Executive', icon: 'activity', perm: 'view', desc: 'Availability, customer impact, revenue at risk and SLA status.', ready: true },
  { id: 'devops', label: 'DevOps Engineer', short: 'DevOps', icon: 'server', perm: 'dashboards.edit', desc: 'Deployments, pipelines, clusters and the alerts that need action.', ready: true },
  { id: 'developer', label: 'Developer', short: 'Developer', icon: 'traces', perm: 'view', desc: 'Your services: errors, latency, slow endpoints, logs and traces.', ready: true },
  { id: 'sre', label: 'SRE / Reliability Engineer', short: 'SRE', icon: 'pulse', perm: 'incidents.manage', desc: 'SLOs, error budgets, incidents and on-call.', ready: true },
  { id: 'security', label: 'Security Team', short: 'Security', icon: 'shield', perm: 'security.read', desc: 'Security signals, suspicious sign-ins and exposed services.', ready: true },
  { id: 'appowner', label: 'Application Owner', short: 'App Owner', icon: 'cube', perm: 'view', desc: 'Health, usage and cost of the applications you own.', ready: true },
  { id: 'itadmin', label: 'IT / Platform Administrator', short: 'Platform Admin', icon: 'settings', perm: 'settings.manage', desc: 'Agents, data sources, ingestion, licences and users.', ready: true },
  { id: 'kubernetes', label: 'Kubernetes', short: 'Kubernetes', icon: 'layers', perm: 'view', desc: 'Clusters, nodes, namespaces, workloads and pods.', ready: true },
];

export const OVERVIEW_ENTRY = { id: 'overview', label: 'Overview', short: 'Overview', icon: 'overview', perm: 'view', desc: 'Health of everything at a glance.', path: '/overview', ready: true };

export const personaById = (id) => PERSONAS.find((p) => p.id === id) || null;
export const personaPath = (p) => p.path || `/views/${p.id}`;

// Which dashboards a user may open comes from their role (an admin sets it in Settings > Roles).
// Older servers without that setting fall back to the permission each dashboard needs.
let roleAccess = null;
export function setRoleAccess(user) {
  roleAccess = Array.isArray(user?.dashboards) ? { dashboards: user.dashboards, landing: user.landing || null } : null;
}
export function canOpen(p, can) {
  if (!p) return false;
  if (p.id === 'overview') return true;
  return roleAccess ? roleAccess.dashboards.includes(p.id) : can(p.perm);
}

export function allowedPersonas(can) {
  return PERSONAS.filter((p) => canOpen(p, can));
}

// Selector entries: Overview first, then every role dashboard this user may open.
export function selectorEntries(can) {
  return [OVERVIEW_ENTRY, ...allowedPersonas(can)];
}

const DEFAULT_BY_ROLE = { admin: 'itadmin', operator: 'devops', viewer: 'business' };
const key = (user) => `oo.landing.${user}`;

function readLanding(user) {
  try { return localStorage.getItem(key(user)); } catch { return null; }
}

export function setLanding(user, id) {
  try { localStorage.setItem(key(user), id); } catch { /* private mode: not remembered */ }
}

// The dashboard to open after sign-in: the remembered one if still allowed, else a sensible default for the role.
export function landingFor(me, can) {
  const allowed = selectorEntries(can);
  const saved = readLanding(me.user.username);
  const ok = (id) => allowed.find((p) => p.id === id);
  const ready = (p) => (p && p.ready ? p : null);
  // 1) what this person picked in this browser, 2) what an admin set for their role, 3) a default for the role
  const p = ready(ok(saved)) || ready(ok(roleAccess?.landing)) || ready(ok(DEFAULT_BY_ROLE[me.user.role])) || allowed.find((x) => x.ready && x.id !== 'overview') || OVERVIEW_ENTRY;
  return p;
}

export function isLanding(me, id) {
  return readLanding(me.user.username) === id;
}
