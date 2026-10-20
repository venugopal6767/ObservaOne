// Alerting (hybrid: Prometheus evaluates, Alertmanager groups / silences / routes, ObservaOne shows and records).
// Alerts: All / Firing / Pending / Resolved with value, duration and team; a row opens the alert's evidence page.
// Also rules (create with a test first), silences and where notifications go.
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, BellOff, Bell, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { dateTime, timeHeader } from '@/lib/format';
import { rangeParams, useApp, usePlainQuery, useRangeQuery } from '@/app/AppContext';
import { ErrorState, Field, InfoBox, Modal, PageHead, Pill, Select, StateView, TableWrap, Time, toast, useDialogs } from '@/components/ui';
import { Notifications } from '@/components/notifications';
import { CreateAlert, SeverityPill, StatePill, durationText, valueText, type AlertRow } from '@/components/alerts';

interface Alert { fingerprint: string; name: string; severity: string; state: 'active' | 'suppressed' | 'unprocessed'; silencedBy: string[]; inhibitedBy: string[]; startsAt: string; summary: string; description: string; labels: Record<string, string> }
interface Silence { id: string; state: string; matchers: { name: string; value: string }[]; createdBy: string; comment: string; startsAt: string; endsAt: string }
interface Rule { group: string; name: string; query: string; duration: number; state: string; severity: string; summary: string; firing: number; health: string; lastError?: string; custom: boolean }
type TabKey = 'all' | 'firing' | 'pending' | 'resolved' | 'rules' | 'silences' | 'notifications';
const ALERT_TABS = ['all', 'firing', 'pending', 'resolved'];

const SEV: Record<string, [string, string]> = { critical: ['Critical', 'pill-solid-red'], warning: ['Warning', 'pill-solid-orange'], info: ['Info', 'pill-solid-blue'] };

