// Agent management (Phase 4): settings layers, actions, diagnostics bundles, targets.
//
// Settings: environment -> target -> agent (later wins), each layer a row in agent_configuration with a version from
// one global sequence, so any change anywhere gives the agent a higher version. The agent applies a higher version,
// checks it against its host files (which always win), and reports the version it applied (or why it refused it).
// Only the keys in SETTINGS can ever be set from here: never the server address, trust, paths, listen, mode or any
// URL the agent would fetch.
//
// Actions: a fixed list (diagnostics, restart, upgrade), queued here, delivered in heartbeat answers, carried out once.
import { q, one } from './db.js';

export const BASE_COLLECTORS = ['cpu', 'memory', 'load', 'uptime', 'filesystem', 'disk', 'network', 'system', 'agent', 'processes', 'docker', 'nginx', 'jvm', 'exporters'];

export const SETTINGS = {
  collect_interval: { type: 'duration', min: 5, max: 300, label: 'Collect every', hint: '5s to 5m' },
  heartbeat_interval: { type: 'duration', min: 5, max: 300, label: 'Heartbeat every', hint: '5s to 5m' },
  buffer_payloads: { type: 'int', min: 1, max: 1000, label: 'Buffer (collections kept while the server is unreachable)', hint: '1 to 1000' },
  disable: { type: 'list', of: BASE_COLLECTORS, label: 'Collectors turned off' },
  'processes.top': { type: 'int', min: 0, max: 50, label: 'Top processes reported (0 = off)', hint: '0 to 50' },
  'docker.enabled': { type: 'bool', label: 'Docker containers (needs the agent user in the docker group)' },
};
export const ACTIONS = ['diagnostics', 'restart', 'upgrade'];
export const SCOPES = ['env', 'target', 'agent'];

const durSeconds = (v) => {
  const m = /^(\d{1,4})(s|m)$/.exec(String(v).trim());
  if (!m) return null;
  return Number(m[1]) * (m[2] === 'm' ? 60 : 1);
};

// Validates one layer. Returns { settings } (normalised: strings, lists as arrays) or { err }.
// A key set to null or '' is removed from the layer (it inherits again).
export function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { err: 'settings must be an object.' };
  const out = {};
  for (const [k, raw] of Object.entries(input)) {
    const s = SETTINGS[k];
    if (!s) return { err: `${k} cannot be set from ObservaOne (only ${Object.keys(SETTINGS).join(', ')}; everything else is set on the host).` };
    if (raw === null || raw === '' || (Array.isArray(raw) && !raw.length && s.type !== 'list')) continue;
    if (s.type === 'duration') {
      const sec = durSeconds(raw);
      if (sec == null || sec < s.min || sec > s.max) return { err: `${k}: ${s.hint}, written like 30s or 2m.` };
      out[k] = String(raw).trim();
    } else if (s.type === 'int') {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < s.min || n > s.max) return { err: `${k}: a whole number, ${s.hint}.` };
      out[k] = n;
    } else if (s.type === 'bool') {
      if (typeof raw !== 'boolean') return { err: `${k}: true or false.` };
      out[k] = raw;
    } else if (s.type === 'list') {
      const list = Array.isArray(raw) ? raw : String(raw).split(',');
      const clean = [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
      const bad = clean.filter((x) => !s.of.includes(x));
      if (bad.length) return { err: `${k}: unknown collector ${bad.join(', ')} (known: ${s.of.join(', ')}).` };
      out[k] = clean;
    }
  }
  return { settings: out };
}

// What the agent receives: every value as a string (the agent's config keys), lists comma-separated.
export function toAgentMap(settings) {
  const m = {};
  for (const [k, v] of Object.entries(settings)) {
    if (Array.isArray(v)) m[k] = v.join(',');
    else m[k] = String(v);
  }
  return m;
}

export function mergeLayers(layers) {
  const out = {}, from = {};
  let version = 0;
  for (const l of layers) {
    if (!l) continue;
    version = Math.max(version, Number(l.version) || 0);
    for (const [k, v] of Object.entries(l.settings || {})) { out[k] = v; from[k] = l.scope; }
  }
  return { settings: out, from, version };
}

export async function layersFor(agentRow) {
  const keys = [['env', agentRow.env || ''], ['target', agentRow.target_id || ''], ['agent', agentRow.id]].filter(([, id]) => id);
  if (!keys.length) return [];
  const { rows } = await q(`SELECT * FROM agent_configuration WHERE (scope, scope_id) IN (${keys.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ')})`, keys.flat());
  return SCOPES.map((sc) => rows.find((r) => r.scope === sc)).filter(Boolean).map((r) => ({
    scope: r.scope, scopeId: r.scope_id, settings: r.settings, version: Number(r.version), updatedBy: r.updated_by, updatedAt: r.updated_at,
  }));
}

export async function effectiveFor(agentRow) {
  const layers = await layersFor(agentRow);
  return { ...mergeLayers(layers), layers };
}

