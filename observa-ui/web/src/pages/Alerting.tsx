// Alerting: firing alerts (silence with one switch), rules (create/delete UI rules), silences, and where
// notifications go. Clicking an alert shows its labels and links to the host's logs and dashboard.
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, FileText, LayoutDashboard, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { dateTime, timeHeader, escapeLabel } from '@/lib/format';
import { useApp, usePlainQuery, windowQuery } from '@/app/AppContext';
import { ErrorState, Field, InfoBox, Modal, PageHead, Pill, Select, StateView, TableWrap, Time, Toggle, toast, useDialogs } from '@/components/ui';

interface Alert { fingerprint: string; name: string; severity: string; state: 'active' | 'suppressed' | 'unprocessed'; silencedBy: string[]; inhibitedBy: string[]; startsAt: string; summary: string; description: string; labels: Record<string, string> }
interface Silence { id: string; state: string; matchers: { name: string; value: string }[]; createdBy: string; comment: string; startsAt: string; endsAt: string }
interface Rule { group: string; name: string; query: string; duration: number; state: string; severity: string; summary: string; firing: number; health: string; lastError?: string; custom: boolean }
type TabKey = 'active' | 'all' | 'rules' | 'silences' | 'notifications';

const SEV: Record<string, [string, string]> = { critical: ['Critical', 'pill-solid-red'], warning: ['Warning', 'pill-solid-orange'], info: ['Info', 'pill-solid-blue'] };

