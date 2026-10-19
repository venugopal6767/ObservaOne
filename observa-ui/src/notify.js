// Notification channels managed in ObservaOne: Email, Microsoft Teams, Slack, Webhook, PagerDuty.
//
// Alertmanager stays the notification engine (grouping, routing, silences, inhibition, retries). ObservaOne keeps the
// channels (secrets encrypted with the app secret) and WRITES Alertmanager's configuration file:
//   the base file (alertmanager/alertmanager.yml: routes, grouping, inhibition)  +  each channel added to its team's
//   receiver ("<team>-team")  +  a route team="<team>" for a new team  +  the email server (SMTP) settings
// then asks Alertmanager to reload. If Alertmanager refuses the new file, the previous one is put back.
// "Send test" sends from ObservaOne itself with exactly the same settings, so it can say what went wrong.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import nodemailer from 'nodemailer';
import { config } from './config.js';
import { q, one } from './db.js';
import { encrypt, decrypt } from './secrets.js';
import { getSetting, setSetting } from './settings.js';
import { ds } from './datasources.js';
import { httpError } from './auth.js';

export const TYPES = {
  email: { name: 'Email', key: 'email_configs' },
  teams: { name: 'Microsoft Teams', key: 'msteamsv2_configs' },
  slack: { name: 'Slack', key: 'slack_configs' },
  webhook: { name: 'Webhook', key: 'webhook_configs' },
  pagerduty: { name: 'PagerDuty', key: 'pagerduty_configs' },
};
export const TEAM_RE = /^[a-z][a-z0-9-]{1,30}$/;
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
const SMARTHOST_RE = /^[A-Za-z0-9.-]+:\d{1,5}$/;

export const editable = () => !!config.alertmanagerConfigFile;

// ---------------------------------------------------------------- input checks
function httpsUrl(v, what, { allowHttp = false } = {}) {
  let u;
  try { u = new URL(String(v || '').trim()); } catch { throw httpError(400, `${what}: enter a full address, starting with https://`); }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw httpError(400, `${what}: must start with https://${allowHttp ? ' or http://' : ''}`);
  if (u.username || u.password) throw httpError(400, `${what}: put credentials in the token field, not in the address`);
  return u.toString();
}
const maskUrl = (url) => { try { const u = new URL(url); return `${u.origin}/…`; } catch { return '(address)'; } };

