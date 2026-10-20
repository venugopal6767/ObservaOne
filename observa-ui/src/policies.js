// Notification policies: WHICH alerts go to WHICH channels, and how they are grouped and repeated.
//
//   policy = conditions (label equals / not equals / matches / does not match a value) -> channels
//            + grouping (group by, wait, interval, repeat) + "continue" (also check the policies below)
//   policies are checked top to bottom, the first match sends (Alertmanager's own rule); the Default policy takes
//   everything no policy matched. A rule can also name its policy (label observaone_policy="p<id>"), which wins.
//
// ObservaOne writes them as Alertmanager routes + receivers (notify.js renderConfig). Before policies, a channel
// belonged to a team; convertLegacy() turns that setup (and the base file's routes) into policies once.
import { q, one, tx } from './db.js';
import { httpError } from './auth.js';
import { getSetting, setSetting } from './settings.js';

export const LABEL_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,99}$/;
export const OPS = ['=', '!=', '=~', '!~'];
export const SELECT_LABEL = 'observaone_policy';
const DURATION_RE = /^(\d+(ms|s|m|h|d|w))+$/;
const TIMING = ['groupWait', 'groupInterval', 'repeatInterval'];

// ---------------------------------------------------------------- matchers
const quote = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
export const matcherString = (m) => `${m.label}${m.op}${quote(m.value)}`;

/** 'team="infra"' | "severity=~critical|warning" -> { label, op, value } (null when not understood) */
export function parseMatcher(s) {
  const m = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)\s*(.*?)\s*$/.exec(String(s));
  if (!m) return null;
  let v = m[3];
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return { label: m[1], op: m[2], value: v };
}

/** Does an alert with these labels meet every condition? (regexes are anchored, like Alertmanager) */
export function matchesAll(matchers, labels) {
  return (matchers || []).every((m) => {
    const v = labels?.[m.label] ?? '';
    if (m.op === '=') return v === m.value;
    if (m.op === '!=') return v !== m.value;
    let re;
    try { re = new RegExp(`^(?:${m.value})$`); } catch { return false; }
    return m.op === '=~' ? re.test(v) : !re.test(v);
  });
}

/** The policies an alert goes to, in Alertmanager's order (explicit choice first, then conditions, else Default). */
export function routeFor(policies, labels) {
  const list = policies.filter((p) => p.enabled && !p.isDefault).sort((a, b) => a.position - b.position);
  const chosen = labels?.[SELECT_LABEL] && list.find((p) => `p${p.id}` === labels[SELECT_LABEL]);
  if (chosen) return [chosen];
  const out = [];
  for (const p of list) {
    if (!matchesAll(p.matchers, labels)) continue;
    out.push(p);
    if (!p.continue) return out;
  }
  if (!out.length) { const d = policies.find((p) => p.isDefault); if (d) out.push(d); }
  return out;
}

