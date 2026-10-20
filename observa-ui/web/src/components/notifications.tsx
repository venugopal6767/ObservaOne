// Alerts -> Notification Channels: where alerts are sent (Email, Microsoft Teams, Slack, Webhook, PagerDuty).
// Create a channel once and use it in notification policies (which alerts go where). ObservaOne writes them into
// Alertmanager's configuration and reloads it; "Test" sends a message right now with the same settings.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, MessageSquare, Hash, Webhook, Siren, Plus, Send, Pencil, Trash2, Server, CheckCircle2, XCircle, Copy, Eye, EyeOff, Power, Route } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { useApp } from '@/app/AppContext';
import { ErrorState, Field, InfoBox, Modal, RowMenu, StateView, TableWrap, Time, copyText, toast, useDialogs } from '@/components/ui';

type ChType = 'email' | 'teams' | 'slack' | 'webhook' | 'pagerduty';
export interface Channel {
  id: number; name: string; type: ChType; typeName: string; team: string | null; display: string; to?: string; channel?: string;
  sendResolved: boolean; enabled: boolean; createdBy?: string; updatedAt: string;
  lastTest: { at: string; ok: boolean; error: string | null } | null;
  usedBy: { id: number; name: string; isDefault: boolean; enabled: boolean }[];
}
interface Smtp { configured: boolean; smarthost?: string; from?: string; username?: string; requireTls?: boolean; hasPassword?: boolean }
interface Apply { ok: boolean | null; at: string | null; error: string | null; pending: boolean }
interface NotifData {
  editable: boolean; managedByObservaOne: boolean; alertmanagerReachable: boolean; apply: Apply;
  smtp: Smtp; channels: Channel[]; fileChannels: { receiver: string; type: string; count: number }[];
  receivers: { name: string; channels: { type: string; count: number }[] }[];
}
interface PolicyLite { id: number; name: string; isDefault: boolean; enabled: boolean }

const ICON: Record<ChType, typeof Mail> = { email: Mail, teams: MessageSquare, slack: Hash, webhook: Webhook, pagerduty: Siren };
const TYPE_NAME: Record<ChType, string> = { email: 'Email', teams: 'Microsoft Teams', slack: 'Slack', webhook: 'Generic Webhook', pagerduty: 'PagerDuty' };
const TYPE_DESC: Record<ChType, string> = {
  email: 'Send alert notifications by email, through your mail server.',
  teams: 'Send alert notifications to a Microsoft Teams channel using a Workflows webhook.',
  slack: 'Send alert notifications to a Slack channel using an Incoming Webhook.',
  webhook: 'Post alerts as JSON (Alertmanager webhook format) to any HTTP endpoint: ITSM, ServiceNow, scripts.',
  pagerduty: 'Open and resolve PagerDuty incidents through the Events API v2.',
};
const TYPE_SHORT: Record<ChType, string> = { email: 'Email through your mail server', teams: 'Teams channel (Workflows)', slack: 'Slack channel (Incoming Webhook)', webhook: 'Any HTTP endpoint (JSON)', pagerduty: 'Incidents (Events API v2)' };
const TYPE_HELP: Record<ChType, string> = {
  email: 'Set up the mail server once with "Email server".',
  teams: 'Teams: the channel ⋯ → Workflows → "Post to a channel when a webhook request is received" → copy the URL.',
  slack: 'Slack: api.slack.com/apps → your app → Incoming Webhooks → Add New Webhook → copy the URL.',
  webhook: 'Any endpoint that accepts JSON POSTs; an optional bearer token is sent as Authorization.',
  pagerduty: 'PagerDuty: a service → Integrations → Events API v2 → copy the Integration Key.',
};

type Status = 'connected' | 'failed' | 'untested' | 'disabled' | 'unused';
function statusOf(c: Channel, smtpReady: boolean): [Status, string] {
  if (!c.enabled) return ['disabled', 'Disabled'];
  if (c.type === 'email' && !smtpReady) return ['failed', 'Needs email server'];
  if (c.lastTest && !c.lastTest.ok) return ['failed', 'Test failed'];
  if (!c.usedBy.length) return ['unused', 'In no policy'];
  if (c.lastTest?.ok) return ['connected', 'Connected'];
  return ['untested', 'Not tested'];
}