/** Checks a channel from the UI. `old` = the stored row when editing (empty secret fields keep the stored ones). */
export function cleanChannel(b = {}, old = null) {
  const type = old ? old.type : String(b.type || '');
  if (!TYPES[type]) throw httpError(400, 'Choose a channel type: Email, Microsoft Teams, Slack, Webhook or PagerDuty.');
  const name = String(b.name ?? old?.name ?? '').trim();
  if (!name || name.length > 60) throw httpError(400, 'Give the channel a name (up to 60 characters).');
  const team = String(b.team ?? old?.team ?? '').trim().toLowerCase();
  if (!TEAM_RE.test(team)) throw httpError(400, 'Team: lower-case letters, digits and -, starting with a letter (e.g. platform, infra, payments-ops).');
  const oldSecret = old?.secret ? JSON.parse(decrypt(old.secret)) : {};
  const settings = {}, secret = {};
  let display;
  if (type === 'email') {
    const to = String(b.to ?? old?.settings?.to ?? '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
    if (!to.length) throw httpError(400, 'Enter at least one email address.');
    if (to.length > 20) throw httpError(400, 'Up to 20 email addresses per channel.');
    const bad = to.filter((x) => !EMAIL_RE.test(x));
    if (bad.length) throw httpError(400, `Not an email address: ${bad.join(', ')}`);
    settings.to = to.join(', ');
    display = settings.to;
  } else if (type === 'teams') {
    secret.url = b.webhookUrl ? httpsUrl(b.webhookUrl, 'Teams workflow URL') : oldSecret.url;
    if (!secret.url) throw httpError(400, 'Paste the Teams workflow (webhook) URL.');
    display = maskUrl(secret.url);
  } else if (type === 'slack') {
    secret.url = b.webhookUrl ? httpsUrl(b.webhookUrl, 'Slack webhook URL') : oldSecret.url;
    if (!secret.url) throw httpError(400, 'Paste the Slack incoming-webhook URL.');
    const channel = String(b.channel ?? old?.settings?.channel ?? '').trim();
    if (channel && !/^[#@]?[\w.-]{1,80}$/.test(channel)) throw httpError(400, 'Slack channel: like #alerts');
    if (channel) settings.channel = channel.startsWith('#') || channel.startsWith('@') ? channel : `#${channel}`;
    display = settings.channel || maskUrl(secret.url);
  } else if (type === 'webhook') {
    secret.url = b.url ? httpsUrl(b.url, 'Webhook URL', { allowHttp: true }) : oldSecret.url;
    if (!secret.url) throw httpError(400, 'Enter the webhook URL.');
    const token = b.token === undefined || b.token === '' ? oldSecret.token : String(b.token).trim();
    if (b.clearToken) delete secret.token; else if (token) secret.token = token;
    if (secret.token && (secret.token.length > 4096 || /\s/.test(secret.token))) throw httpError(400, 'Token: no spaces, up to 4096 characters.');
    display = maskUrl(secret.url);
  } else if (type === 'pagerduty') {
    secret.routingKey = b.routingKey ? String(b.routingKey).trim() : oldSecret.routingKey;
    if (!secret.routingKey || !/^[A-Za-z0-9]{20,64}$/.test(secret.routingKey)) throw httpError(400, 'PagerDuty: paste the integration (routing) key of an Events API v2 integration.');
    display = `routing key …${secret.routingKey.slice(-4)}`;
  }
  return {
    name, type, team, settings, display,
    secret: Object.keys(secret).length ? encrypt(JSON.stringify(secret)) : null,
    sendResolved: b.sendResolved === undefined ? (old ? old.send_resolved : true) : !!b.sendResolved,
    enabled: b.enabled === undefined ? (old ? old.enabled : true) : !!b.enabled,
  };
}

// ---------------------------------------------------------------- email server (SMTP)
export async function getSmtp({ withPassword = false } = {}) {
  const s = (await getSetting('smtp')) || {};
  const out = { configured: !!(s.smarthost && s.from), smarthost: s.smarthost || '', from: s.from || '', username: s.username || '', requireTls: s.requireTls !== false, hasPassword: !!s.passwordEnc };
  if (withPassword) out.password = s.passwordEnc ? decrypt(s.passwordEnc) : '';
  return out;
}
export async function saveSmtp(b = {}, by) {
  const old = (await getSetting('smtp')) || {};
  if (b.clear) { await setSetting('smtp', {}, by); return; }
  const smarthost = String(b.smarthost || '').trim(), from = String(b.from || '').trim(), username = String(b.username || '').trim();
  if (!SMARTHOST_RE.test(smarthost)) throw httpError(400, 'Mail server: host:port, e.g. smtp.office365.com:587 or mail.bank.local:25');
  if (!EMAIL_RE.test(from.replace(/^.*<([^>]+)>\s*$/, '$1'))) throw httpError(400, 'From: an email address, e.g. monitoring@bank.local');
  if (username.length > 200) throw httpError(400, 'Username: up to 200 characters.');
  const passwordEnc = b.password ? encrypt(String(b.password)) : (b.clearPassword || !username ? undefined : old.passwordEnc);
  await setSetting('smtp', { smarthost, from, username, requireTls: b.requireTls !== false, ...(passwordEnc ? { passwordEnc } : {}) }, by);
}

// ---------------------------------------------------------------- channels
export async function listChannels() {
  return (await q('SELECT * FROM notification_channels ORDER BY team, lower(name)')).rows;
}
export const publicChannel = (r) => ({
  id: Number(r.id), name: r.name, type: r.type, typeName: TYPES[r.type]?.name || r.type, team: r.team, display: r.display,
  to: r.settings?.to, channel: r.settings?.channel, sendResolved: r.send_resolved, enabled: r.enabled,
  createdBy: r.created_by, updatedAt: r.updated_at,
  lastTest: r.last_test_at ? { at: r.last_test_at, ok: r.last_test_ok, error: r.last_test_error } : null,
});

const secretOf = (r) => (r.secret ? JSON.parse(decrypt(r.secret)) : {});

function amChannel(r) {
  const s = secretOf(r), sr = r.send_resolved;
  switch (r.type) {
    case 'email': return { to: r.settings.to, send_resolved: sr };
    case 'teams': return { webhook_url: s.url, send_resolved: sr };
    case 'slack': return { api_url: s.url, ...(r.settings.channel ? { channel: r.settings.channel } : {}), send_resolved: sr };
    case 'webhook': return { url: s.url, send_resolved: sr, ...(s.token ? { http_config: { authorization: { type: 'Bearer', credentials: s.token } } } : {}) };
    case 'pagerduty': return { routing_key: s.routingKey, send_resolved: sr };
    default: return null;
  }
}

/** Teams that exist: the base file's "<team>-team" receivers + the teams of the channels. */
export function teamsOf(base, channels) {
  const t = new Set((base?.receivers || []).map((r) => /^([a-z][a-z0-9-]*)-team$/.exec(r.name)?.[1]).filter(Boolean));
  for (const c of channels) t.add(c.team);
  return [...t].sort();
}

/** Alertmanager config = base + channels + SMTP. Pure: used by the writer and the tests. */
export function renderConfig(base, channels, smtp) {
  const cfg = structuredClone(base || {});
  cfg.global ||= {};
  if (smtp?.configured) {
    cfg.global.smtp_smarthost = smtp.smarthost;
    cfg.global.smtp_from = smtp.from;
    cfg.global.smtp_require_tls = smtp.requireTls;
    if (smtp.username) { cfg.global.smtp_auth_username = smtp.username; cfg.global.smtp_auth_password = smtp.password || ''; }
  }
  cfg.route ||= {};
  cfg.route.receiver ||= 'platform-team';
  cfg.receivers ||= [];
  const receiver = (team) => {
    const name = `${team}-team`;
    let r = cfg.receivers.find((x) => x.name === name);
    if (!r) { r = { name }; cfg.receivers.push(r); }
    return r;
  };
  for (const c of channels) {
    if (!c.enabled) continue;
    if (c.type === 'email' && !smtp?.configured) continue; // Alertmanager refuses email without a mail server
    const conf = amChannel(c);
    if (!conf) continue;
    const r = receiver(c.team);
    (r[TYPES[c.type].key] ||= []).push(conf);
  }
  // a new team gets its route: alerts with team="<team>" -> "<team>-team" (before the severity routes, like the base)
  const routes = cfg.route.routes || [];
  const routed = new Set(routes.flatMap((r) => (r.matchers || []).map((m) => /^team\s*=\s*"?([a-z0-9-]+)"?$/.exec(String(m))?.[1]).filter(Boolean)));
  const defaultTeam = String(cfg.route.receiver).replace(/-team$/, '');
  const add = [...new Set(channels.map((c) => c.team))].filter((t) => !routed.has(t) && t !== defaultTeam).sort()
    .map((t) => ({ matchers: [`team="${t}"`], receiver: `${t}-team` }));
  for (const t of add) receiver(t.receiver.replace(/-team$/, ''));
  if (add.length || routes.length) cfg.route.routes = [...add, ...routes];
  return cfg;
}

export function readBase() {
  return YAML.parse(fs.readFileSync(config.alertmanagerBaseConfig, 'utf8')) || {};
}

const HEADER = `# WRITTEN BY OBSERVAONE - do not edit here, changes are overwritten.
# Edit routes / grouping / inhibition in alertmanager/alertmanager.yml (the base) and restart observa;
# add channels and the email server in ObservaOne: Alerting -> Notifications.
`;

function writeFile(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp`);
  fs.writeFileSync(tmp, text, { mode: 0o640 }); // the folder's group (Alertmanager's user) can read it, nobody else
  fs.renameSync(tmp, file);
}

async function reloadAlertmanager() {
  const url = ds('alertmanager')?.url;
  if (!url) return { reached: false, error: 'Alertmanager is not configured' };
  try {
    const r = await fetch(`${url}/-/reload`, { method: 'POST', signal: AbortSignal.timeout(10_000) });
    if (r.ok) return { reached: true, ok: true };
    return { reached: true, ok: false, error: (await r.text()).trim().slice(0, 500) || `HTTP ${r.status}` };
  } catch (e) {
    return { reached: false, error: e.cause?.code || e.message };
  }
}

let status = { ok: null, at: null, error: null, pending: false };
let chain = Promise.resolve();
export const applyStatus = () => status;

/** Writes the config and reloads Alertmanager. Serialized; `force` reloads even when the file did not change. */
export function applyConfig({ force = false } = {}) {
  const run = () => doApply(force);
  chain = chain.then(run, run);
  return chain;
}

async function doApply(force) {
  if (!editable()) return status;
  const file = config.alertmanagerConfigFile;
  try {
    const cfg = renderConfig(readBase(), await listChannels(), await getSmtp({ withPassword: true }));
    const text = HEADER + YAML.stringify(cfg, { lineWidth: 0 });
    const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (prev === text && !force) { status = { ...status, ok: status.ok ?? true, at: status.at || new Date().toISOString() }; return status; }
    writeFile(file, text);
    const r = await reloadAlertmanager();
    if (r.reached && !r.ok) {
      if (prev !== null) { writeFile(file, prev); await reloadAlertmanager(); }
      throw new Error(`Alertmanager refused the new configuration (the previous one is kept): ${r.error}`);
    }
    status = { ok: true, at: new Date().toISOString(), error: null, pending: !r.reached };
    if (!r.reached) status.error = `Saved. Alertmanager could not be reached (${r.error}); it uses the new configuration when it is back.`;
  } catch (e) {
    status = { ok: false, at: new Date().toISOString(), error: e.message, pending: false };
    console.error('[notify]', e.message);
  }
  return status;
}

// ---------------------------------------------------------------- test send (from ObservaOne, same settings)
async function post(url, body, headers = {}) {
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    const code = e.cause?.code || e.name;
    throw new Error({ ENOTFOUND: `cannot resolve ${new URL(url).host} (DNS)`, ECONNREFUSED: `${new URL(url).host} refused the connection`,
      TimeoutError: `no answer from ${new URL(url).host} within 15 s (firewall or proxy?)`, CERT_HAS_EXPIRED: 'the server certificate has expired',
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'the server certificate is not trusted', DEPTH_ZERO_SELF_SIGNED_CERT: 'the server certificate is self-signed (not trusted)',
      SELF_SIGNED_CERT_IN_CHAIN: 'the server certificate is not trusted (self-signed CA)' }[code] || `${code}: ${e.cause?.message || e.message}`);
  }
  const text = await r.text().catch(() => '');
  if (!r.ok) throw new Error(`HTTP ${r.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
  return text;
}

export async function sendTest(row, by) {
  const s = secretOf(row);
  const now = new Date().toISOString();
  const title = '[TEST] ObservaOne test notification';
  const text = `This is a test from ObservaOne, sent by ${by} to check the channel "${row.name}" (team ${row.team}). Real alerts for this team arrive here the same way. No action is needed.`;
  const labels = { alertname: 'ObservaOneTestNotification', severity: 'info', team: row.team };
  switch (row.type) {
    case 'email': {
      const m = await getSmtp({ withPassword: true });
      if (!m.configured) throw new Error('Set up the email server first (Alerting -> Notifications -> Email server).');
      const [host, port] = m.smarthost.split(':');
      const t = nodemailer.createTransport({
        host, port: Number(port), secure: Number(port) === 465, requireTLS: m.requireTls && Number(port) !== 465, ignoreTLS: !m.requireTls && Number(port) !== 465,
        auth: m.username ? { user: m.username, pass: m.password } : undefined,
        connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
      });
      try {
        await t.sendMail({ from: m.from, to: row.settings.to, subject: title, text,
          html: `<h3 style="margin:0 0 8px">${title}</h3><p>${text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>` });
      } catch (e) {
        throw new Error(e.responseCode ? `mail server answered ${e.responseCode}: ${String(e.response || e.message).slice(0, 300)}` : `${e.code || 'error'}: ${e.message}`);
      } finally { t.close(); }
      return;
    }
    case 'teams':
      await post(s.url, { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.2', msteams: { width: 'full' },
        body: [{ type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true, color: 'Accent' }, { type: 'TextBlock', text, wrap: true }],
      } }] });
      return;
    case 'slack': {
      const out = await post(s.url, { ...(row.settings.channel ? { channel: row.settings.channel } : {}), text: `*${title}*\n${text}` });
      if (out && out.trim() !== 'ok' && /error|invalid/i.test(out)) throw new Error(out.slice(0, 300));
      return;
    }
    case 'webhook':
      await post(s.url, {
        version: '4', groupKey: '{}:{alertname="ObservaOneTestNotification"}', truncatedAlerts: 0, status: 'firing', receiver: `${row.team}-team`,
        groupLabels: { alertname: labels.alertname }, commonLabels: labels, commonAnnotations: { summary: title, description: text },
        externalURL: config.publicUrl || '', alerts: [{ status: 'firing', labels, annotations: { summary: title, description: text }, startsAt: now,
          endsAt: '0001-01-01T00:00:00Z', generatorURL: '', fingerprint: '0000000000000000' }],
      }, s.token ? { Authorization: `Bearer ${s.token}` } : {});
      return;
    case 'pagerduty': {
      const key = `observaone-test-${Date.now()}`;
      await post('https://events.pagerduty.com/v2/enqueue', { routing_key: s.routingKey, event_action: 'trigger', dedup_key: key, payload: { summary: title, source: 'ObservaOne', severity: 'info', custom_details: { message: text } } });
      await post('https://events.pagerduty.com/v2/enqueue', { routing_key: s.routingKey, event_action: 'resolve', dedup_key: key }).catch(() => {});
      return;
    }
    default: throw new Error('Unknown channel type');
  }
}

export async function recordTest(id, ok, error) {
  await q('UPDATE notification_channels SET last_test_at = now(), last_test_ok = $2, last_test_error = $3 WHERE id = $1', [id, ok, error || null]);
}
export const channelById = (id) => one('SELECT * FROM notification_channels WHERE id = $1', [id]);
