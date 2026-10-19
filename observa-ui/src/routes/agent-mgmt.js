// Agent management API for the UI (Phase 4): settings layers, actions, diagnostics bundles, targets (Add Target).
//
//   GET  /agents/:id/manage                  settings (effective + layers), actions, bundles, past names
//   PUT  /agents/:id/config                  { settings }  agent layer
//   GET  /agent-config                       env layers + the settings schema
//   PUT  /agent-config/env/:env              { settings }  environment layer
//   PUT  /targets/:id/config                 { settings }  target layer
//   POST /agents/:id/actions                 { action: diagnostics | restart | upgrade }
//   GET  /agents/:id/diagnostics/:did        one bundle (JSON, for download)
//   POST /targets                            Add Target: target + a one-use token (shown once)
//   GET  /targets                            targets and their agents
//   GET  /targets/:id/progress               enrolled -> first heartbeat -> first metrics -> Prometheus has data
//
// Changing anything needs integrations.manage; reading needs view. Everything changed is audited.
import express from 'express';
import crypto from 'node:crypto';
import { q, one, tx } from '../db.js';
import { audit } from '../store.js';
import { sha256, randomToken } from '../secrets.js';
import { requirePerm, httpError } from '../auth.js';
import { promInstant } from '../datasources.js';
import { compareVersions } from '../health.js';
import { SETTINGS, ACTIONS, validateSettings, saveLayer, effectiveFor, queueAction, actionRow, envScopeId } from '../agentmgmt.js';
import { AGENT_LATEST, describeAgent, forgetAgentCredential, removeAgents } from './agent-control.js';
import { serverUrl, certInfo } from './agents.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const tn = (req) => req.user?.tenant || 't_default'; // default-tenant users see all tenants, others only their own
const ENV_RE = /^[A-Za-z0-9._-]{1,64}$/;
const LABEL_KEY_RE = /^[a-z][a-z0-9_]{0,30}$/;
const LABEL_VAL_RE = /^[A-Za-z0-9._-]{0,64}$/;
const RESERVED = new Set(['host', 'job', 'instance', 'agent', 'agent_id', 'platform', 'os', 'env', 'role', 'tenant', '__name__']);

export const agentMgmtRouter = express.Router();

async function agentOr404(id, req) {
  const a = await one(`SELECT * FROM agents WHERE id = $1 AND ($2 = 't_default' OR tenant_id = $2)`, [id, tn(req)]);
  if (!a) throw httpError(404, 'Agent not found.');
  return a;
}

const schema = () => Object.fromEntries(Object.entries(SETTINGS).map(([k, s]) => [k, { ...s }]));

agentMgmtRouter.get('/agents/:id/manage', requirePerm('view'), wrap(async (req, res) => {
  const a = await agentOr404(req.params.id, req);
  const eff = await effectiveFor(a);
  const [actions, bundles, aliases, target] = await Promise.all([
    q('SELECT * FROM agent_actions WHERE agent_id = $1 ORDER BY id DESC LIMIT 20', [a.id]),
    q('SELECT id, action_id, created_at, size FROM agent_diagnostics WHERE agent_id = $1 ORDER BY created_at DESC', [a.id]),
    q('SELECT kind, value, seen_from, seen_to FROM agent_aliases WHERE agent_id = $1 ORDER BY seen_to DESC LIMIT 20', [a.id]),
    a.target_id ? one('SELECT id, name, kind, env, role, mode FROM targets WHERE id = $1', [a.target_id]) : null,
  ]);
  const applied = Number(a.config_applied) || 0;
  res.json({
    agentId: a.id,
    enrolled: !!a.credential_hash,
    credential: { issuedAt: a.credential_issued_at, rotateRequested: !!a.rotate_requested, previousValidUntil: a.credential_prev_until },
    supportsActions: !!a.version && compareVersions(a.version, '1.3.0') >= 0,
    latest: AGENT_LATEST,
    config: {
      effective: eff.settings, from: eff.from, version: eff.version, applied, error: a.config_error || '',
      state: !eff.version ? 'none' : a.config_error && applied < eff.version ? 'refused' : applied >= eff.version ? 'applied' : 'pending',
      layers: eff.layers, hostLocked: a.diag?.hostLocked || [],
    },
    schema: schema(),
    actions: actions.rows.map(actionRow),
    diagnostics: bundles.rows.map((r) => ({ id: Number(r.id), actionId: r.action_id ? Number(r.action_id) : null, createdAt: r.created_at, size: r.size })),
    pastNames: aliases.rows.map((r) => ({ kind: r.kind, value: r.value, until: r.seen_to })),
    target,
  });
}));

