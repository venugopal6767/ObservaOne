// Alerting -> Notifications: where alerts are sent. Channels (Email, Microsoft Teams, Slack, Webhook, PagerDuty) belong
// to a team; Alertmanager sends an alert to the team named on it (the rule's "Notify"), or to the default team.
// ObservaOne writes Alertmanager's configuration from these and reloads it; "Send test" sends a message right now.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, MessageSquare, Hash, Webhook, Siren, Plus, Send, Pencil, Trash2, Server, CheckCircle2, XCircle, ArrowRight } from 'lucide-react';
import { api } from '@/lib/api';
import { useApp } from '@/app/AppContext';
import { ErrorState, Field, InfoBox, Modal, Pill, Select, StateView, TableWrap, Time, toast, useDialogs } from '@/components/ui';

type ChType = 'email' | 'teams' | 'slack' | 'webhook' | 'pagerduty';
export interface Channel {
  id: number; name: string; type: ChType; typeName: string; team: string; display: string; to?: string; channel?: string;
  sendResolved: boolean; enabled: boolean; createdBy?: string; updatedAt: string;
  lastTest: { at: string; ok: boolean; error: string | null } | null;
}
interface Smtp { configured: boolean; smarthost?: string; from?: string; username?: string; requireTls?: boolean; hasPassword?: boolean }
interface Apply { ok: boolean | null; at: string | null; error: string | null; pending: boolean }
interface NotifData {
  editable: boolean; managedByObservaOne: boolean; alertmanagerReachable: boolean; apply: Apply;
  smtp: Smtp; channels: Channel[]; defaultTeam: string;
  teams: { name: string; isDefault: boolean; channels: number[]; fileChannels: { type: string; count: number }[] }[];
  routes: { matchers: string[]; team: string; repeat: string | null }[];
  route: { groupBy: string[]; groupWait: string; repeat: string };
}

const ICON: Record<ChType, typeof Mail> = { email: Mail, teams: MessageSquare, slack: Hash, webhook: Webhook, pagerduty: Siren };
const TYPE_NAME: Record<ChType, string> = { email: 'Email', teams: 'Microsoft Teams', slack: 'Slack', webhook: 'Webhook', pagerduty: 'PagerDuty' };
const TYPE_HELP: Record<ChType, string> = {
  email: 'Sent through your mail server (set it up once under Email server).',
  teams: 'In Teams: the channel ... -> Workflows -> "Post to a channel when a webhook request is received", copy its URL.',
  slack: 'In Slack: an app with Incoming Webhooks for the channel, copy the webhook URL.',
  webhook: 'Alertmanager posts JSON (its webhook format) to this URL: ITSM tools, ServiceNow, scripts, chat bridges.',
  pagerduty: 'In PagerDuty: a service -> Integrations -> Events API v2, copy the integration (routing) key.',
};
const ago = (iso: string) => Date.parse(iso);

