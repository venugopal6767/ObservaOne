// Notification channels and policies API (Alerting -> Notification channels / policies). notify.js writes them into
// Alertmanager's configuration (policies = routes, channels = receivers).
//
//   GET    /notifications                    channels (with the policies using them), email server, last apply status
//   GET    /notifications/teams              team label values in use (suggestions)
//   POST   /notifications/channels           add a channel            { name, type, to | webhookUrl | url, token | routingKey, ..., policies: [ids] }
//   PUT    /notifications/channels/:id       change it (empty secret fields keep the stored ones)
//   DELETE /notifications/channels/:id
//   POST   /notifications/channels/:id/test  send a test message now  -> { ok, error? }
//   PUT    /notifications/smtp               email server             { smarthost, from, username, password, requireTls } | { clear }
//   POST   /notifications/apply              write + reload again (after editing the base file)
//
//   GET    /notifications/policies           policies in order (+ Default), how many active alerts each takes now, label suggestions
//   POST   /notifications/policies           { name, description, matchers: [{label, op, value}], channels, groupBy, groupWait, groupInterval, repeatInterval, continue, enabled }
//   PUT    /notifications/policies/:id       change (the Default policy: channels and timing only)
//   DELETE /notifications/policies/:id       (not the Default policy)
//   PUT    /notifications/policies-order     { ids } top to bottom
//   POST   /notifications/policies/preview   { labels } -> the policies (and channels) an alert with these labels goes to
//
// Channels and policies belong to the platform: a tenant user sees policy names (to choose one in Create alert) only,
// and cannot change anything here.
import express from 'express';
import YAML from 'yaml';
import { requirePerm, httpError } from '../auth.js';
import { audit } from '../store.js';
import { am } from '../datasources.js';
import { isScoped, currentTenant } from '../tenancy.js';
import { q, one } from '../db.js';
import {
  parseMatcher, matchesAll as matchAll, cleanPolicy, listPolicies, policyById, insertPolicy, updatePolicy, reorderPolicies, dropChannelFromPolicies, routeFor, LABEL_RE,
} from '../policies.js';
import { tx } from '../db.js';
import {
  TYPES, editable, cleanChannel, listChannels, publicChannel, getSmtp, saveSmtp, applyConfig, applyStatus,
  readBase, teamsOf, sendTest, recordTest, channelById,
} from '../notify.js';

export const notificationsRouter = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const manage = [requirePerm('notifications.manage'), (req, res, next) => (isScoped() ? next(httpError(403, 'Notification channels are managed by the platform team.')) : next())];

function baseOrEmpty() {
  try { return editable() ? readBase() : {}; } catch { return {}; }
}

// what Alertmanager runs now (read-only view when ObservaOne does not manage the file)
async function liveConfig() {
  try { const s = await am('/api/v2/status'); return YAML.parse(s.config?.original || '') || {}; } catch { return null; }
}

notificationsRouter.get('/notifications/teams', wrap(async (req, res) => {
  const t = new Set(editable() ? (await listChannels()).map((c) => c.team).filter(Boolean) : []);
  if (editable()) for (const p of await listPolicies()) for (const m of p.matchers) if (m.label === 'team' && m.op === '=') t.add(m.value);
  for (const x of ['platform', 'infra', 'ops']) t.add(x);
  res.json([...t].sort());
}));

notificationsRouter.get('/notifications', wrap(async (req, res) => {
  const live = await liveConfig();
  const rows = isScoped() ? [] : (editable() ? await listChannels() : []);
  const policies = isScoped() || !editable() ? [] : await listPolicies();
  const smtp = await getSmtp();
  // channels written by hand in the base file are not used once policies route (shown so they can be re-added here)
  const fileChannels = editable() ? (baseOrEmpty().receivers || []).flatMap((r) => Object.keys(r).filter((k) => k.endsWith('_configs'))
    .map((k) => ({ receiver: r.name, type: k.replace('_configs', ''), count: (r[k] || []).length }))) : [];
  res.json({
    editable: editable() && !isScoped(),
    managedByObservaOne: editable(),
    alertmanagerReachable: !!live,
    apply: applyStatus(),
    types: Object.entries(TYPES).map(([id, t]) => ({ id, name: t.name })),
    smtp: isScoped() ? { configured: smtp.configured } : smtp,
    channels: rows.map((r) => ({ ...publicChannel(r), usedBy: policies.filter((p) => p.channels.includes(Number(r.id))).map((p) => ({ id: p.id, name: p.name, isDefault: p.isDefault, enabled: p.enabled })) })),
    fileChannels,
    // read-only installations: the receivers Alertmanager runs
    receivers: editable() ? [] : (live?.receivers || []).map((r) => ({ name: r.name, channels: Object.keys(r).filter((k) => k.endsWith('_configs')).map((k) => ({ type: k.replace('_configs', ''), count: (r[k] || []).length })) })),
  });
}));