async function putLayer(req, res, scope, scopeId, what) {
  const v = validateSettings(req.body?.settings);
  if (v.err) throw httpError(400, v.err);
  const layer = await saveLayer(scope, scopeId, v.settings, req.user.username);
  audit(req, 'agent.config.change', { scope, scopeId, settings: v.settings, version: layer.version });
  res.json({ ok: true, layer, what });
}

agentMgmtRouter.put('/agents/:id/config', requirePerm('integrations.manage'), wrap(async (req, res) => {
  const a = await agentOr404(req.params.id, req);
  if (!a.credential_hash) throw httpError(409, 'Only enrolled ObservaOne agents (Linux 1.1+) take settings from here.');
  await putLayer(req, res, 'agent', a.id, a.host);
}));

agentMgmtRouter.get('/agent-config', requirePerm('view'), wrap(async (req, res) => {
  // each user sees the environment layers of their own tenant (the default tenant's are stored without a prefix)
  const t = tn(req);
  const [layers, envs] = await Promise.all([
    q(`SELECT * FROM agent_configuration WHERE scope = 'env' ORDER BY scope_id`),
    q(`SELECT env, count(*)::int AS agents FROM agents WHERE credential_hash IS NOT NULL AND env <> '' AND tenant_id = $1 GROUP BY env ORDER BY env`, [t]),
  ]);
  const byEnv = new Map(envs.rows.map((r) => [r.env, { env: r.env, agents: r.agents, settings: {}, version: 0 }]));
  const prefix = t === 't_default' ? '' : `${t}/`;
  for (const l of layers.rows) {
    if (prefix ? !l.scope_id.startsWith(prefix) : l.scope_id.includes('/')) continue;
    const env = l.scope_id.slice(prefix.length);
    const cur = byEnv.get(env) || { env, agents: 0 };
    byEnv.set(env, { ...cur, settings: l.settings, version: Number(l.version), updatedBy: l.updated_by, updatedAt: l.updated_at });
  }
  res.json({ environments: [...byEnv.values()].sort((x, y) => x.env.localeCompare(y.env)), schema: schema() });
}));

agentMgmtRouter.put('/agent-config/env/:env', requirePerm('integrations.manage'), wrap(async (req, res) => {
  if (!ENV_RE.test(req.params.env)) throw httpError(400, 'Environment name: letters, digits, . _ - (max 64).');
  await putLayer(req, res, 'env', envScopeId(tn(req), req.params.env), `environment ${req.params.env}`);
}));

agentMgmtRouter.put('/targets/:id/config', requirePerm('integrations.manage'), wrap(async (req, res) => {
  const t = await one(`SELECT id, name FROM targets WHERE id = $1 AND ($2 = 't_default' OR tenant_id = $2)`, [req.params.id, tn(req)]);
  if (!t) throw httpError(404, 'Target not found.');
  await putLayer(req, res, 'target', t.id, `target ${t.name}`);
}));