export async function saveLayer(scope, scopeId, settings, user) {
  const r = await one(`INSERT INTO agent_configuration (scope, scope_id, settings, version, updated_by, updated_at)
                       VALUES ($1, $2, $3, nextval('agent_config_seq'), $4, now())
                       ON CONFLICT (scope, scope_id) DO UPDATE SET settings = EXCLUDED.settings, version = EXCLUDED.version,
                         updated_by = EXCLUDED.updated_by, updated_at = now()
                       RETURNING *`, [scope, scopeId, JSON.stringify(settings), user]);
  return { scope: r.scope, scopeId: r.scope_id, settings: r.settings, version: Number(r.version), updatedBy: r.updated_by, updatedAt: r.updated_at };
}

// ---------------- actions ----------------

const ACTION_TTL_HOURS = 24;

// Actions to put in this heartbeat answer. Older than a day: expired (the agent was away).
export async function deliverActions(agentId) {
  await q(`UPDATE agent_actions SET state = 'expired', done_at = now(), result = '{"ok":false,"message":"not picked up within 24 h"}'
           WHERE agent_id = $1 AND state IN ('pending', 'sent') AND requested_at < now() - make_interval(hours => $2)`, [agentId, ACTION_TTL_HOURS]);
  const { rows } = await q(`UPDATE agent_actions SET state = 'sent', sent_at = COALESCE(sent_at, now())
                            WHERE agent_id = $1 AND state IN ('pending', 'sent') RETURNING id, action, args`, [agentId]);
  return rows.sort((a, b) => Number(a.id) - Number(b.id)).map((r) => ({ id: Number(r.id), action: r.action, args: r.args || {} }));
}

export async function queueAction(agentId, action, args, user) {
  if (!ACTIONS.includes(action)) return { err: `action must be one of ${ACTIONS.join(', ')}` };
  const open = await one(`SELECT id FROM agent_actions WHERE agent_id = $1 AND action = $2 AND state IN ('pending', 'sent')`, [agentId, action]);
  if (open) return { err: `A ${action} request is already waiting for this agent (#${open.id}).`, status: 409 };
  const r = await one(`INSERT INTO agent_actions (agent_id, action, args, requested_by) VALUES ($1, $2, $3, $4) RETURNING *`,
    [agentId, action, JSON.stringify(args || {}), user]);
  return { action: actionRow(r) };
}

export async function recordResult(agentId, actionId, body) {
  const ok = body?.ok === true;
  const result = { ok, message: String(body?.message || '').slice(0, 500) };
  if (typeof body?.version === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(body.version)) result.version = body.version;
  const r = await one(`UPDATE agent_actions SET state = $3, done_at = now(), result = $4
                       WHERE id = $1 AND agent_id = $2 AND state IN ('pending', 'sent') RETURNING *`,
  [actionId, agentId, ok ? 'done' : 'failed', JSON.stringify(result)]);
  return r ? actionRow(r) : null;
}

export async function storeDiagnostics(agentId, actionId, bundle, size) {
  const r = await one(`INSERT INTO agent_diagnostics (agent_id, action_id, size, bundle) VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
    [agentId, actionId || null, size, JSON.stringify(bundle)]);
  if (actionId) {
    await q(`UPDATE agent_actions SET state = 'done', done_at = now(), result = $3
             WHERE id = $1 AND agent_id = $2 AND state IN ('pending', 'sent')`,
    [actionId, agentId, JSON.stringify({ ok: true, message: 'bundle received', diagnosticsId: Number(r.id) })]);
  }
  // keep the 5 newest bundles per agent
  await q(`DELETE FROM agent_diagnostics WHERE agent_id = $1 AND id NOT IN
             (SELECT id FROM agent_diagnostics WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 5)`, [agentId]);
  return { id: Number(r.id), createdAt: r.created_at };
}

export const actionRow = (r) => ({
  id: Number(r.id), action: r.action, args: r.args || {}, state: r.state, requestedBy: r.requested_by, requestedAt: r.requested_at,
  sentAt: r.sent_at, doneAt: r.done_at, result: r.result || null,
});

// Diagnostics bundles come from the agent: keep them as data. Anything that looks like a secret is removed
// on the way in, whatever the agent sent (defence in depth; the agent never includes one).
const SECRET_RE = /(oa[tc]_[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|"?(?:password|passwd|secret|token|credential)"?\s*[:=]\s*"?[^\s",}]{4,})/gi;
export function scrubBundle(value, depth = 0) {
  if (depth > 12) return '[too deep]';
  if (typeof value === 'string') return value.replace(SECRET_RE, '[removed]').slice(0, 4000);
  if (Array.isArray(value)) return value.slice(0, 2000).map((v) => scrubBundle(v, depth + 1));
  if (value && typeof value === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(value).slice(0, 500)) {
      if (/^(credential|token|password|secret|privateKey)$/i.test(k)) { o[k] = '[removed]'; continue; }
      o[String(k).slice(0, 100)] = scrubBundle(v, depth + 1);
    }
    return o;
  }
  return value;
}