async function addToPolicies(channelId, ids) {
  for (const id of (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger)) {
    await q(`UPDATE notification_policies SET channel_ids = channel_ids || to_jsonb($2::bigint), updated_at = now()
             WHERE id = $1 AND NOT channel_ids @> to_jsonb($2::bigint)`, [id, channelId]);
  }
}
async function setChannelPolicies(channelId, ids) {
  await dropChannelFromPolicies(Number(channelId));
  await addToPolicies(Number(channelId), ids);
}

function requireEditable() {
  if (!editable()) throw httpError(409, 'ObservaOne does not manage the Alertmanager configuration here (AM_CONFIG_FILE is not set). Edit alertmanager/alertmanager.yml instead.');
}

notificationsRouter.post('/notifications/channels', ...manage, wrap(async (req, res) => {
  requireEditable();
  const c = cleanChannel(req.body);
  if (c.type === 'email' && !(await getSmtp()).configured) throw httpError(400, 'Set up the email server first (Email server, above the channels).');
  if (await one('SELECT 1 FROM notification_channels WHERE lower(name) = lower($1)', [c.name])) throw httpError(409, `A channel named "${c.name}" already exists.`);
  const r = await one(`INSERT INTO notification_channels (name, type, team, settings, secret, display, send_resolved, enabled, created_by)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
  [c.name, c.type, c.team, JSON.stringify(c.settings), c.secret, c.display, c.sendResolved, c.enabled, req.user?.username]);
  await addToPolicies(r.id, req.body?.policies);
  audit(req, 'notifications.channel.create', { id: r.id, name: c.name, type: c.type, policies: req.body?.policies || [] });
  const apply = await applyConfig();
  res.json({ channel: publicChannel(r), apply });
}));

notificationsRouter.put('/notifications/channels/:id', ...manage, wrap(async (req, res) => {
  requireEditable();
  const old = await channelById(req.params.id);
  if (!old) throw httpError(404, 'No such channel.');
  const c = cleanChannel(req.body, old);
  if (await one('SELECT 1 FROM notification_channels WHERE lower(name) = lower($1) AND id <> $2', [c.name, old.id])) throw httpError(409, `A channel named "${c.name}" already exists.`);
  const r = await one(`UPDATE notification_channels SET name=$2, team=$3, settings=$4, secret=$5, display=$6, send_resolved=$7, enabled=$8, updated_at=now()
                       WHERE id=$1 RETURNING *`,
  [old.id, c.name, c.team, JSON.stringify(c.settings), c.secret, c.display, c.sendResolved, c.enabled]);
  if (Array.isArray(req.body?.policies)) await setChannelPolicies(r.id, req.body.policies);
  audit(req, 'notifications.channel.update', { id: r.id, name: c.name, enabled: c.enabled });
  res.json({ channel: publicChannel(r), apply: await applyConfig() });
}));

notificationsRouter.delete('/notifications/channels/:id', ...manage, wrap(async (req, res) => {
  requireEditable();
  const r = await one('DELETE FROM notification_channels WHERE id = $1 RETURNING id, name, type', [req.params.id]);
  if (!r) throw httpError(404, 'No such channel.');
  await dropChannelFromPolicies(Number(r.id));
  audit(req, 'notifications.channel.delete', r);
  res.json({ ok: true, apply: await applyConfig() });
}));

notificationsRouter.post('/notifications/channels/:id/test', ...manage, wrap(async (req, res) => {
  const row = await channelById(req.params.id);
  if (!row) throw httpError(404, 'No such channel.');
  const started = Date.now();
  try {
    await sendTest(row, req.user?.username || 'someone');
    await recordTest(row.id, true, null);
    audit(req, 'notifications.channel.test', { id: row.id, ok: true });
    res.json({ ok: true, ms: Date.now() - started });
  } catch (e) {
    await recordTest(row.id, false, e.message);
    audit(req, 'notifications.channel.test', { id: row.id, ok: false });
    res.json({ ok: false, error: e.message, ms: Date.now() - started });
  }
}));

notificationsRouter.put('/notifications/smtp', ...manage, wrap(async (req, res) => {
  requireEditable();
  if (req.body?.clear && (await q("SELECT 1 FROM notification_channels WHERE type = 'email' AND enabled LIMIT 1")).rowCount) {
    throw httpError(409, 'Email channels still use the email server: delete or disable them first.');
  }
  await saveSmtp(req.body, req.user?.username);
  audit(req, 'notifications.smtp', { cleared: !!req.body?.clear, smarthost: req.body?.smarthost });
  res.json({ smtp: await getSmtp(), apply: await applyConfig() });
}));

notificationsRouter.post('/notifications/apply', ...manage, wrap(async (req, res) => {
  requireEditable();
  res.json({ apply: await applyConfig({ force: true }) });
}));

// ---------------------------------------------------------------- policies
const publicPolicy = (p, chans, counts) => ({
  ...p, channelNames: p.channels.map((id) => chans.get(id)).filter(Boolean).map((c) => ({ id: Number(c.id), name: c.name, type: c.type, enabled: c.enabled })),
  activeAlerts: counts?.get(p.id) ?? null,
});

async function activeAlertLabels() {
  try { return (await am('/api/v2/alerts?silenced=false&inhibited=false')).map((a) => a.labels); } catch { return null; }
}

notificationsRouter.get('/notifications/policies', wrap(async (req, res) => {
  if (!editable()) return res.json({ editable: false, policies: [] });
  const policies = await listPolicies();
  if (isScoped()) return res.json({ editable: false, policies: policies.filter((p) => !p.isDefault && p.enabled).map((p) => ({ id: p.id, name: p.name })) });
  const chans = new Map((await listChannels()).map((c) => [Number(c.id), c]));
  const alerts = await activeAlertLabels();
  let counts = null;
  const suggestions = { severity: new Set(['critical', 'warning', 'info']), env: new Set(), team: new Set(), service: new Set(), host: new Set(), alertname: new Set() };
  if (alerts) {
    counts = new Map(policies.map((p) => [p.id, 0]));
    for (const l of alerts) {
      for (const p of routeFor(policies, l)) counts.set(p.id, (counts.get(p.id) || 0) + 1);
      for (const k of Object.keys(suggestions)) if (l[k]) suggestions[k].add(l[k]);
    }
  }
  res.json({
    editable: true,
    policies: policies.map((p) => publicPolicy(p, chans, counts)),
    alertmanagerReachable: !!alerts,
    activeAlerts: alerts ? alerts.length : null,
    suggestions: Object.fromEntries(Object.entries(suggestions).map(([k, v]) => [k, [...v].sort().slice(0, 200)])),
    apply: applyStatus(),
  });
}));

notificationsRouter.post('/notifications/policies', ...manage, wrap(async (req, res) => {
  requireEditable();
  const chanIds = new Set((await listChannels()).map((c) => Number(c.id)));
  const p = cleanPolicy(req.body, { channelIds: chanIds });
  if (await one('SELECT 1 FROM notification_policies WHERE lower(name) = lower($1)', [p.name])) throw httpError(409, `A policy named "${p.name}" already exists.`);
  const created = await tx((c) => insertPolicy(c, p, { by: req.user?.username, position: req.body?.position }));
  audit(req, 'notifications.policy.create', { id: created.id, name: p.name, matchers: p.matchers, channels: p.channels });
  res.json({ policy: created, apply: await applyConfig() });
}));

notificationsRouter.put('/notifications/policies/:id', ...manage, wrap(async (req, res) => {
  requireEditable();
  const old = await policyById(req.params.id);
  if (!old) throw httpError(404, 'No such policy.');
  const chanIds = new Set((await listChannels()).map((c) => Number(c.id)));
  const p = cleanPolicy({ ...req.body, ...(old.isDefault ? { matchers: [] } : {}) }, { isDefault: old.isDefault, channelIds: chanIds });
  if (await one('SELECT 1 FROM notification_policies WHERE lower(name) = lower($1) AND id <> $2', [p.name, old.id])) throw httpError(409, `A policy named "${p.name}" already exists.`);
  const r = await updatePolicy(old.id, p);
  audit(req, 'notifications.policy.update', { id: old.id, name: p.name, matchers: p.matchers, channels: p.channels, enabled: p.enabled });
  res.json({ policy: r, apply: await applyConfig() });
}));

notificationsRouter.delete('/notifications/policies/:id', ...manage, wrap(async (req, res) => {
  requireEditable();
  const old = await policyById(req.params.id);
  if (!old) throw httpError(404, 'No such policy.');
  if (old.isDefault) throw httpError(409, 'The Default policy takes every alert no other policy matched: it cannot be deleted (remove its channels to stop it sending).');
  await q('DELETE FROM notification_policies WHERE id = $1', [old.id]);
  audit(req, 'notifications.policy.delete', { id: old.id, name: old.name });
  res.json({ ok: true, apply: await applyConfig() });
}));

notificationsRouter.put('/notifications/policies-order', ...manage, wrap(async (req, res) => {
  requireEditable();
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number);
  const all = (await listPolicies()).filter((p) => !p.isDefault).map((p) => p.id);
  if (ids.length !== all.length || !all.every((id) => ids.includes(id))) throw httpError(400, 'Send every policy id (except Default) once, top to bottom.');
  await reorderPolicies(ids);
  audit(req, 'notifications.policy.order', { ids });
  res.json({ ok: true, apply: await applyConfig() });
}));

notificationsRouter.post('/notifications/policies/preview', wrap(async (req, res) => {
  if (!editable()) return res.json({ policies: [] });
  const labels = {};
  for (const [k, v] of Object.entries(req.body?.labels || {})) if (LABEL_RE.test(k) && typeof v === 'string') labels[k] = v.slice(0, 500);
  const policies = await listPolicies();
  const chans = new Map((await listChannels()).map((c) => [Number(c.id), c]));
  const hit = routeFor(policies, labels);
  res.json({ policies: hit.map((p) => ({ id: p.id, name: p.name, isDefault: p.isDefault, channels: isScoped() ? [] : publicPolicy(p, chans).channelNames.filter((c) => c.enabled) })) });
}));

// ---------------------------------------------------------------- inhibition (read-only: from alertmanager.yml)
// Each rule in plain words, and the alerts it mutes right now (Alertmanager's inhibitedBy -> the source alert).
const toMatchers = (list, legacy, legacyRe) => [
  ...(list || []).map(parseMatcher).filter(Boolean),
  ...Object.entries(legacy || {}).map(([label, value]) => ({ label, op: '=', value: String(value) })),
  ...Object.entries(legacyRe || {}).map(([label, value]) => ({ label, op: '=~', value: String(value) })),
];

notificationsRouter.get('/notifications/inhibition', wrap(async (req, res) => {
  const live = await liveConfig();
  const cfg = live || (editable() ? baseOrEmpty() : {});
  const rules = (cfg.inhibit_rules || []).map((r, i) => ({
    id: i + 1,
    source: toMatchers(r.source_matchers, r.source_match, r.source_match_re),
    target: toMatchers(r.target_matchers, r.target_match, r.target_match_re),
    equal: r.equal || [],
  }));
  let alerts = null;
  try { alerts = await am('/api/v2/alerts'); } catch { /* Alertmanager down */ }
  const visible = (l) => !isScoped() || l.tenant === currentTenant(); // a tenant sees its own muted alerts only
  const byFp = new Map((alerts || []).map((a) => [a.fingerprint, a]));
  const muted = [];
  for (const a of alerts || []) {
    if (!a.status?.inhibitedBy?.length || !visible(a.labels)) continue;
    const by = a.status.inhibitedBy.map((fp) => byFp.get(fp)).filter(Boolean);
    const rule = rules.find((r) => matchAll(r.target, a.labels) && by.some((s) => matchAll(r.source, s.labels) && r.equal.every((k) => (s.labels[k] || '') === (a.labels[k] || ''))));
    muted.push({
      alertname: a.labels.alertname, severity: a.labels.severity || '', host: a.labels.host || a.labels.instance || '', since: a.startsAt,
      by: by.map((s) => ({ alertname: s.labels.alertname, severity: s.labels.severity || '', host: s.labels.host || s.labels.instance || '' })),
      rule: rule?.id || null,
    });
  }
  for (const r of rules) r.mutingNow = muted.filter((m) => m.rule === r.id).length;
  res.json({ rules, muted, alertmanagerReachable: !!alerts, editable: editable() && !isScoped() });
}));