agentMgmtRouter.post('/agents/:id/actions', requirePerm('integrations.manage'), wrap(async (req, res) => {
  const a = await agentOr404(req.params.id, req);
  const action = String(req.body?.action || '');
  if (!ACTIONS.includes(action)) throw httpError(400, `action must be one of ${ACTIONS.join(', ')}.`);
  if (!a.credential_hash) throw httpError(409, 'Only enrolled ObservaOne agents take actions.');
  if (a.blocked) throw httpError(409, 'This agent is blocked: it does not receive anything until you allow it again.');
  if (!a.version || compareVersions(a.version, '1.3.0') < 0) {
    throw httpError(409, `This agent runs ${a.version || 'an old version'}; actions need 1.3.0 or newer. Run the installer on the host once to upgrade it.`);
  }
  const args = action === 'upgrade' ? { version: AGENT_LATEST } : {};
  if (action === 'upgrade' && compareVersions(a.version, AGENT_LATEST) >= 0) throw httpError(409, `Already on the latest version (${AGENT_LATEST}).`);
  const r = await queueAction(a.id, action, args, req.user.username);
  if (r.err) throw httpError(r.status || 400, r.err);
  audit(req, `agent.action.request`, { id: a.id, host: a.host, action, actionId: r.action.id, ...args });
  res.status(201).json({ ok: true, action: r.action, deliveredWithin: 'the next heartbeat' });
}));

// Ask the agent to take a new credential at its next heartbeat (agent 1.3+). The old one keeps working until
// 10 minutes after the new one is first used, so nothing is lost if the agent is away.
agentMgmtRouter.post('/agents/:id/rotate-credential', requirePerm('integrations.manage'), wrap(async (req, res) => {
  const a = await agentOr404(req.params.id, req);
  if (!a.credential_hash) throw httpError(409, 'Only enrolled ObservaOne agents have a credential.');
  if (!a.version || compareVersions(a.version, '1.3.0') < 0) throw httpError(409, 'Credential rotation needs agent 1.3.0 or newer.');
  await q('UPDATE agents SET rotate_requested = TRUE WHERE id = $1', [a.id]);
  forgetAgentCredential(a.id);
  audit(req, 'agent.credential.rotate_request', { id: a.id, host: a.host });
  res.json({ ok: true });
}));

agentMgmtRouter.get('/agents/:id/diagnostics/:did', requirePerm('integrations.manage'), wrap(async (req, res) => {
  const r = await one(`SELECT d.*, a.host FROM agent_diagnostics d JOIN agents a ON a.id = d.agent_id
                       WHERE d.id = $1 AND d.agent_id = $2 AND ($3 = 't_default' OR a.tenant_id = $3)`,
    [Number(req.params.did) || 0, req.params.id, tn(req)]);
  if (!r) throw httpError(404, 'Bundle not found (only the 5 newest are kept).');
  audit(req, 'agent.diagnostics.read', { id: req.params.id, diagnosticsId: Number(r.id) });
  if (req.query.download === '1') {
    const stamp = new Date(r.created_at).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.set('Content-Disposition', `attachment; filename="observaone-agent-${r.host.replace(/[^\w.-]/g, '_')}-${stamp}.json"`);
  }
  res.set('Cache-Control', 'no-store');
  res.json({ id: Number(r.id), agentId: r.agent_id, host: r.host, createdAt: r.created_at, size: r.size, bundle: r.bundle });
}));

// ---------------- targets (Add Target wizard) ----------------

function parseTarget(b) {
  const name = String(b?.name || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,62}$/.test(name)) return { err: 'Name: letters, digits, space . _ - (max 63).' };
  const kind = b?.kind || 'linux';
  if (kind !== 'linux') return { err: 'Only Linux servers can be added with the ObservaOne agent today.' };
  const env = String(b?.env || '').trim(), role = String(b?.role || '').trim();
  for (const v of [env, role]) if (v && !ENV_RE.test(v)) return { err: 'Environment and role: letters, digits, . _ - (max 64).' };
  const labels = {};
  const entries = Object.entries(b?.labels && typeof b.labels === 'object' && !Array.isArray(b.labels) ? b.labels : {});
  if (entries.length > 10) return { err: 'At most 10 labels.' };
  for (const [k, v] of entries) {
    if (!LABEL_KEY_RE.test(k) || RESERVED.has(k)) return { err: `Label ${k}: lower-case a-z 0-9 _, not a reserved name.` };
    if (!LABEL_VAL_RE.test(String(v))) return { err: `Label ${k}: value letters, digits, . _ - (max 64).` };
    labels[k] = String(v);
  }
  const mode = b?.mode === 'pull' ? 'pull' : 'push';
  const hours = b?.validHours == null ? 24 : Number(b.validHours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) return { err: 'Token validity: 1 to 720 hours.' };
  const uses = b?.maxUses == null ? 1 : Number(b.maxUses);
  if (!Number.isInteger(uses) || uses < 1 || uses > 1000) return { err: 'Servers per token: 1 to 1000.' };
  return { v: { name, kind, env, role, labels, mode, hours, uses } };
}