export function Notifications() {
  const { can } = useApp();
  const { open, confirm } = useDialogs();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => api<NotifData>('/notifications') });
  const pol = useQuery({ queryKey: ['policies'], queryFn: () => api<{ policies: PolicyLite[] }>('/notifications/policies') });
  const [testing, setTesting] = useState<number | null>(null);
  if (q.isPending) return <TableWrap label="Notification channels"><StateView kind="loading" skeleton="table" /></TableWrap>;
  if (q.isError) return <TableWrap label="Notification channels"><ErrorState error={q.error} what="Notification channels" /></TableWrap>;
  const n = q.data;
  const manage = n.editable && can('notifications.manage');
  const refresh = () => { ['notifications', 'policies', 'notify-teams'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); };
  const afterSave = (apply?: Apply) => { refresh(); if (apply && apply.ok === false) toast(apply.error || 'Alertmanager did not take the change', 'err'); };
  const policies = (pol.data?.policies || []).filter((p) => p.enabled || p.isDefault);

  async function test(c: Pick<Channel, 'id' | 'name'>) {
    setTesting(c.id);
    try {
      const r = await api<{ ok: boolean; error?: string; ms: number }>(`/notifications/channels/${c.id}/test`, { method: 'POST' });
      if (r.ok) toast(`Test sent to "${c.name}" (${r.ms} ms): check that it arrived`);
      else toast(`"${c.name}": ${r.error}`, 'err');
    } catch (e) { toast((e as Error).message, 'err'); } finally { setTesting(null); refresh(); }
  }
  const edit = (c?: Channel, type?: ChType) => open((close) => <ChannelPanel channel={c} initialType={type} smtpReady={n.smtp.configured} policies={policies} onClose={close} onDone={afterSave} onTest={test} />);
  const editSmtp = () => open((close) => <SmtpDialog smtp={n.smtp} onClose={close} onDone={afterSave} />);
  const missing = (Object.keys(TYPE_NAME) as ChType[]).filter((t) => !n.channels.some((c) => c.type === t));

  return (
    <div className="notify">
      {!n.managedByObservaOne && <InfoBox>Channels are set in <code>alertmanager/alertmanager.yml</code> on this installation (AM_CONFIG_FILE is not set), so they are shown here but not edited.</InfoBox>}
      {n.managedByObservaOne && n.apply.ok === false && <InfoBox tone="error">{n.apply.error}</InfoBox>}
      {n.managedByObservaOne && n.apply.ok && n.apply.pending && <InfoBox tone="error">{n.apply.error}</InfoBox>}
      {n.fileChannels.length > 0 && <InfoBox>alertmanager.yml has channels written by hand ({n.fileChannels.map((f) => `${f.type} in ${f.receiver}`).join(', ')}): notification policies do not use them. Add them here as channels.</InfoBox>}
      {n.managedByObservaOne && !n.channels.some((c) => c.enabled && c.usedBy.length) && <InfoBox tone="error">No channel is used by a policy: alerts are only shown in ObservaOne, nobody is notified.</InfoBox>}

      <div className="notify-head">
        <p className="muted" style={{ margin: 0 }}>Create a channel once and reuse it in <Link to="/alerting/policies">notification policies</Link>.</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {manage && <button className="btn" onClick={editSmtp}><Server size={15} aria-hidden /> Email server{n.smtp.configured ? '' : ': not set'}</button>}
          {manage && <button className="btn btn-primary" onClick={() => edit()}><Plus size={15} aria-hidden /> Add Channel</button>}
        </div>
      </div>

      <TableWrap label="Notification channels">
        <table className="tbl channels-tbl">
          <thead><tr><th>Channel</th><th>Details</th><th>Status</th><th>Last Test</th><th>Used by</th>{manage && <th style={{ width: 1 }}>Actions</th>}</tr></thead>
          <tbody>
            {n.channels.map((c) => {
              const Icon = ICON[c.type] || Webhook;
              const [st, stLabel] = statusOf(c, n.smtp.configured);
              return (
                <tr key={c.id} className={c.enabled ? '' : 'row-disabled'}>
                  <td><span className="ch-name"><span className={`ch-ic lg ch-${c.type}`}><Icon size={18} aria-hidden /></span><span><b>{TYPE_NAME[c.type]}</b><span className="dim ch-type">{c.name}</span></span></span></td>
                  <td className="ch-details"><ChannelDetails c={c} smtp={n.smtp} /></td>
                  <td><span className={`ch-status st-${st}`} title={c.lastTest?.error || undefined}><i />{stLabel}</span></td>
                  <td>{c.lastTest ? <span className="test-res"><Time ms={Date.parse(c.lastTest.at)} /><span className={c.lastTest.ok ? 'c-green' : 'c-red'} style={{ fontSize: 12 }}>{c.lastTest.ok ? 'Success' : 'Failed'}</span>
                    {!c.lastTest.ok && <span className="test-err" title={c.lastTest.error || ''}>{c.lastTest.error}</span>}</span> : <span className="dim">—</span>}</td>
                  <td>{c.usedBy.length ? <span className="cond-chips">{c.usedBy.map((p) => <Link key={p.id} to="/alerting/policies" className="ch-chip"><Route size={11} /> {p.isDefault ? 'Default' : p.name}</Link>)}</span> : <span className="c-orange" style={{ fontSize: 12.5 }}>no policy</span>}</td>
                  {manage && <td><div className="row-actions">
                    <button className="btn btn-sm" disabled={testing === c.id || !c.enabled} onClick={() => test(c)}><Send size={13} aria-hidden /> {testing === c.id ? 'Sending…' : 'Test'}</button>
                    <button className="btn btn-sm" onClick={() => edit(c)}><Pencil size={13} aria-hidden /> Edit</button>
                    <RowMenu label={`More actions for ${c.name}`} items={[
                      { label: c.enabled ? 'Disable' : 'Enable', icon: <Power size={14} />, onClick: async () => {
                        try { const r = await api<{ apply: Apply }>(`/notifications/channels/${c.id}`, { method: 'PUT', body: { enabled: !c.enabled } }); toast(`${c.name} ${c.enabled ? 'disabled' : 'enabled'}`); afterSave(r.apply); } catch (e) { toast((e as Error).message, 'err'); }
                      } },
                      { label: 'Delete', danger: true, icon: <Trash2 size={14} />, onClick: async () => {
                        if (!(await confirm('Delete channel', <>Alerts stop going to <b>{c.name}</b>; it is removed from {c.usedBy.length} polic{c.usedBy.length === 1 ? 'y' : 'ies'}.</>, 'Delete'))) return;
                        try { const r = await api<{ apply: Apply }>(`/notifications/channels/${c.id}`, { method: 'DELETE' }); toast('Channel deleted'); afterSave(r.apply); } catch (e) { toast((e as Error).message, 'err'); }
                      } },
                    ]} />
                  </div></td>}
                </tr>
              );
            })}
            {manage && missing.map((t) => { const Icon = ICON[t]; return (
              <tr key={t} className="row-placeholder">
                <td><span className="ch-name"><span className={`ch-ic lg ch-${t}`}><Icon size={18} aria-hidden /></span><span><b>{TYPE_NAME[t]}</b><span className="dim ch-type">{TYPE_SHORT[t]}</span></span></span></td>
                <td className="dim">—</td>
                <td><span className="ch-status st-none"><i />Not configured</span></td><td className="dim">—</td><td className="dim">—</td>
                <td><button className="btn btn-sm" onClick={() => edit(undefined, t)}><Plus size={13} /> Configure</button></td>
              </tr>
            ); })}
            {!manage && !n.channels.length && <tr><td colSpan={5} className="dim" style={{ padding: 18 }}>No channels managed in ObservaOne.</td></tr>}
          </tbody>
        </table>
      </TableWrap>
      {!n.managedByObservaOne && n.receivers.length > 0 && (
        <TableWrap label="Alertmanager receivers">
          <table className="tbl"><thead><tr><th>Receiver</th><th>Channels</th></tr></thead>
            <tbody>{n.receivers.map((r) => <tr key={r.name}><td><b>{r.name}</b></td><td>{r.channels.map((c) => `${c.type} ×${c.count}`).join(', ') || '—'}</td></tr>)}</tbody></table>
        </TableWrap>
      )}
      {n.smtp.configured && <p className="muted" style={{ marginTop: 10 }}>Email goes through <span className="mono">{n.smtp.smarthost}</span> from <span className="mono">{n.smtp.from}</span>.</p>}
    </div>
  );
}