// ---------------------------------------------------------------- input checks
export function cleanPolicy(b = {}, { isDefault = false, channelIds = null } = {}) {
  const name = String(b.name || '').trim();
  if (!name || name.length > 80) throw httpError(400, 'Give the policy a name (up to 80 characters).');
  const description = String(b.description || '').trim().slice(0, 500);
  const matchers = isDefault ? [] : (Array.isArray(b.matchers) ? b.matchers : []).map((m, i) => {
    const label = String(m?.label || '').trim(), op = String(m?.op || '='), value = String(m?.value ?? '');
    if (!LABEL_RE.test(label)) throw httpError(400, `Condition ${i + 1}: label name like severity, env, team, service (letters, digits, _).`);
    if (!OPS.includes(op)) throw httpError(400, `Condition ${i + 1}: comparison must be equals, not equals, matches or does not match.`);
    if (value.length > 500) throw httpError(400, `Condition ${i + 1}: value up to 500 characters.`);
    if (op.includes('~')) { try { new RegExp(value); } catch (e) { throw httpError(400, `Condition ${i + 1}: not a valid pattern (${e.message}).`); } }
    if (label === SELECT_LABEL) throw httpError(400, `Condition ${i + 1}: ${SELECT_LABEL} is set by "Notification policy" in Create alert.`);
    return { label, op, value };
  });
  if (matchers.length > 20) throw httpError(400, 'Up to 20 conditions.');
  const channels = [...new Set((Array.isArray(b.channels) ? b.channels : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (channelIds) { const bad = channels.filter((c) => !channelIds.has(c)); if (bad.length) throw httpError(400, `Unknown channel: ${bad.join(', ')}`); }
  let groupBy = null;
  if (Array.isArray(b.groupBy)) {
    groupBy = b.groupBy.map((x) => String(x).trim()).filter(Boolean);
    if (groupBy.some((x) => x !== '...' && !LABEL_RE.test(x))) throw httpError(400, 'Group by: label names (or "..." for one notification per alert).');
  }
  const timing = {};
  for (const k of TIMING) {
    const v = b[k] === undefined || b[k] === null || b[k] === '' ? null : String(b[k]).trim();
    if (v !== null && !DURATION_RE.test(v)) throw httpError(400, `${k}: a duration like 30s, 5m, 4h.`);
    timing[k] = v;
  }
  return { name, description, matchers, channels, groupBy, ...timing, continue: !!b.continue && !isDefault, enabled: isDefault ? true : b.enabled !== false };
}

// ---------------------------------------------------------------- storage
const fromRow = (r) => ({
  id: Number(r.id), name: r.name, description: r.description, matchers: r.matchers || [], channels: (r.channel_ids || []).map(Number),
  groupBy: r.group_by, groupWait: r.group_wait, groupInterval: r.group_interval, repeatInterval: r.repeat_interval,
  continue: r.continue_matching, enabled: r.enabled, isDefault: r.is_default, position: r.position, createdBy: r.created_by, updatedAt: r.updated_at,
});
export async function listPolicies() {
  return (await q('SELECT * FROM notification_policies ORDER BY is_default, position, id')).rows.map(fromRow);
}
export async function policyById(id) {
  const r = await one('SELECT * FROM notification_policies WHERE id = $1', [id]);
  return r ? fromRow(r) : null;
}

const COLS = 'name, description, matchers, channel_ids, group_by, group_wait, group_interval, repeat_interval, continue_matching, enabled';
const vals = (p) => [p.name, p.description || '', JSON.stringify(p.matchers || []), JSON.stringify(p.channels || []), p.groupBy ? JSON.stringify(p.groupBy) : null,
  p.groupWait || null, p.groupInterval || null, p.repeatInterval || null, !!p.continue, p.enabled !== false];

export async function insertPolicy(c, p, { isDefault = false, position, by } = {}) {
  const pos = position ?? Number((await c.query('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM notification_policies WHERE NOT is_default')).rows[0].n);
  return fromRow((await c.query(`INSERT INTO notification_policies (${COLS}, is_default, position, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [...vals(p), isDefault, pos, by || null])).rows[0]);
}
export async function updatePolicy(id, p) {
  const r = await one(`UPDATE notification_policies SET name=$2, description=$3, matchers=$4, channel_ids=$5, group_by=$6, group_wait=$7,
    group_interval=$8, repeat_interval=$9, continue_matching=$10, enabled=$11, updated_at=now() WHERE id=$1 RETURNING *`, [id, ...vals(p)]);
  return r ? fromRow(r) : null;
}
export async function reorderPolicies(ids) {
  await tx(async (c) => {
    let i = 1;
    for (const id of ids) await c.query('UPDATE notification_policies SET position = $2 WHERE id = $1 AND NOT is_default', [id, i++]);
  });
}
/** A deleted channel leaves every policy. */
export async function dropChannelFromPolicies(channelId) {
  await q(`UPDATE notification_policies SET channel_ids = COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(channel_ids) x WHERE x::bigint <> $1), '[]'::jsonb)
           WHERE channel_ids @> to_jsonb($1::bigint)`, [channelId]);
}

// ---------------------------------------------------------------- from teams to policies (once)
const nameFor = (matchers) => {
  const t = matchers.find((m) => m.label === 'team' && m.op === '=');
  if (t && matchers.length === 1) return `Team ${t.value}`;
  const sev = matchers.find((m) => m.label === 'severity' && m.op === '='), env = matchers.find((m) => m.label === 'env' && m.op === '=');
  if (sev && (matchers.length === 1 || (env && matchers.length === 2))) return `${sev.value[0].toUpperCase()}${sev.value.slice(1)} alerts${env ? ` in ${env.value}` : ''}`;
  return matchers.map(matcherString).join(', ').slice(0, 80) || 'Policy';
};

/** Pure: the policies that send alerts exactly where the team setup (base routes + channel teams) sent them. */
export function convertLegacy(base, channels) {
  const route = base?.route || {};
  const teamOf = (receiver) => String(receiver || '').replace(/-team$/, '');
  const defaultTeam = teamOf(route.receiver || 'platform-team');
  const chans = (team) => channels.filter((c) => c.team === team).map((c) => Number(c.id));
  const timing = (r) => ({ groupBy: r.group_by || null, groupWait: r.group_wait || null, groupInterval: r.group_interval || null, repeatInterval: r.repeat_interval || null });
  const routed = new Set();
  const fromBase = (route.routes || []).map((r) => {
    const matchers = (r.matchers || []).map(parseMatcher).filter(Boolean);
    const team = teamOf(r.receiver || route.receiver);
    const t = matchers.find((m) => m.label === 'team' && m.op === '=');
    if (t) routed.add(t.value);
    return { name: nameFor(matchers), description: `Converted from the route to team ${team}.`, matchers, channels: chans(team), ...timing(r), continue: !!r.continue, enabled: true };
  });
  // teams that only existed on channels had their route first (renderConfig of the team setup)
  const extra = [...new Set(channels.map((c) => c.team).filter(Boolean))].filter((t) => !routed.has(t) && t !== defaultTeam).sort()
    .map((t) => ({ name: `Team ${t}`, description: `Converted from team ${t}.`, matchers: [{ label: 'team', op: '=', value: t }], channels: chans(t), groupBy: null, groupWait: null, groupInterval: null, repeatInterval: null, continue: false, enabled: true }));
  const def = { name: 'Default', description: 'Every alert no other policy matched.', matchers: [], channels: chans(defaultTeam), ...timing(route), continue: false, enabled: true };
  if (!def.groupBy) def.groupBy = ['alertname', 'severity', 'env'];
  return { policies: [...extra, ...fromBase], defaultPolicy: def };
}

/** On start: create the policies from the team setup once (and a Default policy on a new installation). */
export async function ensurePolicies(readBase, listChannels) {
  if ((await getSetting('notify.policies'))?.converted) return false;
  if (Number((await one('SELECT count(*) AS n FROM notification_policies')).n) > 0) { await setSetting('notify.policies', { converted: true, at: new Date().toISOString() }); return false; }
  let base = {};
  try { base = readBase(); } catch { /* no base file: defaults */ }
  const { policies, defaultPolicy } = convertLegacy(base, await listChannels());
  await tx(async (c) => {
    let i = 1;
    for (const p of policies) await insertPolicy(c, p, { position: i++, by: 'conversion' });
    await insertPolicy(c, defaultPolicy, { isDefault: true, position: 0, by: 'conversion' });
  });
  await setSetting('notify.policies', { converted: true, at: new Date().toISOString(), count: policies.length + 1 });
  console.log(`[notify] notification policies created from the team setup: ${policies.length} + Default`);
  return true;
}