export default function Alerting() {
  const { can } = useApp();
  const { open, confirm } = useDialogs();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [tab, setTabState] = useState<TabKey>((params.get('tab') as TabKey) || 'active');
  const [sevFilter, setSevFilter] = useState('');
  const setTab = (k: TabKey) => { setTabState(k); const n = new URLSearchParams(params); n.set('tab', k); setParams(n, { replace: true }); };

  const q = usePlainQuery(['alerting'], async () => {
    const [a, r] = await Promise.all([api<{ alerts: Alert[]; silences: Silence[] }>('/alerts'), api<{ rules: Rule[]; editable: boolean }>('/rules')]);
    return { ...a, ...r };
  });
  const reload = () => { qc.invalidateQueries({ queryKey: ['alerting'] }); qc.invalidateQueries({ queryKey: ['alerts-count'] }); };
  const d = q.data;
  const active = (d?.alerts || []).filter((a) => a.state === 'active');
  // unknown counts show "-": a failed load must not look like "0 alerts"
  const n = (v: number) => (q.isError || !d ? '-' : v);

  function newRule() {
    if (!d?.editable) return toast('Rule editing is off. Set UI_RULES_FILE (see README).', 'err');
    open((close) => <NewRule onClose={close} onDone={() => { setTab('rules'); reload(); }} />);
  }

  let body: React.ReactNode;
  if (q.isPending) body = <TableWrap label="Alerts"><StateView kind="loading" skeleton="table" /></TableWrap>;
  else if (q.isError) body = <TableWrap label="Alerts"><ErrorState error={q.error} what="Alerts" /></TableWrap>;
  else if (tab === 'active' || tab === 'all') {
    const list = (tab === 'active' ? active : d!.alerts).filter((a) => !sevFilter || a.severity === sevFilter);
    body = <AlertTable list={list} tab={tab} onChanged={reload} />;
  } else if (tab === 'rules') {
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
      <PageHead title="Alerting" sub="Manage alerts and notifications" actions={can('alerts.rules') ? <button className="btn btn-primary" onClick={newRule}><Plus size={15} />New Alert Rule</button> : undefined} />
      <div className="toolbar">
        <div className="chips">
          {([['active', `Active (${n(active.length)})`], ['all', `All (${n(d?.alerts.length || 0)})`], ['rules', `Rules (${n(d?.rules.length || 0)})`],
            ['silences', `Silences (${n((d?.silences || []).filter((s) => s.state === 'active').length)})`], ['notifications', 'Notifications']] as [TabKey, string][])
            .map(([k, l]) => <button key={k} className={`tab tab-outline ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{l}</button>)}
        </div>
        <div className="grow" />
        {(tab === 'active' || tab === 'all') && <Select className="select select-sm" label="Severity" value={sevFilter} onChange={setSevFilter} options={[['', 'All severities'], ['critical', 'Critical'], ['warning', 'Warning'], ['info', 'Info']]} />}
      </div>
      {body}
    </>
  );
}

function AlertTable({ list, tab, onChanged }: { list: Alert[]; tab: string; onChanged: () => void }) {
  const { can, canOpen } = useApp();
  const { open } = useDialogs();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState<string | null>(null);
  if (!list.length) {
    return <TableWrap label="Alerts">{tab === 'active'
      ? <StateView kind="empty" title="No active alerts" text="Alertmanager reports nothing firing right now." />
      : <StateView kind="empty" title="No alerts" text="Alertmanager has no alerts, firing or silenced." />}</TableWrap>;
  }
  const canSilence = can('alerts.silence');
  return (
    <TableWrap label="Alerts">
      <table className="tbl">
        <thead><tr>{['', 'Alert Name', 'Severity', 'Status', 'Server', timeHeader('Started'), 'Message', 'Notify'].map((x, i) => <th key={x || i}>{x}</th>)}</tr></thead>
        <tbody>
          {list.map((a) => {
            const [sl, sc] = SEV[a.severity] || [a.severity, 'pill-solid-muted'];
            const silenced = a.state === 'suppressed' && a.silencedBy?.length > 0;
            const host = a.labels.host || a.labels.instance;
            const isOpen = expanded === a.fingerprint;
            const started = Date.parse(a.startsAt);
            return [
              <tr key={a.fingerprint} className="clickable" onClick={() => setExpanded(isOpen ? null : a.fingerprint)}>
                <td style={{ width: 24 }}><ChevronRight size={14} className={`chev ${isOpen ? 'open' : ''}`} aria-label={isOpen ? 'Hide details' : 'Show details'} /></td>
                <td><b style={{ fontWeight: 600 }}>{a.name}</b></td>
                <td><span className={`pill ${sc}`}>{sl}</span></td>
                <td>{a.state === 'active' ? <span className="pill pill-solid-red">Firing</span> : <span className="pill pill-solid-muted">{silenced ? 'Silenced' : 'Inhibited'}</span>}</td>
                <td>{host || '-'}</td>
                <td className="mono" style={{ whiteSpace: 'nowrap' }}><Time ms={started} text={dateTime(started).slice(0, 16)} /></td>
                <td className="msg" title={a.description}>{a.summary || a.description}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <Toggle checked={!silenced} disabled={!canSilence || (a.state === 'suppressed' && !silenced)} title={canSilence ? 'Off = silence this alert' : 'Needs the operator role'} label={`Notifications for ${a.name}`}
                    onChange={async (on) => {
                      if (!on) open((close) => <SilenceDialog a={a} onClose={close} onDone={onChanged} />);
                      else {
                        try { for (const id of a.silencedBy || []) await api(`/silences/${id}`, { method: 'DELETE' }); toast('Notifications turned back on'); } catch (e) { toast((e as Error).message, 'err'); }
                        onChanged();
                      }
                    }} />
                </td>
              </tr>,
              isOpen && (
                <tr key={`${a.fingerprint}-x`} className="detail-row">
                  <td />
                  <td colSpan={7}>
                    {a.description && <p style={{ margin: '0 0 8px' }}>{a.description}</p>}
                    <div className="label-chips">{Object.entries(a.labels).map(([k, v]) => <span key={k} className="pill pill-muted mono">{k}={v}</span>)}</div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                      {host && canOpen('/logs') && <button className="btn btn-sm" onClick={() => navigate(`/logs?q=${encodeURIComponent(`{host="${escapeLabel(a.labels.host || host)}"}`)}&${windowQuery(started / 1000, 600)}`)}><FileText size={13} />Logs from {host} when it started</button>}
                      {a.labels.host && a.labels.os && canOpen('/dashboards') && <button className="btn btn-sm" onClick={() => { const dash = a.labels.os === 'windows' ? 'windows-servers' : 'linux-servers'; sessionStorage.setItem(`oo.var.${dash}.host`, a.labels.host); navigate(`/dashboards/${dash}?${windowQuery(started / 1000, 1800)}`); }}><LayoutDashboard size={13} />Host dashboard</button>}
                    </div>
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
    </TableWrap>
  );
}

function SilenceDialog({ a, onClose, onDone }: { a: Alert; onClose: () => void; onDone: () => void }) {
  const [hours, setHours] = useState(2);
  const [comment, setComment] = useState('');
  const matchers = [{ name: 'alertname', value: a.name }, ...(a.labels.instance ? [{ name: 'instance', value: a.labels.instance }] : [])];
  return (
    <Modal title={`Silence "${a.name}"`} onClose={onClose} actions={[
      { label: 'Cancel' },
      { label: 'Silence', primary: true, onClick: async () => { await api('/silences', { method: 'POST', body: { matchers, hours, comment } }); toast('Alert silenced'); onDone(); } },
    ]}>
      <p className="muted" style={{ marginTop: 0 }}>No notifications will be sent for this alert until the silence ends. The alert still shows here.</p>
      <pre className="code">{matchers.map((m) => `${m.name} = "${m.value}"`).join('\n')}</pre>
      <Field label="Duration"><Select options={[[1, '1 hour'], [2, '2 hours'], [4, '4 hours'], [8, '8 hours'], [24, '1 day'], [72, '3 days']]} value={hours} onChange={setHours} /></Field>
      <Field label="Comment"><input className="input" placeholder="Why? e.g. planned maintenance CR-1234" value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
    </Modal>
  );
}

function NewRule({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [expr, setExpr] = useState('');
  const [summary, setSummary] = useState('');
  const [sev, setSev] = useState('warning');
  const [forMin, setForMin] = useState(5);
  const [preview, setPreview] = useState<string | null>(null);
  return (
    <Modal title="New alert rule" wide onClose={onClose} actions={[
      { label: 'Cancel' },
      { label: 'Create rule', primary: true, onClick: async () => {
        await api('/rules', { method: 'POST', body: { name: name.trim(), expr: expr.trim(), severity: sev, forMinutes: forMin, summary } });
        toast('Rule created and loaded by Prometheus');
        onDone();
      } },
    ]}>
      <Field label="Name" hint="Letters, numbers and _ only."><input className="input" placeholder="e.g. HighCpuAppServers" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Condition (PromQL)" hint={preview ?? 'The alert fires for every series this query returns.'}>
        <textarea className="input mono" rows={3} placeholder='100 - avg by (host) (rate(windows_cpu_time_total{mode="idle"}[5m])) * 100 > 85' value={expr} onChange={(e) => { setExpr(e.target.value); setPreview(null); }} />
      </Field>
      <button className="btn btn-sm" style={{ marginTop: -4, marginBottom: 10 }} disabled={!expr.trim()} onClick={async () => {
        try { const r = await api<{ result: unknown[] }>('/prom/query', { query: { query: expr.trim() } }); setPreview(`Right now this would fire for ${r.result.length} series.`); }
        catch (e) { setPreview(`Query error: ${(e as Error).message}`); }
      }}>Test the condition now</button>
      <div className="form-row">
        <Field label="Severity"><Select options={[['critical', 'Critical'], ['warning', 'Warning'], ['info', 'Info']]} value={sev} onChange={setSev} /></Field>
        <Field label="Must be true for"><Select options={[[0, 'Immediately'], [1, '1 minute'], [5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [30, '30 minutes']]} value={forMin} onChange={setForMin} /></Field>
      </div>
      <Field label="Message"><input className="input" placeholder="e.g. CPU high on {{ $labels.host }}" value={summary} onChange={(e) => setSummary(e.target.value)} /></Field>
    </Modal>
  );
}

function Notifications() {
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => api<{ receivers: { name: string; channels: { type: string; targets: string[] }[] }[]; route: { receiver?: string; groupBy?: string[]; repeat?: string } }>('/notifications') });
  if (q.isPending) return <TableWrap label="Notifications"><StateView kind="loading" skeleton="table" /></TableWrap>;
  if (q.isError) return <TableWrap label="Notifications"><ErrorState error={q.error} what="Notifications" /></TableWrap>;
  const n = q.data;
  const none = n.receivers.every((r) => !r.channels.length);
  return (
    <>
      {none && <InfoBox tone="error">No notification channel is set up yet, so alerts are only shown here. Add email/Teams/webhook in alertmanager/alertmanager.yml (see README).</InfoBox>}
      <TableWrap label="Notification receivers">
        <table className="tbl">
          <thead><tr><th>Receiver</th><th>Channel</th><th>Sends to</th></tr></thead>
          <tbody>
            {n.receivers.flatMap((r) => (r.channels.length ? r.channels : [{ type: '(none)', targets: [] as string[] }]).map((c, i) => (
              <tr key={`${r.name}-${i}`}>
                <td><b style={{ fontWeight: 600 }}>{r.name}</b>{r.name === n.route.receiver && <span style={{ marginLeft: 8 }}><Pill tone="blue">default</Pill></span>}</td>
                <td>{c.type}</td><td className="mono">{c.targets.join(', ') || '-'}</td>
              </tr>
            )))}
          </tbody>
        </table>
      </TableWrap>
      <p className="muted" style={{ marginTop: 10 }}>Alerts are grouped by {(n.route.groupBy || []).join(', ')} and repeated every {n.route.repeat || '4h'} while still firing.</p>
    </>
  );
}