function ChannelDetails({ c, smtp }: { c: Channel; smtp: Smtp }) {
  const row = (k: string, v: React.ReactNode, copy?: string) => <div className="ch-det"><span className="dim">{k}:</span> <span className="mono ell">{v}</span>{copy && <button className="icon-btn xs" aria-label={`Copy ${k}`} title="Copy" onClick={() => copyText(copy)}><Copy size={12} /></button>}</div>;
  switch (c.type) {
    case 'email': return <>{row('To', c.to, c.to)}{row('SMTP', smtp.configured ? smtp.smarthost : <span className="c-orange">not set</span>)}{smtp.from && row('From', smtp.from)}</>;
    case 'slack': return <>{c.channel && row('Channel', c.channel)}{row('Webhook', c.display)}</>;
    case 'teams': return <>{row('Webhook', c.display)}</>;
    case 'webhook': return <>{row('URL', c.display)}{row('Method', 'POST')}</>;
    case 'pagerduty': return <>{row('Routing key', c.display)}</>;
    default: return <>{c.display}</>;
  }
}

/** What an alert will look like in this channel (the layout ObservaOne writes for Alertmanager). */
export function MessagePreview({ type, name }: { type: ChType; name: string }) {
  const now = new Date(); const hhmm = now.toTimeString().slice(0, 5);
  const line = <>server-01: CPU usage is 94.0% on server-01 (&gt; 80%)</>;
  if (type === 'slack') return (
    <div className="mp mp-slack">
      <div className="mp-who"><span className="mp-av">O</span><b>ObservaOne</b><span className="mp-app">APP</span><span className="dim">{hhmm}</span></div>
      <div className="mp-att" style={{ borderColor: '#e01e5a' }}>
        <div className="mp-title">🔴 FIRING: HighCPUUsage · critical · prod</div>
        <div>• <b>{line}</b></div>
        <div className="mp-sub">since today {hhmm} · <a>Details</a> · <a>Host</a> · <a>Runbook</a></div>
        <span className="mp-btn">Open in ObservaOne</span>
        <div className="mp-foot">ObservaOne · team platform</div>
      </div>
    </div>
  );
  if (type === 'teams') return (
    <div className="mp mp-teams">
      <div className="mp-who"><b>ObservaOne alerts</b><span className="dim">via Workflows · {hhmm}</span></div>
      <div className="mp-card"><div className="mp-title">🔴 FIRING: HighCPUUsage · critical · prod</div>
        <div>• <b>server-01</b>: CPU usage is 94.0% on server-01 (&gt; 80%) · since {hhmm} · <a>Details</a> · <a>Host</a> · <a>Runbook</a></div>
        <div className="mp-foot">ObservaOne · team platform · <a>Open in ObservaOne</a></div></div>
    </div>
  );
  if (type === 'email') return (
    <div className="mp mp-email">
      <div className="mp-hdr"><span className="dim">Subject</span> [FIRING:1] HighCPUUsage prod critical (server-01)</div>
      <div className="mp-hdr"><span className="dim">To</span> {name || 'oncall@company.com'}</div>
      <div className="mp-body"><b>1 alert for alertname=HighCPUUsage</b><br />summary: CPU usage is 94.0% on server-01 (&gt; 80%)<br />host: server-01 · env: prod · severity: critical<br /><span className="dim">Alertmanager's standard email layout.</span></div>
    </div>
  );
  if (type === 'pagerduty') return (
    <div className="mp mp-email">
      <div className="mp-hdr"><span className="dim">Incident</span> [FIRING:1] HighCPUUsage prod critical</div>
      <div className="mp-body">Severity: critical · Source: ObservaOne (Alertmanager)<br />Details: host server-01, summary, labels<br /><span className="dim">Resolved automatically when the alert resolves.</span></div>
    </div>
  );
  return (
    <pre className="mp mp-json">{`POST ${name || 'https://api.company.com/alerts'}
{
  "status": "firing",
  "receiver": "policy-1",
  "commonLabels": { "alertname": "HighCPUUsage", "severity": "critical", "env": "prod" },
  "alerts": [{
    "labels": { "host": "server-01", ... },
    "annotations": { "summary": "CPU usage is 94.0% on server-01 (> 80%)" },
    "startsAt": "${now.toISOString().slice(0, 19)}Z"
  }]
}`}</pre>
  );
}

