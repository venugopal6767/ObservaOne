// Notification channels API (Alerting -> Notifications). See notify.js for how they reach Alertmanager.
//
//   GET    /notifications                    channels, email server, teams and routes, last apply status
//   GET    /notifications/teams              team names (Create alert's "Notify" list)
//   POST   /notifications/channels           add a channel            { name, type, team, to | webhookUrl | url, token | routingKey, ... }
//   PUT    /notifications/channels/:id       change it (empty secret fields keep the stored ones)
//   DELETE /notifications/channels/:id
//   POST   /notifications/channels/:id/test  send a test message now  -> { ok, error? }
//   PUT    /notifications/smtp               email server             { smarthost, from, username, password, requireTls } | { clear }
//   POST   /notifications/apply              write + reload again (after editing the base file)
//
// Channels belong to the platform: a tenant user sees the team names only, and cannot change anything here.
import express from 'express';
import YAML from 'yaml';
import { requirePerm, httpError } from '../auth.js';
import { audit } from '../store.js';
import { am } from '../datasources.js';
import { isScoped } from '../tenancy.js';
import { q, one } from '../db.js';
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
  const live = await liveConfig();
  res.json(teamsOf(editable() ? baseOrEmpty() : live || {}, editable() ? await listChannels() : []));
}));

notificationsRouter.get('/notifications', wrap(async (req, res) => {
  const live = await liveConfig();
  const rows = isScoped() ? [] : (editable() ? await listChannels() : []);
  const smtp = await getSmtp();
  const cfg = live || {};
  const defaultTeam = String(cfg.route?.receiver || 'platform-team').replace(/-team$/, '');
  // routes as Alertmanager runs them: which alerts go to which team
  const routes = (cfg.route?.routes || []).map((r) => ({
    matchers: (r.matchers || []).map(String), team: String(r.receiver || '').replace(/-team$/, ''), repeat: r.repeat_interval || null,
  }));
  const fileCfg = editable() ? baseOrEmpty() : cfg; // hand-written channels: the base file, not what ObservaOne added
  const teams = teamsOf(fileCfg, rows).map((t) => ({
    name: t, isDefault: t === defaultTeam,
    channels: rows.filter((c) => c.team === t).map((c) => Number(c.id)),
    // channels written by hand in the base file (shown, not editable here)
    fileChannels: (fileCfg.receivers || []).filter((r) => r.name === `${t}-team`).flatMap((r) => Object.keys(r).filter((k) => k.endsWith('_configs'))
      .map((k) => ({ type: k.replace('_configs', ''), count: (r[k] || []).length }))),
  }));
  res.json({
    editable: editable() && !isScoped(),
    managedByObservaOne: editable(),
    alertmanagerReachable: !!live,
    apply: applyStatus(),
    types: Object.entries(TYPES).map(([id, t]) => ({ id, name: t.name })),
    smtp: isScoped() ? { configured: smtp.configured } : smtp,
    channels: rows.map(publicChannel),
    teams, defaultTeam, routes,
    route: { groupBy: cfg.route?.group_by || [], groupWait: cfg.route?.group_wait || '30s', repeat: cfg.route?.repeat_interval || '4h' },
  });
}));

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
  audit(req, 'notifications.channel.create', { id: r.id, name: c.name, type: c.type, team: c.team });
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
  audit(req, 'notifications.channel.update', { id: r.id, name: c.name, team: c.team, enabled: c.enabled });
  res.json({ channel: publicChannel(r), apply: await applyConfig() });
}));

notificationsRouter.delete('/notifications/channels/:id', ...manage, wrap(async (req, res) => {
  requireEditable();
  const r = await one('DELETE FROM notification_channels WHERE id = $1 RETURNING id, name, type, team', [req.params.id]);
  if (!r) throw httpError(404, 'No such channel.');
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