agentMgmtRouter.post('/targets', requirePerm('integrations.manage'), wrap(async (req, res) => {
  const p = parseTarget(req.body);
  if (p.err) throw httpError(400, p.err);
  const v = p.v;
  const id = `tgt_${crypto.randomBytes(8).toString('hex')}`;
  const prefix = crypto.randomBytes(4).toString('hex');
  const token = `oat_${prefix}_${randomToken(24)}`;
  const out = await tx(async (c) => {
    const t = (await c.query(`INSERT INTO agent_tokens (name, prefix, token_hash, env, created_by, expires_at, max_uses, target_id, tenant_id)
                              VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6::int), $7, $8, $9) RETURNING id, expires_at`,
    [`Target ${v.name}`.slice(0, 60), prefix, sha256(token), v.env, req.user.username, v.hours, v.uses, id, tn(req)])).rows[0];
    await c.query(`INSERT INTO targets (id, kind, name, env, role, labels, mode, token_id, created_by, tenant_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, v.kind, v.name, v.env, v.role, JSON.stringify(v.labels), v.mode, t.id, req.user.username, tn(req)]);
    return t;
  });
  audit(req, 'target.create', { id, name: v.name, env: v.env, mode: v.mode, tokenPrefix: prefix, validHours: v.hours, maxUses: v.uses });
  res.set('Cache-Control', 'no-store'); // the only time the token is sent
  res.status(201).json({
    target: { id, ...v }, token, tokenExpiresAt: out.expires_at,
    server: serverUrl(req), cert: certInfo(),
  });
}));

agentMgmtRouter.get('/targets', requirePerm('view'), wrap(async (req, res) => {
  const { rows } = await q(`SELECT t.*, (SELECT json_agg(json_build_object('id', a.id, 'host', a.host)) FROM agents a WHERE a.target_id = t.id) AS agents
                            FROM targets t WHERE ($1 = 't_default' OR t.tenant_id = $1) ORDER BY t.created_at DESC LIMIT 500`, [tn(req)]);
  res.json({ targets: rows.map((t) => ({ id: t.id, name: t.name, kind: t.kind, env: t.env, role: t.role, labels: t.labels, mode: t.mode, createdBy: t.created_by, createdAt: t.created_at, agents: t.agents || [] })) });
}));

// Remove a target: its token is revoked and its agents are removed too (?agents=keep only unbinds them).
// Removed agents hear it at their next heartbeat: they stop, or with ?uninstall=1 uninstall themselves (1.3.1+).
agentMgmtRouter.delete('/targets/:id', requirePerm('integrations.manage'), wrap(async (req, res) => {
  const keep = req.query.agents === 'keep';
  const uninstall = !keep && (req.query.uninstall === '1' || req.query.uninstall === 'true');
  const t = await one(`SELECT id, name, token_id FROM targets WHERE id = $1 AND ($2 = 't_default' OR tenant_id = $2)`, [req.params.id, tn(req)]);
  if (!t) throw httpError(404, 'Target not found.');
  const removed = await tx(async (c) => {
    const ids = (await c.query('SELECT id FROM agents WHERE target_id = $1', [t.id])).rows.map((r) => r.id);
    let out = [];
    if (keep) await c.query('UPDATE agents SET target_id = NULL WHERE target_id = $1', [t.id]);
    else out = await removeAgents(c, ids, { uninstall, by: req.user?.username || '' });
    if (t.token_id) await c.query('UPDATE agent_tokens SET revoked = TRUE, revoked_at = now() WHERE id = $1 AND NOT revoked', [t.token_id]);
    await c.query(`DELETE FROM agent_configuration WHERE scope = 'target' AND scope_id = $1`, [t.id]);
    await c.query('DELETE FROM targets WHERE id = $1', [t.id]);
    return out;
  });
  if (keep) forgetAgentCredential();
  audit(req, 'target.remove', { id: t.id, name: t.name, agents: removed.map((r) => r.host), uninstall, keptAgents: keep });
  res.json({ ok: true, removedAgents: removed.map((r) => ({ id: r.id, host: r.host })), uninstall });
}));

// The wizard's live checklist. Every step says what it is waiting for and, when stuck, the likely cause.
agentMgmtRouter.get('/targets/:id/progress', requirePerm('view'), wrap(async (req, res) => {
  const t = await one(`SELECT t.*, k.uses, k.max_uses, k.expires_at, k.revoked FROM targets t LEFT JOIN agent_tokens k ON k.id = t.token_id
                       WHERE t.id = $1 AND ($2 = 't_default' OR t.tenant_id = $2)`, [req.params.id, tn(req)]);
  if (!t) throw httpError(404, 'Target not found.');
  const a = await one('SELECT * FROM agents WHERE target_id = $1 ORDER BY enrolled_at DESC NULLS LAST LIMIT 1', [t.id]);
  const age = Date.now() - new Date(t.created_at).getTime();
  const steps = [];
  const step = (key, label, done, hint) => steps.push({ key, label, done: !!done, hint: done ? '' : hint });
  const expired = t.expires_at && new Date(t.expires_at) < new Date();
  step('enrolled', 'Agent enrolled', !!a, expired ? 'The token expired before the agent enrolled: add the target again for a new one.'
    : t.revoked ? 'The token was revoked.'
      : age > 180_000 ? 'Nothing yet. On the server: did the installer finish? Typical causes: DNS or firewall (outbound 443 to this address), the certificate fingerprint, or a mistyped token.'
        : 'Run the two commands on the server (the token is already in them).');
  const d = a ? describeAgent(a) : null;
  step('heartbeat', 'First heartbeat', a?.last_heartbeat, a ? 'Enrolled but no heartbeat: the service did not start. On the server: systemctl status observaone-agent; journalctl -u observaone-agent -n 30.' : '');
  let metrics = false, prom = false, series = 0;
  if (a) {
    metrics = t.mode === 'pull' || a.mode === 'pull' ? true : !!(a.last_seen && a.enrolled_at && new Date(a.last_seen) - new Date(a.enrolled_at) > 1000);
    try {
      const r = await promInstant(`count({agent_id="${a.id}"})`);
      series = r.length ? Number(r[0].value[1]) : 0;
      prom = series > 0;
      if (prom) metrics = true;
    } catch { /* Prometheus not reachable: the step stays open */ }
  }
  step('metrics', 'First metrics', metrics, a?.mode === 'pull'
    ? 'Pull mode: Prometheus has not scraped the agent yet. Open TCP 9110 (or your pull port) from the ObservaOne server; the Agents page diagnosis shows the cause.'
    : 'Heartbeats arrive but no metrics: check the agent\'s last error (Agents page) and that Prometheus accepts remote write.');
  step('prometheus', 'Prometheus has data', prom, 'Waiting for Prometheus to answer with this server\'s series (a few seconds after the first metrics).');
  res.json({
    target: { id: t.id, name: t.name, env: t.env, role: t.role, mode: t.mode },
    token: { uses: t.uses || 0, maxUses: t.max_uses, expiresAt: t.expires_at, expired: !!expired, revoked: !!t.revoked },
    agent: a ? { id: a.id, host: a.host, os: a.os, arch: a.arch, kernel: a.kernel, version: a.version, ip: a.ip, status: d.status,
      collectors: a.diag?.collectors || {}, addresses: a.addresses || [], mode: a.mode } : null,
    series,
    steps,
    done: steps.every((s) => s.done),
  });
}));