function ChannelPanel({ channel, initialType, smtpReady, policies, onClose, onDone, onTest }: {
  channel?: Channel; initialType?: ChType; smtpReady: boolean; policies: PolicyLite[]; onClose: () => void; onDone: (a?: Apply) => void; onTest: (c: Pick<Channel, 'id' | 'name'>) => Promise<void>;
}) {
  const editing = !!channel;
  const [type, setType] = useState<ChType>(channel?.type || initialType || 'slack');
  const [name, setName] = useState(channel?.name || '');
  const [to, setTo] = useState(channel?.to || '');
  const [url, setUrl] = useState('');
  const [showUrl, setShowUrl] = useState(false);
  const [token, setToken] = useState('');
  const [slackChannel, setSlackChannel] = useState(channel?.channel || '');
  const [routingKey, setRoutingKey] = useState('');
  const [sendResolved, setSendResolved] = useState(channel?.sendResolved ?? true);
  const [pols, setPols] = useState<number[]>(channel ? channel.usedBy.map((p) => p.id) : policies.filter((p) => p.isDefault).map((p) => p.id));
  const [testing, setTesting] = useState(false);
  const needsUrl = (type === 'teams' || type === 'slack' || type === 'webhook') && !editing;
  const ready = !!name.trim() && (type !== 'email' || (!!to.trim() && smtpReady)) && (!needsUrl || !!url.trim()) && (type !== 'pagerduty' || editing || !!routingKey.trim());
  const body = () => ({
    name: name.trim(), type, sendResolved, policies: pols,
    ...(type === 'email' ? { to } : {}),
    ...(type === 'teams' || type === 'slack' ? (url.trim() ? { webhookUrl: url.trim() } : {}) : {}),
    ...(type === 'slack' ? { channel: slackChannel.trim() } : {}),
    ...(type === 'webhook' ? { ...(url.trim() ? { url: url.trim() } : {}), ...(token.trim() ? { token: token.trim() } : {}) } : {}),
    ...(type === 'pagerduty' && routingKey.trim() ? { routingKey: routingKey.trim() } : {}),
  });
  const save = async (thenTest: boolean) => {
    const r = await api<{ channel: Channel; apply: Apply }>(editing ? `/notifications/channels/${channel!.id}` : '/notifications/channels', { method: editing ? 'PUT' : 'POST', body: body() });
    toast(editing ? 'Channel saved' : `Channel "${r.channel.name}" added`);
    onDone(r.apply);
    if (thenTest) await onTest(r.channel);
  };
  const Icon = ICON[type];
  const secretHint = editing ? 'Leave empty to keep the stored one.' : 'Stored encrypted; shown masked afterwards.';
  return (
    <Modal drawer title={editing ? `Configure ${TYPE_NAME[type]} Channel` : 'Add Notification Channel'} onClose={onClose} actions={[
      { label: 'Cancel' },
      ...(editing ? [] : [{ label: 'Save and test', disabled: !ready, onClick: () => save(true) }]),
      { label: editing ? 'Save Changes' : 'Save', primary: true, disabled: !ready, onClick: () => save(false) },
    ]}>
      <div className="notify-form">
        {!editing ? (
          <div className="type-picker" role="radiogroup" aria-label="Channel type">
            {(Object.keys(TYPE_NAME) as ChType[]).map((t) => { const I = ICON[t]; return <button key={t} type="button" role="radio" aria-checked={type === t} className={`type-opt ${type === t ? 'on' : ''}`} onClick={() => setType(t)}><I size={18} aria-hidden /><span>{TYPE_NAME[t].replace('Generic ', '')}</span></button>; })}
          </div>
        ) : null}
        <div className="cp-head"><span className={`ch-ic lg ch-${type}`}><Icon size={20} /></span><div><b>{TYPE_NAME[type]}</b><div className="dim" style={{ fontSize: 12.5 }}>{TYPE_DESC[type]}</div></div></div>
        {type === 'email' && !smtpReady && <InfoBox tone="error">Set up the email server first: close this and use <b>Email server</b>.</InfoBox>}
        <Field label="Channel Name"><input className="input" placeholder={{ email: 'Production Email', teams: 'Operations Channel', slack: 'Production Slack', webhook: 'ITSM webhook', pagerduty: 'Production On-Call' }[type]} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        {type === 'email' && <Field label="Email addresses" hint="Comma separated, up to 20."><input className="input" placeholder="oncall@company.com, platform-lead@company.com" value={to} onChange={(e) => setTo(e.target.value)} /></Field>}
        {(type === 'teams' || type === 'slack' || type === 'webhook') && (
          <Field label={type === 'teams' ? 'Workflow URL' : type === 'slack' ? 'Webhook URL' : 'URL'} hint={<>{TYPE_HELP[type]} {secretHint}</>}>
            <div className="input-with-btn">
              <input className="input mono" type={showUrl ? 'text' : 'password'} placeholder={editing ? channel!.display : 'https://…'} value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" />
              <button type="button" className="icon-btn" aria-label={showUrl ? 'Hide URL' : 'Show URL'} onClick={() => setShowUrl(!showUrl)}>{showUrl ? <EyeOff size={15} /> : <Eye size={15} />}</button>
            </div>
          </Field>
        )}
        {type === 'slack' && <Field label="Channel (optional)" hint="Overrides the webhook's own channel."><input className="input" placeholder="#platform-alerts" value={slackChannel} onChange={(e) => setSlackChannel(e.target.value)} /></Field>}
        {type === 'webhook' && <Field label="Bearer token (optional)" hint={editing ? 'Leave empty to keep the stored one.' : 'Sent as "Authorization: Bearer …"; stored encrypted.'}><input className="input mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" /></Field>}
        {type === 'pagerduty' && <Field label="Integration (routing) key" hint={<>{TYPE_HELP.pagerduty} {secretHint}</>}><input className="input mono" type="password" placeholder={editing ? channel!.display : ''} value={routingKey} onChange={(e) => setRoutingKey(e.target.value)} autoComplete="new-password" /></Field>}
        <label className="check-row"><input type="checkbox" checked={sendResolved} onChange={(e) => setSendResolved(e.target.checked)} /> Also notify when an alert is resolved</label>

        <h4>Send alerts of these policies</h4>
        {!policies.length ? <p className="dim">No policy yet.</p> : (
          <div className="ch-checks">
            {policies.map((p) => (
              <label key={p.id} className="check-row"><input type="checkbox" checked={pols.includes(p.id)} onChange={(e) => setPols(e.target.checked ? [...pols, p.id] : pols.filter((x) => x !== p.id))} /> {p.isDefault ? 'Default (every alert no other policy matched)' : p.name}</label>
            ))}
          </div>
        )}
        {!pols.length && <p className="c-orange" style={{ fontSize: 12.5, margin: '4px 0 0' }}>In no policy: nothing will be sent here until a policy uses it.</p>}

        <h4>Message preview</h4>
        <MessagePreview type={type} name={type === 'email' ? to : type === 'webhook' ? url : name} />

        {editing && (
          <div className="cp-test">
            <span className="ic">{channel!.lastTest?.ok ? <CheckCircle2 size={18} className="c-green" /> : channel!.lastTest ? <XCircle size={18} className="c-red" /> : <Send size={18} className="dim" />}</span>
            <div style={{ flex: 1 }}><b>Test notification</b><div className="dim" style={{ fontSize: 12.5 }}>A test message is sent now to this channel with the saved settings.</div>
              {channel!.lastTest && <div style={{ fontSize: 12.5, marginTop: 4 }}>Last tested <Time ms={Date.parse(channel!.lastTest.at)} />: <span className={channel!.lastTest.ok ? 'c-green' : 'c-red'}>{channel!.lastTest.ok ? 'Success' : channel!.lastTest.error}</span></div>}
            </div>
            <button className="btn btn-sm" disabled={testing || !channel!.enabled} onClick={async () => { setTesting(true); try { await onTest(channel!); } finally { setTesting(false); } }}>{testing ? 'Sending…' : 'Send Test Notification'}</button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function SmtpDialog({ smtp, onClose, onDone }: { smtp: Smtp; onClose: () => void; onDone: (a?: Apply) => void }) {
  const [smarthost, setHost] = useState(smtp.smarthost || '');
  const [from, setFrom] = useState(smtp.from || '');
  const [username, setUser] = useState(smtp.username || '');
  const [password, setPassword] = useState('');
  const [requireTls, setTls] = useState(smtp.requireTls ?? true);
  const hostOk = /^[A-Za-z0-9.-]+:\d{1,5}$/.test(smarthost.trim());
  const save = (clear = false) => async () => {
    const r = await api<{ apply: Apply }>('/notifications/smtp', { method: 'PUT', body: clear ? { clear: true } : { smarthost: smarthost.trim(), from: from.trim(), username: username.trim(), password: password || undefined, requireTls } });
    toast(clear ? 'Email server removed' : 'Email server saved');
    onDone(r.apply);
  };
  return (
    <Modal title="Email server" wide onClose={onClose} actions={[
      ...(smtp.configured ? [{ label: 'Remove', danger: true, onClick: save(true) }] : []),
      { label: 'Cancel' },
      { label: 'Save', primary: true, disabled: !hostOk || !from.trim(), onClick: save() },
    ]}>
      <p className="muted" style={{ marginTop: 0 }}>Alertmanager sends alert emails through this server. Use "Send test" on an email channel to check it.</p>
      <div className="form-row">
        <Field label="Mail server" hint="host:port: 587 (STARTTLS), 465 (TLS) or 25"><input className="input mono" placeholder="smtp.office365.com:587" value={smarthost} onChange={(e) => setHost(e.target.value)} aria-invalid={!!smarthost && !hostOk} /></Field>
        <Field label="From"><input className="input" placeholder="ObservaOne <monitoring@bank.local>" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
      </div>
      <div className="form-row">
        <Field label="Username (optional)" hint="Empty = the server accepts mail without signing in (internal relay)."><input className="input" value={username} onChange={(e) => setUser(e.target.value)} autoComplete="off" /></Field>
        <Field label="Password" hint={smtp.hasPassword ? 'Stored. Leave empty to keep it.' : 'Stored encrypted.'}><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" disabled={!username.trim()} /></Field>
      </div>
      <label className="check-row"><input type="checkbox" checked={requireTls} onChange={(e) => setTls(e.target.checked)} /> Require TLS (STARTTLS); turn off only for an internal relay without TLS</label>
    </Modal>
  );
}

/** Team names for "Notify" in Create alert (from the channels and the Alertmanager config). */
export function useNotifyTeams() {
  return useQuery({ queryKey: ['notify-teams'], queryFn: () => api<string[]>('/notifications/teams').catch(() => ['infra', 'ops', 'platform']), staleTime: 60_000 });
}