export function Notifications() {
  const { can } = useApp();
  const { open, confirm } = useDialogs();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => api<NotifData>('/notifications') });
  const [testing, setTesting] = useState<number | null>(null);
  if (q.isPending) return <TableWrap label="Notifications"><StateView kind="loading" skeleton="table" /></TableWrap>;
  if (q.isError) return <TableWrap label="Notifications"><ErrorState error={q.error} what="Notifications" /></TableWrap>;
  const n = q.data;
  const manage = n.editable && can('notifications.manage');
  const refresh = () => { qc.invalidateQueries({ queryKey: ['notifications'] }); qc.invalidateQueries({ queryKey: ['notify-teams'] }); };
  const afterSave = (apply?: Apply) => { refresh(); if (apply && apply.ok === false) toast(apply.error || 'Alertmanager did not take the change', 'err'); };
  const teamsList = n.teams.map((t) => t.name);
  const byId = new Map(n.channels.map((c) => [c.id, c]));

  async function test(c: Channel) {
    setTesting(c.id);
    try {
      const r = await api<{ ok: boolean; error?: string; ms: number }>(`/notifications/channels/${c.id}/test`, { method: 'POST' });
      if (r.ok) toast(`Test sent to "${c.name}" (${r.ms} ms): check that it arrived`);
      else toast(`"${c.name}": ${r.error}`, 'err');
    } catch (e) { toast((e as Error).message, 'err'); } finally { setTesting(null); refresh(); }
  }
  const edit = (c?: Channel) => open((close) => <ChannelDialog channel={c} teams={teamsList} defaultTeam={n.defaultTeam} smtpReady={n.smtp.configured} onClose={close} onDone={afterSave} onTest={test} />);
  const editSmtp = () => open((close) => <SmtpDialog smtp={n.smtp} onClose={close} onDone={afterSave} />);

  const noChannels = !n.channels.some((c) => c.enabled) && !n.teams.some((t) => t.fileChannels.length);
  return (
    <div className="notify">
      {!n.managedByObservaOne && <InfoBox>Channels are set in <code>alertmanager/alertmanager.yml</code> on this installation (AM_CONFIG_FILE is not set), so they are shown here but not edited.</InfoBox>}
      {n.managedByObservaOne && n.apply.ok === false && <InfoBox tone="error">{n.apply.error}</InfoBox>}
      {n.managedByObservaOne && n.apply.ok && n.apply.pending && <InfoBox tone="error">{n.apply.error}</InfoBox>}
      {noChannels && <InfoBox tone="error">No channel yet: alerts are only shown in ObservaOne, nobody is notified. Add one below.</InfoBox>}

      <div className="notify-head">
        <div>
          <h3>Channels</h3>
          <p className="muted">An alert goes to the channels of its team (the rule's <b>Notify</b>); alerts without a team go to <b>{n.defaultTeam}</b>.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {manage && <button className="btn" onClick={editSmtp}><Server size={15} aria-hidden /> Email server{n.smtp.configured ? '' : ': not set'}</button>}
          {manage && <button className="btn btn-primary" onClick={() => edit()}><Plus size={15} aria-hidden /> Add channel</button>}
        </div>
      </div>

      <TableWrap label="Notification channels">
        <table className="tbl">
          <thead><tr><th>Channel</th><th>Sends to</th><th>Team</th><th>Resolved</th><th>Last test</th>{manage && <th style={{ width: 1 }}>Actions</th>}</tr></thead>
          <tbody>
            {!n.channels.length && <tr><td colSpan={manage ? 6 : 5} className="dim" style={{ padding: 18 }}>{manage ? 'No channels yet. "Add channel": email, Microsoft Teams, Slack, a webhook or PagerDuty.' : 'No channels managed in ObservaOne.'}</td></tr>}
            {n.channels.map((c) => {
              const Icon = ICON[c.type] || Webhook;
              return (
                <tr key={c.id} className={c.enabled ? '' : 'row-disabled'}>
                  <td><span className="ch-name"><span className={`ch-ic ch-${c.type}`}><Icon size={15} aria-hidden /></span><span><b>{c.name}</b><span className="dim ch-type">{c.typeName}{!c.enabled && ' · disabled'}{c.type === 'email' && !n.smtp.configured && ' · needs email server'}</span></span></span></td>
                  <td className="mono" style={{ wordBreak: 'break-all' }}>{c.display}</td>
                  <td><Pill tone={c.team === n.defaultTeam ? 'blue' : 'muted'}>{c.team}</Pill></td>
                  <td>{c.sendResolved ? 'Yes' : 'No'}</td>
                  <td>{c.lastTest ? (
                    <span className={`test-res ${c.lastTest.ok ? 'c-green' : 'c-red'}`} title={c.lastTest.error || 'Delivered'}>
                      {c.lastTest.ok ? <CheckCircle2 size={14} aria-hidden /> : <XCircle size={14} aria-hidden />}
                      {c.lastTest.ok ? 'Sent' : 'Failed'} <span className="dim"><Time ms={ago(c.lastTest.at)} /></span>
                      {!c.lastTest.ok && <span className="test-err">{c.lastTest.error}</span>}
                    </span>) : <span className="dim">never</span>}</td>
                  {manage && <td><div className="row-actions">
                    <button className="btn btn-sm" disabled={testing === c.id} onClick={() => test(c)}><Send size={13} aria-hidden /> {testing === c.id ? 'Sending…' : 'Send test'}</button>
                    <button className="icon-btn" aria-label={`Edit ${c.name}`} title="Edit" onClick={() => edit(c)}><Pencil size={15} /></button>
                    <button className="icon-btn" aria-label={`Delete ${c.name}`} title="Delete" onClick={async () => {
                      if (!(await confirm('Delete channel', <>Alerts stop going to <b>{c.name}</b> ({c.display}).</>, 'Delete'))) return;
                      try { const r = await api<{ apply: Apply }>(`/notifications/channels/${c.id}`, { method: 'DELETE' }); toast('Channel deleted'); afterSave(r.apply); } catch (e) { toast((e as Error).message, 'err'); }
                    }}><Trash2 size={15} /></button>
                  </div></td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableWrap>

      <h3 style={{ margin: '22px 0 4px' }}>Who gets what</h3>
      <p className="muted" style={{ marginTop: 0 }}>Alertmanager checks the routes top to bottom; the first match decides the team.</p>
      <div className="route-list">
        {n.routes.map((r, i) => {
          const t = n.teams.find((x) => x.name === r.team);
          return <RouteRow key={i} when={r.matchers.join(' and ')} team={r.team} repeat={r.repeat} channels={(t?.channels || []).map((id) => byId.get(id)!).filter(Boolean)} fileChannels={t?.fileChannels || []} />;
        })}
        {(() => { const t = n.teams.find((x) => x.isDefault); return <RouteRow when="everything else" team={n.defaultTeam} repeat={null} channels={(t?.channels || []).map((id) => byId.get(id)!).filter(Boolean)} fileChannels={t?.fileChannels || []} />; })()}
      </div>
      <p className="muted" style={{ marginTop: 10 }}>
        One notification per {(n.route.groupBy || []).join(', ') || 'alert'} (100 servers with the same alert = 1 message listing them), sent after {n.route.groupWait}, repeated every {n.route.repeat} while it is still firing.
        {n.smtp.configured && <> Email goes through <span className="mono">{n.smtp.smarthost}</span> from <span className="mono">{n.smtp.from}</span>.</>}
      </p>
    </div>
  );
}

function RouteRow({ when, team, repeat, channels, fileChannels }: { when: string; team: string; repeat: string | null; channels: Channel[]; fileChannels: { type: string; count: number }[] }) {
  const live = channels.filter((c) => c.enabled);
  return (
    <div className="route-row">
      <span className="route-when mono">{when}</span>
      <ArrowRight size={15} className="dim" aria-hidden />
      <Pill tone="blue">{team}</Pill>
      <span className="route-chs">
        {live.map((c) => { const Icon = ICON[c.type]; return <span key={c.id} className="route-ch"><Icon size={13} aria-hidden /> {c.name}</span>; })}
        {fileChannels.map((f) => <span key={f.type} className="route-ch dim">{f.type} ×{f.count} (file)</span>)}
        {!live.length && !fileChannels.length && <span className="c-red">no channel: not sent</span>}
      </span>
      {repeat && <span className="dim" style={{ marginLeft: 'auto' }}>repeat {repeat}</span>}
    </div>
  );
}

function ChannelDialog({ channel, teams, defaultTeam, smtpReady, onClose, onDone, onTest }: {
  channel?: Channel; teams: string[]; defaultTeam: string; smtpReady: boolean; onClose: () => void; onDone: (a?: Apply) => void; onTest: (c: Channel) => void;
}) {
  const editing = !!channel;
  const [type, setType] = useState<ChType>(channel?.type || 'email');
  const [name, setName] = useState(channel?.name || '');
  const [team, setTeam] = useState(channel?.team || defaultTeam);
  const [newTeam, setNewTeam] = useState('');
  const [to, setTo] = useState(channel?.to || '');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [slackChannel, setSlackChannel] = useState(channel?.channel || '');
  const [routingKey, setRoutingKey] = useState('');
  const [sendResolved, setSendResolved] = useState(channel?.sendResolved ?? true);
  const [enabled, setEnabled] = useState(channel?.enabled ?? true);
  const teamValue = team === '__new' ? newTeam.trim().toLowerCase() : team;
  const teamOk = /^[a-z][a-z0-9-]{1,30}$/.test(teamValue);
  const needsUrl = (type === 'teams' || type === 'slack' || type === 'webhook') && !editing;
  const ready = !!name.trim() && teamOk && (type !== 'email' || !!to.trim()) && (!needsUrl || !!url.trim()) && (type !== 'pagerduty' || editing || !!routingKey.trim()) && (type !== 'email' || smtpReady);

  const body = () => ({
    name: name.trim(), type, team: teamValue, sendResolved, enabled,
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
    if (thenTest) onTest(r.channel);
  };
  const secretHint = editing ? 'Leave empty to keep the stored one.' : undefined;

  return (
    <Modal title={editing ? `Edit channel: ${channel!.name}` : 'Add notification channel'} wide onClose={onClose} actions={[
      { label: 'Cancel' },
      { label: editing ? 'Save' : 'Add', disabled: !ready, onClick: () => save(false) },
      { label: editing ? 'Save and send test' : 'Add and send test', primary: true, disabled: !ready, onClick: () => save(true) },
    ]}>
      <div className="notify-form">
        {!editing && (
          <div className="type-picker" role="radiogroup" aria-label="Channel type">
            {(Object.keys(TYPE_NAME) as ChType[]).map((t) => {
              const Icon = ICON[t];
              return <button key={t} type="button" role="radio" aria-checked={type === t} className={`type-opt ${type === t ? 'on' : ''}`} onClick={() => setType(t)}><Icon size={18} aria-hidden /><span>{TYPE_NAME[t]}</span></button>;
            })}
          </div>
        )}
        <p className="muted" style={{ margin: '0 0 12px' }}>{TYPE_HELP[type]}</p>
        {type === 'email' && !smtpReady && <InfoBox tone="error">Set up the email server first: close this and use <b>Email server</b>.</InfoBox>}
        <div className="form-row">
          <Field label="Name"><input className="input" placeholder={{ email: 'Platform on-call email', teams: 'Infra Teams channel', slack: 'Slack #alerts', webhook: 'ITSM / ServiceNow', pagerduty: 'Payments PagerDuty' }[type]} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Team" hint="Alerts whose rule notifies this team come here.">
            <Select className="select" label="Team" value={team} onChange={setTeam} options={[...teams.map((t) => [t, t === defaultTeam ? `${t} (default)` : t] as [string, string]), ['__new', '+ New team…']]} />
            {team === '__new' && <input className="input" style={{ marginTop: 6 }} placeholder="e.g. payments" value={newTeam} onChange={(e) => setNewTeam(e.target.value)} aria-invalid={!!newTeam && !teamOk} aria-label="New team name" />}
          </Field>
        </div>
        {type === 'email' && <Field label="Email addresses" hint="Comma separated, up to 20."><input className="input" placeholder="oncall@bank.local, platform-lead@bank.local" value={to} onChange={(e) => setTo(e.target.value)} /></Field>}
        {(type === 'teams' || type === 'slack') && (
          <Field label={type === 'teams' ? 'Teams workflow URL' : 'Slack webhook URL'} hint={secretHint || 'Stored encrypted; shown only as its host afterwards.'}>
            <input className="input mono" placeholder={editing ? channel!.display : 'https://…'} value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" />
          </Field>
        )}
        {type === 'slack' && <Field label="Channel (optional)" hint="Overrides the webhook's own channel."><input className="input" placeholder="#alerts" value={slackChannel} onChange={(e) => setSlackChannel(e.target.value)} /></Field>}
        {type === 'webhook' && (
          <div className="form-row">
            <Field label="URL" hint={secretHint || 'https:// (or http:// inside your network).'}><input className="input mono" placeholder={editing ? channel!.display : 'https://itsm.bank.local/api/alerts'} value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" /></Field>
            <Field label="Bearer token (optional)" hint={secretHint || 'Sent as "Authorization: Bearer …"; stored encrypted.'}><input className="input mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" /></Field>
          </div>
        )}
        {type === 'pagerduty' && <Field label="Integration (routing) key" hint={secretHint || 'Stored encrypted.'}><input className="input mono" type="password" placeholder={editing ? channel!.display : ''} value={routingKey} onChange={(e) => setRoutingKey(e.target.value)} autoComplete="new-password" /></Field>}
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 4 }}>
          <label className="check-row"><input type="checkbox" checked={sendResolved} onChange={(e) => setSendResolved(e.target.checked)} /> Also notify when it is resolved</label>
          {editing && <label className="check-row"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label>}
        </div>
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