export default function Alerting() {
  const { can, range } = useApp();
  const { open, confirm } = useDialogs();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const initial = params.get('tab') === 'active' ? 'firing' : (params.get('tab') as TabKey);
  const [tab, setTabState] = useState<TabKey>(initial && [...ALERT_TABS, 'rules', 'silences', 'notifications'].includes(initial) ? initial : 'all');
  const [sevFilter, setSevFilter] = useState('');
  const [search, setSearch] = useState(params.get('q') || ''); // links from notifications: ?q=<alert name>
  const setTab = (k: TabKey) => { setTabState(k); const n = new URLSearchParams(params); n.set('tab', k); setParams(n, { replace: true }); };

  const q = usePlainQuery(['alerting'], async () => {
    const [a, r] = await Promise.all([api<{ alerts: Alert[]; silences: Silence[] }>('/alerts'), api<{ rules: Rule[]; editable: boolean }>('/rules')]);
    return { ...a, ...r };
  });
  const isAlertTab = ALERT_TABS.includes(tab);
  const list = useRangeQuery(['alerts-list', tab, sevFilter, search], () => {
    const r = rangeParams(range);
    return api<{ alerts: AlertRow[]; counts: Record<string, number>; alertmanager: boolean }>('/alerts/list', { query: { state: isAlertTab ? tab : 'all', start: r.start, end: r.end, ...(sevFilter ? { severity: sevFilter } : {}), ...(search.trim() ? { q: search.trim() } : {}) } });
  });
  const reload = () => { qc.invalidateQueries({ queryKey: ['alerting'] }); qc.invalidateQueries({ queryKey: ['alerts-list'] }); qc.invalidateQueries({ queryKey: ['alerts-count'] }); };
  const d = q.data;
  const counts = list.data?.counts;
  const n = (v: number | undefined) => (v === undefined ? '-' : v); // unknown counts show "-", never "0"

  function newRule() {
    if (!d?.editable) return toast('Rule editing is off. Set UI_RULES_FILE (see README).', 'err');
    open((close) => <CreateAlert onClose={close} onDone={() => { setTab('rules'); reload(); }} />);
  }

  let body: React.ReactNode;
  if (isAlertTab) body = <AlertList q={list} tab={tab} onChanged={reload} />;
  else if (q.isPending) body = <TableWrap label="Alerts"><StateView kind="loading" skeleton="table" /></TableWrap>;
  else if (q.isError) body = <TableWrap label="Alerts"><ErrorState error={q.error} what="Alerts" /></TableWrap>;
  else if (tab === 'rules') {
    body = !d!.rules.length ? <TableWrap label="Rules"><StateView kind="empty" title="No alert rules loaded" text='Prometheus has no alerting rules. Add rule files under prometheus/rules, or create one here with "New Alert Rule".' /></TableWrap> : (
      <>
        {!d!.editable && can('alerts.rules') && <InfoBox>Rules from files are read-only here. Set UI_RULES_FILE to allow creating rules in this page.</InfoBox>}
        <TableWrap label="Rules">
          <table className="tbl">
            <thead><tr>{['Rule', 'Group', 'Severity', 'State', 'For', 'Query', ''].map((x, i) => <th key={x || i}>{x}</th>)}</tr></thead>
            <tbody>
              {d!.rules.map((r) => {
                const [sl, sc] = SEV[r.severity] || [r.severity, 'pill-solid-muted'];
                const stateP: Record<string, string> = { firing: 'pill-solid-red', pending: 'pill-solid-orange', inactive: 'pill-solid-green' };
                return (
                  <tr key={`${r.group}-${r.name}`}>
                    <td><b style={{ fontWeight: 600 }}>{r.name}</b><div className="dim" style={{ fontSize: 11.5 }}>{r.summary.replace(/\{\{.*?\}\}/g, '…')}</div></td>
                    <td className="dim">{r.group}</td>
                    <td><span className={`pill ${sc}`}>{sl}</span></td>
                    <td><span className={`pill ${stateP[r.state] || 'pill-muted'}`}>{r.state === 'inactive' ? 'OK' : `${r.state}${r.firing ? ` (${r.firing})` : ''}`}</span>{r.health === 'err' && <div className="c-red" style={{ fontSize: 11 }}>{r.lastError}</div>}</td>
                    <td className="dim">{r.duration ? `${Math.round(r.duration / 60)}m` : '0m'}</td>
                    <td className="mono msg" style={{ fontSize: 11.5, maxWidth: 380 }} title={r.query}>{r.query}</td>
                    <td>{r.custom && can('alerts.rules') && <button className="icon-btn" title="Delete rule" aria-label={`Delete rule ${r.name}`} onClick={async () => {
                      if (!(await confirm('Delete rule', `Delete alert rule "${r.name}"?`, 'Delete'))) return;
                      try { await api(`/rules/${encodeURIComponent(r.name)}`, { method: 'DELETE' }); toast('Rule deleted'); reload(); } catch (e) { toast((e as Error).message, 'err'); }
                    }}><Trash2 size={14} /></button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      </>
    );
  } else if (tab === 'silences') {
    body = !d!.silences.length ? <TableWrap label="Silences"><StateView kind="empty" title="No silences" text='Turn off "Notify" on an alert to silence it.' /></TableWrap> : (
      <TableWrap label="Silences">
        <table className="tbl">
          <thead><tr>{['Matchers', 'State', 'Created by', 'Comment', timeHeader('Ends'), ''].map((x, i) => <th key={x || i}>{x}</th>)}</tr></thead>
          <tbody>
            {d!.silences.map((s) => (
              <tr key={s.id}>
                <td className="mono" style={{ fontSize: 12 }}>{s.matchers.map((m) => `${m.name}="${m.value}"`).join(', ')}</td>
                <td><Pill tone={s.state === 'active' ? 'blue' : 'muted'}>{s.state}</Pill></td>
                <td>{s.createdBy}</td><td className="msg">{s.comment}</td>
                <td className="mono"><Time ms={Date.parse(s.endsAt)} text={dateTime(Date.parse(s.endsAt)).slice(0, 16)} /></td>
                <td>{s.state === 'active' && can('alerts.silence') && <button className="btn btn-sm" onClick={async () => {
                  try { await api(`/silences/${s.id}`, { method: 'DELETE' }); toast('Silence ended'); reload(); } catch (e) { toast((e as Error).message, 'err'); }
                }}>End now</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    );
  } else body = <Notifications />;

  return (
    <>
      <PageHead title="Alerting" sub="Prometheus evaluates the rules and Alertmanager delivers the notifications; follow every alert from here to its evidence"
        actions={can('alerts.rules') ? <button className="btn btn-primary" onClick={newRule}><Plus size={15} />Create alert</button> : undefined} />
      <div className="toolbar">
        <div className="chips" role="tablist" aria-label="Alerting sections">
          {([['all', `All Alerts (${n(counts?.all)})`], ['firing', `Firing (${n(counts?.firing)})`], ['pending', `Pending (${n(counts?.pending)})`], ['resolved', `Resolved (${n(counts?.resolved)})`],
            ['rules', `Rules (${q.isError || !d ? '-' : d.rules.length})`], ['silences', `Silences (${q.isError || !d ? '-' : d.silences.filter((s) => s.state === 'active').length})`], ['notifications', 'Notifications']] as [TabKey, string][])
            .map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`tab tab-outline ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{l}</button>)}
        </div>
        <div className="grow" />
        {isAlertTab && <>
          <label className="search-field" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Search size={14} aria-hidden />
            <input className="input input-sm" type="search" placeholder="Filter: alert, host, label" aria-label="Filter alerts" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 210 }} />
          </label>
          <Select className="select select-sm" label="Severity" value={sevFilter} onChange={setSevFilter} options={[['', 'All severities'], ['critical', 'Critical'], ['warning', 'Warning'], ['info', 'Info']]} />
        </>}
      </div>
      {isAlertTab && <p className="dim" style={{ margin: '-4px 0 10px', fontSize: 12.5 }}>Firing and pending alerts are shown whatever the time range; resolved ones when they ended inside it (time range at the top).</p>}
      {body}
    </>
  );
}

function AlertList({ q, tab, onChanged }: { q: ReturnType<typeof useRangeQuery<{ alerts: AlertRow[]; counts: Record<string, number>; alertmanager: boolean }>>; tab: string; onChanged: () => void }) {
  const { can } = useApp();
  const { open } = useDialogs();
  const navigate = useNavigate();
  if (q.isPending) return <TableWrap label="Alerts"><StateView kind="loading" skeleton="table" /></TableWrap>;
  if (q.isError) return <TableWrap label="Alerts"><ErrorState error={q.error} what="Alerts" /></TableWrap>;
  const rows = q.data.alerts;
  if (!rows.length) {
    const t: Record<string, [string, string]> = {
      all: ['No alerts', 'Nothing is firing or pending, and nothing resolved in the selected time range.'],
      firing: ['Nothing is firing', 'No rule has been true for its whole "for" duration.'],
      pending: ['Nothing is pending', 'No rule condition is true right now.'],
      resolved: ['No resolved alerts in this time range', 'Widen the time range at the top to see older ones.'],
    };
    return <TableWrap label="Alerts"><StateView kind="empty" title={t[tab][0]} text={t[tab][1]} /></TableWrap>;
  }
  const canSilence = can('alerts.silence');
  return (
    <>
      {!q.data.alertmanager && <InfoBox tone="error">Alertmanager cannot be reached: silences and muting are not shown, and notifications may not be sent.</InfoBox>}
      <TableWrap label="Alerts">
        <table className="tbl alerts-tbl">
          <thead><tr><th>Severity</th><th>Alert Name</th><th>State</th><th>Host / Resource</th><th className="num">Current Value</th><th className="num">Duration</th><th>Team</th><th>Actions</th></tr></thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className="clickable" tabIndex={0} onClick={(e) => { if (!(e.target as HTMLElement).closest('button, a')) navigate(`/alerting/alert/${a.id}`); }} onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/alerting/alert/${a.id}`); }}>
                <td><SeverityPill s={a.severity} /></td>
                <td><Link to={`/alerting/alert/${a.id}`} style={{ fontWeight: 600 }}>{a.name}</Link>{a.summary && <div className="dim ell" style={{ fontSize: 11.5, maxWidth: 340 }} title={a.summary}>{a.summary}</div>}</td>
                <td><StatePill a={a} /></td>
                <td className="mono">{a.host || '—'}{a.env && <span className="dim"> · {a.env}</span>}</td>
                <td className="num">{a.state === 'resolved' ? <span className="dim" title="Highest value while active">{valueText(a.peak, a.unit)} peak</span> : valueText(a.value, a.unit)}</td>
                <td className="num" title={`Started ${dateTime(Date.parse(a.firedAt || a.activeAt))}`}>{durationText(a.durationSec)}</td>
                <td>{a.team ? <Pill tone="blue">{a.team}</Pill> : <span className="dim">Platform</span>}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <Link className="btn btn-sm" to={`/alerting/alert/${a.id}`}>Details</Link>
                  {a.state !== 'resolved' && canSilence && (a.silenced
                    ? <button className="icon-btn" style={{ marginLeft: 4 }} title="Silenced: end the silence on the Silences tab" aria-label={`${a.name} is silenced`} disabled><Bell size={15} /></button>
                    : <button className="icon-btn" style={{ marginLeft: 4 }} title="Silence notifications" aria-label={`Silence ${a.name} on ${a.host}`} onClick={() => open((close) => <SilenceDialog a={a} onClose={close} onDone={onChanged} />)}><BellOff size={15} /></button>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </>
  );
}

function SilenceDialog({ a, onClose, onDone }: { a: AlertRow; onClose: () => void; onDone: () => void }) {
  const [hours, setHours] = useState(2);
  const [comment, setComment] = useState('');
  const matchers = [{ name: 'alertname', value: a.name }, ...(a.host ? [{ name: 'host', value: a.host }] : [])];
  return (
    <Modal title={`Silence "${a.name}"`} onClose={onClose} actions={[
      { label: 'Cancel' },
      { label: 'Silence', primary: true, onClick: async () => { await api('/silences', { method: 'POST', body: { matchers, hours, comment } }); toast('Alert silenced'); onDone(); } },
    ]}>
      <p className="muted" style={{ marginTop: 0 }}>No notifications are sent for this alert until the silence ends. The alert still shows here.</p>
      <pre className="code">{matchers.map((m) => `${m.name} = "${m.value}"`).join('\n')}</pre>
      <Field label="Duration"><Select options={[[1, '1 hour'], [2, '2 hours'], [4, '4 hours'], [8, '8 hours'], [24, '1 day'], [72, '3 days']]} value={hours} onChange={setHours} /></Field>
      <Field label="Comment"><input className="input" placeholder="Why? e.g. planned maintenance CR-1234" value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
    </Modal>
  );
}

