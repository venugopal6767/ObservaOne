// Alerts (hybrid: Prometheus evaluates, Alertmanager groups / silences / routes, ObservaOne shows and records).
// One page component for the Alerts sub-pages (left menu): Overview, Active Alerts, Alert Rules, Notification Policies,
// Notification Channels, Silences, Inhibition. Old links (/alerting?tab=firing, from messages already sent) still work.
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, BellOff, Bell, Search, LineChart, Server, BookOpen, ExternalLink, Send, Route, Activity, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { dateTime, timeHeader } from '@/lib/format';
import { rangeParams, useApp, usePlainQuery, useRangeQuery } from '@/app/AppContext';
import { ErrorState, Field, InfoBox, Modal, PageHead, Panel, Pill, RowMenu, Select, StateView, TableWrap, Time, toast, useDialogs } from '@/components/ui';
import { StatCard } from '@/components/StatCard';
import { CreateAlert, SeverityPill, StatePill, durationText, valueText, type AlertRow } from '@/components/alerts';
import { Notifications } from '@/components/notifications';
import { Policies } from '@/components/policies';
import { Inhibition } from '@/components/inhibition';
import { Evidence, type Detail } from '@/pages/AlertDetail';

interface AmAlert { fingerprint: string; name: string; severity: string; state: 'active' | 'suppressed' | 'unprocessed'; silencedBy: string[]; inhibitedBy: string[]; startsAt: string; summary: string; description: string; labels: Record<string, string> }
interface Silence { id: string; state: string; matchers: { name: string; value: string }[]; createdBy: string; comment: string; startsAt: string; endsAt: string }
interface Rule { group: string; name: string; query: string; duration: number; state: string; severity: string; summary: string; firing: number; health: string; lastError?: string; custom: boolean }
interface ListData { alerts: AlertRow[]; counts: Record<string, number>; envs: string[]; alertmanager: boolean }
type Section = 'overview' | 'active' | 'rules' | 'policies' | 'channels' | 'silences' | 'inhibition';
type StateTab = 'all' | 'firing' | 'pending' | 'resolved';
const SECTIONS: Record<Section, [string, string]> = {
  overview: ['Alerts', 'What is firing, what was noisy, and whether notifications reach people'],
  active: ['Active Alerts', 'View and investigate the alerts of your environment: firing, pending and resolved'],
  rules: ['Alert Rules', 'What Prometheus checks; create alerts by picking a metric (or PromQL), test before saving'],
  policies: ['Notification Policies', 'Which alerts go to which channels, grouped and repeated how: checked top to bottom, the first match sends'],
  channels: ['Notification Channels', 'Where alerts are sent: create a channel once and use it in notification policies'],
  silences: ['Silences', 'Alerts muted for a while (maintenance, known issue): they still show here, nobody is notified'],
  inhibition: ['Inhibition', 'Alerts muted while a related, more important alert fires (a server down hides its CPU and disk warnings)'],
};

export default function Alerting() {
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // links from before the sub-pages (and from notifications already sent): /alerting?tab=firing&q=HighCPU
  const legacyTab = location.pathname === '/alerting' ? params.get('tab') : null;
  useEffect(() => {
    if (!legacyTab) return;
    const n = new URLSearchParams(params); n.delete('tab');
    const to = { rules: '/alerting/rules', silences: '/alerting/silences', notifications: '/alerting/channels' }[legacyTab]
      || `/alerting/active?tab=${legacyTab === 'active' ? 'firing' : legacyTab}${n.toString() ? `&${n}` : ''}`;
    navigate(to, { replace: true });
  }, [legacyTab, params, navigate]);
  if (legacyTab) return <StateView kind="loading" />;
  const section = ((location.pathname.replace(/^\/alerting\/?/, '') || 'overview') as Section);
  const [title, sub] = SECTIONS[section] || SECTIONS.overview;
  return (
    <>
      {section !== 'overview' && <div className="crumbs"><Link to="/alerting">Alerts</Link> › <span>{title}</span></div>}
      {section === 'overview' && <Overview title={title} sub={sub} />}
      {section === 'active' && <ActiveAlerts title={title} sub={sub} />}
      {section === 'rules' && <RulesPage title={title} sub={sub} />}
      {section === 'policies' && <><PageHead title={title} sub={sub} /><Policies /></>}
      {section === 'channels' && <><PageHead title={title} sub={sub} /><Notifications /></>}
      {section === 'silences' && <SilencesPage title={title} sub={sub} />}
      {section === 'inhibition' && <><PageHead title={title} sub={sub} /><Inhibition /></>}
    </>
  );
}

// ---------------------------------------------------------------- shared
function useCreateAlert() {
  const { open } = useDialogs();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = usePlainQuery(['rules-editable'], () => api<{ editable: boolean }>('/rules'));
  return () => {
    if (me.data && !me.data.editable) return toast('Rule editing is off. Set UI_RULES_FILE (see README).', 'err');
    open((close) => <CreateAlert onClose={close} onDone={() => { qc.invalidateQueries(); navigate('/alerting/rules'); }} />);
  };
}
function CreateButton() {
  const { can } = useApp();
  const create = useCreateAlert();
  return can('alerts.rules') ? <button className="btn btn-primary" onClick={create}><Plus size={15} />Create alert</button> : null;
}
function useAlertList(state: StateTab, severity = '', env = '', search = '') {
  const { range } = useApp();
  return useRangeQuery(['alerts-list', state, severity, env, search], () => {
    const r = rangeParams(range);
    return api<ListData>('/alerts/list', { query: { state, start: r.start, end: r.end, ...(severity ? { severity } : {}), ...(env ? { env } : {}), ...(search.trim() ? { q: search.trim() } : {}) } });
  });
}

// ---------------------------------------------------------------- Overview
interface NotifSummary { managedByObservaOne: boolean; apply: { ok: boolean | null; error: string | null }; channels: { id: number; name: string; type: string; enabled: boolean; lastTest: { ok: boolean } | null; usedBy: unknown[] }[] }
function Overview({ title, sub }: { title: string; sub: string }) {
  const { can } = useApp();
  const navigate = useNavigate();
  const list = useAlertList('all');
  const notif = useQuery({ queryKey: ['notifications'], queryFn: () => api<NotifSummary>('/notifications'), enabled: can('view') });
  const pol = useQuery({ queryKey: ['policies'], queryFn: () => api<{ editable: boolean; policies: { id: number; name: string; isDefault: boolean; enabled: boolean; activeAlerts: number | null; channelNames: unknown[] }[] }>('/notifications/policies') });
  const rows = list.data?.alerts || [];
  const active = rows.filter((a) => a.state !== 'resolved');
  const firing = rows.filter((a) => a.state === 'firing');
  const crit = firing.filter((a) => a.severity === 'critical').length;
  const muted = active.filter((a) => a.silenced || a.inhibited).length;
  const noisy = useMemo(() => {
    const m = new Map<string, { n: number; hosts: Set<string>; sev: string }>();
    for (const a of rows) { const x = m.get(a.name) || { n: 0, hosts: new Set(), sev: a.severity }; x.n++; if (a.host) x.hosts.add(a.host); m.set(a.name, x); }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 6);
  }, [rows]);
  const hosts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of active) if (a.host) m.set(a.host, (m.get(a.host) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [active]);
  const ch = notif.data?.channels || [];
  const chOk = ch.filter((c) => c.enabled && c.lastTest?.ok).length, chBad = ch.filter((c) => c.enabled && c.lastTest && !c.lastTest.ok).length;
  const unused = ch.filter((c) => c.enabled && !c.usedBy.length).length;
  const n = (v: number) => (list.isPending || list.isError ? '-' : v);
  return (
    <>
      <PageHead title={title} sub={sub} actions={<CreateButton />} />
      {list.isError && <ErrorState error={list.error} what="Alerts" />}
      <div className="grid cards-4" style={{ marginBottom: 16 }}>
        <StatCard label="Firing now" value={n(firing.length)} tone={firing.length ? 'red' : 'green'} extra={crit ? `${crit} critical` : 'none critical'} onClick={() => navigate('/alerting/active?tab=firing')} />
        <StatCard label="Pending" value={n(active.length - firing.length)} tone={active.length - firing.length ? 'orange' : undefined} extra="true, not yet for their whole duration" onClick={() => navigate('/alerting/active?tab=pending')} />
        <StatCard label="Resolved (time range)" value={n(list.data?.counts.resolved ?? 0)} extra="ended inside the time range at the top" onClick={() => navigate('/alerting/active?tab=resolved')} />
        <StatCard label="Muted now" value={n(muted)} extra="silenced or inhibited: no notification" onClick={() => navigate('/alerting/silences')} />
      </div>
      <div className="ov-grid">
        <Panel title="Firing now" right={<Link to="/alerting/active?tab=firing" className="dim" style={{ fontSize: 12.5 }}>All active alerts <ChevronRight size={13} /></Link>}>
          {list.isPending ? <StateView kind="loading" /> : !firing.length ? <StateView kind="empty" title="Nothing is firing" text="No rule has been true for its whole duration." /> : (
            <div className="ov-list">
              {firing.slice(0, 7).map((a) => (
                <Link key={a.id} to={`/alerting/alert/${a.id}`} className="ov-row">
                  <SeverityPill s={a.severity} /><b className="ell">{a.name}</b><span className="mono dim ell">{a.host || '—'}</span>
                  <span className="num">{valueText(a.value, a.unit)}</span><span className="dim num">{durationText(a.durationSec)}</span>
                </Link>
              ))}
            </div>
          )}
        </Panel>
        <Panel title="Notifications" right={<Link to="/alerting/channels" className="dim" style={{ fontSize: 12.5 }}>Channels <ChevronRight size={13} /></Link>}>
          {notif.isPending ? <StateView kind="loading" /> : notif.isError ? <ErrorState error={notif.error} what="Notifications" /> : (
            <div className="ov-health">
              {notif.data!.apply?.ok === false && <InfoBox tone="error">{notif.data!.apply.error}</InfoBox>}
              <div className="ov-kv"><span>Channels</span><b>{ch.length}</b><span className="dim">{chOk} connected{chBad ? <>, <span className="c-red">{chBad} failing</span></> : ''}{ch.length - chOk - chBad ? `, ${ch.length - chOk - chBad} not tested / off` : ''}</span></div>
              <div className="ov-kv"><span>Policies</span><b>{pol.data?.policies.length ?? '-'}</b><span className="dim">{pol.data ? `${pol.data.policies.filter((p) => !p.isDefault && p.enabled).length} + Default` : ''}</span></div>
              {unused > 0 && <div className="ov-kv"><span /><span /><span className="c-orange">{unused} channel{unused > 1 ? 's are' : ' is'} in no policy: nothing is sent there</span></div>}
              {pol.data?.policies.find((p) => p.isDefault && !p.channelNames.length) && <div className="ov-kv"><span /><span /><span className="c-orange">The Default policy has no channel: alerts no policy matches are not sent</span></div>}
              <div className="ov-actions">
                <Link className="btn btn-sm" to="/alerting/channels"><Send size={13} /> Channels</Link>
                <Link className="btn btn-sm" to="/alerting/policies"><Route size={13} /> Policies</Link>
              </div>
            </div>
          )}
        </Panel>
        <Panel title="Most frequent (time range)">
          {list.isPending ? <StateView kind="loading" /> : !noisy.length ? <StateView kind="empty" title="No alerts in this range" /> : (
            <div className="ov-list">
              {noisy.map(([name, x]) => (
                <Link key={name} to={`/alerting/active?tab=all&q=${encodeURIComponent(name)}`} className="ov-row">
                  <SeverityPill s={x.sev} /><b className="ell">{name}</b><span className="dim ell">{x.hosts.size} host{x.hosts.size === 1 ? '' : 's'}</span><span className="num">{x.n}×</span><span />
                </Link>
              ))}
            </div>
          )}
        </Panel>
        <Panel title="Most affected hosts (active)">
          {list.isPending ? <StateView kind="loading" /> : !hosts.length ? <StateView kind="empty" title="No active alerts" /> : (
            <div className="ov-list">
              {hosts.map(([h, c]) => (
                <Link key={h} to={`/alerting/active?tab=all&q=${encodeURIComponent(h)}`} className="ov-row">
                  <Server size={14} className="dim" /><b className="mono ell">{h}</b><span /><span className="num">{c} alert{c === 1 ? '' : 's'}</span>
                  <span className="dim num" onClick={(e) => { e.preventDefault(); navigate(`/metrics/host/${encodeURIComponent(h)}`); }} title="Open host" role="link"><LineChart size={14} /></span>
                </Link>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Active Alerts
function ActiveAlerts({ title, sub }: { title: string; sub: string }) {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const tabParam = params.get('tab') as StateTab;
  const tab: StateTab = ['all', 'firing', 'pending', 'resolved'].includes(tabParam) ? tabParam : 'all';
  const [sev, setSev] = useState('');
  const [env, setEnv] = useState('');
  const [search, setSearch] = useState(params.get('q') || ''); // links from notifications: ?q=<alert name>
  const [selected, setSelected] = useState<string | null>(null);
  const setTab = (k: StateTab) => { const n = new URLSearchParams(params); n.set('tab', k); setParams(n, { replace: true }); setSelected(null); };
  const list = useAlertList(tab, sev, env, search);
  const counts = list.data?.counts;
  const reload = () => { qc.invalidateQueries({ queryKey: ['alerts-list'] }); qc.invalidateQueries({ queryKey: ['alerts-count'] }); };
  const n = (v: number | undefined) => (v === undefined ? '-' : v);
  const rows = list.data?.alerts || [];
  const sel = rows.find((a) => a.id === selected) || null;
  useEffect(() => { if (selected) setTimeout(() => document.querySelector('.alert-preview')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50); }, [selected]);
  return (
    <>
      <PageHead title={title} sub={sub} actions={<CreateButton />} />
      <div className="toolbar">
        <div className="chips" role="tablist" aria-label="Alert state">
          {([['all', 'All Alerts', 'blue'], ['firing', 'Firing', 'red'], ['pending', 'Pending', 'orange'], ['resolved', 'Resolved', 'green']] as [StateTab, string, string][]).map(([k, l, tone]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`tab tab-outline state-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
              {l} <span className={`tab-count tc-${tone}`}>{n(counts?.[k])}</span>
            </button>
          ))}
        </div>
        <div className="grow" />
        <Select className="select select-sm" label="Severity" value={sev} onChange={(v) => { setSev(v); setSelected(null); }} options={[['', 'Severity: All'], ['critical', 'Critical'], ['warning', 'Warning'], ['info', 'Info']]} />
        <Select className="select select-sm" label="Environment" value={env} onChange={(v) => { setEnv(v); setSelected(null); }} options={[['', 'Environment: All'], ...(list.data?.envs || []).map((e) => [e, e] as [string, string])]} />
        <label className="search-field" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Search size={14} aria-hidden />
          <input className="input input-sm" type="search" placeholder="Search alerts, hosts, labels" aria-label="Search alerts" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 220 }} />
        </label>
      </div>
      <p className="dim" style={{ margin: '-4px 0 10px', fontSize: 12.5 }}>Firing and pending alerts show whatever the time range; resolved ones when they ended inside it. Click a row for a preview.</p>
      <AlertList q={list} tab={tab} selected={selected} onSelect={(id) => setSelected(id === selected ? null : id)} onChanged={reload} />
      {sel && <AlertPreview a={sel} onClose={() => setSelected(null)} />}
    </>
  );
}

function AlertList({ q, tab, selected, onSelect, onChanged }: { q: ReturnType<typeof useAlertList>; tab: StateTab; selected: string | null; onSelect: (id: string) => void; onChanged: () => void }) {
  const { can } = useApp();
  const { open } = useDialogs();
  const navigate = useNavigate();
  if (q.isPending) return <TableWrap label="Alerts"><StateView kind="loading" skeleton="table" /></TableWrap>;
  if (q.isError) return <TableWrap label="Alerts"><ErrorState error={q.error} what="Alerts" /></TableWrap>;
  const rows = q.data.alerts;
  if (!rows.length) {
    const t: Record<StateTab, [string, string]> = {
      all: ['No alerts', 'Nothing is firing or pending, and nothing resolved in the selected time range (or nothing matches the filters).'],
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
              <tr key={a.id} className={`clickable ${selected === a.id ? 'row-selected' : ''}`} tabIndex={0} aria-selected={selected === a.id}
                onClick={(e) => { if (!(e.target as HTMLElement).closest('button, a, .row-menu')) onSelect(a.id); }}
                onKeyDown={(e) => { if (e.key === 'Enter') onSelect(a.id); }}>
                <td><SeverityPill s={a.severity} /></td>
                <td><Link to={`/alerting/alert/${a.id}`} style={{ fontWeight: 600 }}>{a.name}</Link>{a.summary && <div className="dim ell" style={{ fontSize: 11.5, maxWidth: 340 }} title={a.summary}>{a.summary}</div>}</td>
                <td><StatePill a={a} /></td>
                <td className="mono">{a.host || '—'}{a.env && <span className="dim"> · {a.env}</span>}</td>
                <td className="num">{a.state === 'resolved' ? <span className="dim" title="Highest value while active">{valueText(a.peak, a.unit)} peak</span> : valueText(a.value, a.unit)}</td>
                <td className="num" title={`Started ${dateTime(Date.parse(a.firedAt || a.activeAt))}`}>{durationText(a.durationSec)}</td>
                <td>{a.team ? <Pill tone="blue">{a.team}</Pill> : <span className="dim">—</span>}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <div className="row-actions">
                    {a.host && <Link className="icon-btn" to={`/metrics/host/${encodeURIComponent(a.host)}`} title="Open host metrics" aria-label={`Open metrics of ${a.host}`}><LineChart size={15} /></Link>}
                    <Link className="icon-btn" to={`/alerting/alert/${a.id}`} title="Investigate (alert details)" aria-label={`Investigate ${a.name}`}><Search size={15} /></Link>
                    <RowMenu label={`More actions for ${a.name}`} items={[
                      { label: 'Details', onClick: () => navigate(`/alerting/alert/${a.id}`), icon: <Activity size={14} /> },
                      ...(a.host ? [{ label: 'Open host', onClick: () => navigate(`/metrics/host/${encodeURIComponent(a.host)}`), icon: <Server size={14} /> }] : []),
                      ...(a.runbook ? [{ label: 'Runbook', onClick: () => window.open(a.runbook, '_blank', 'noopener'), icon: <BookOpen size={14} /> }] : []),
                      ...(a.state !== 'resolved' && canSilence && !a.silenced ? [{ label: 'Silence…', onClick: () => open((close) => <SilenceDialog a={a} onClose={close} onDone={onChanged} />), icon: <BellOff size={14} /> }] : []),
                      ...(a.silenced ? [{ label: 'Silenced: see Silences', onClick: () => navigate('/alerting/silences'), icon: <Bell size={14} /> }] : []),
                    ]} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </>
  );
}

/** Row preview: the facts, the graph against the threshold, and where to go next (no page change). */
function AlertPreview({ a, onClose }: { a: AlertRow; onClose: () => void }) {
  const q = useQuery({ queryKey: ['alert-item', a.id], queryFn: () => api<Detail>(`/alerts/item/${encodeURIComponent(a.id)}`), refetchInterval: 30_000 });
  const d = q.data;
  const threshold = d?.rule.threshold !== null && d?.rule.threshold !== undefined ? `${d.rule.op} ${valueText(d.rule.threshold, a.unit)}` : '—';
  return (
    <div className="alert-preview" role="region" aria-label={`Preview of ${a.name}`}>
      <div className="ap-left">
        <div className="ap-head">
          <span className={`alert-state-badge ${a.state}`}>{a.neverFired ? 'CLEARED' : a.state.toUpperCase()}</span>
          <div><h3>{a.name}</h3><div className="dim mono" style={{ fontSize: 12.5 }}><Server size={12} /> {a.host || '—'}{a.env ? ` · ${a.env}` : ''}</div></div>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="Close preview">×</button>
        </div>
        <div className="ap-facts">
          <div><span className="dim">{a.state === 'resolved' ? 'Peak value' : 'Current value'}</span><b>{valueText(a.state === 'resolved' ? a.peak : a.value, a.unit)}</b></div>
          <div><span className="dim">Threshold</span><b>{q.isPending ? '…' : threshold}</b></div>
          <div><span className="dim">Started</span><b>{dateTime(Date.parse(a.firedAt || a.activeAt)).slice(11, 16)}</b></div>
          <div><span className="dim">Duration</span><b>{durationText(a.durationSec)}</b></div>
          <div><span className="dim">Severity</span><SeverityPill s={a.severity} /></div>
        </div>
        {a.summary && <p className="muted" style={{ margin: '0 0 10px' }}>{a.summary}</p>}
        <div className="ap-actions">
          {a.host && <Link className="btn btn-sm" to={`/metrics/investigate?host=${encodeURIComponent(a.host)}`}><LineChart size={13} /> Open Metrics</Link>}
          {a.host && <Link className="btn btn-sm" to={`/metrics/host/${encodeURIComponent(a.host)}`}><Server size={13} /> Open Host</Link>}
          {a.runbook && <a className="btn btn-sm" href={a.runbook} target="_blank" rel="noopener noreferrer"><BookOpen size={13} /> Runbook</a>}
          <Link className="btn btn-sm btn-primary" to={`/alerting/alert/${a.id}`}><ExternalLink size={13} /> Details</Link>
        </div>
      </div>
      <div className="ap-right">
        {q.isPending ? <StateView kind="loading" /> : q.isError ? <ErrorState error={q.error} what="Alert" /> : <Evidence d={d!} compact />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Alert Rules
function RulesPage({ title, sub }: { title: string; sub: string }) {
  const { can } = useApp();
  const { confirm } = useDialogs();
  const qc = useQueryClient();
  const q = usePlainQuery(['rules'], () => api<{ rules: Rule[]; editable: boolean }>('/rules'));
  const [search, setSearch] = useState('');
  const reload = () => qc.invalidateQueries({ queryKey: ['rules'] });
  const d = q.data;
  const rows = (d?.rules || []).filter((r) => !search.trim() || `${r.name} ${r.group} ${r.summary}`.toLowerCase().includes(search.trim().toLowerCase()));
  const stateP: Record<string, string> = { firing: 'pill-solid-red', pending: 'pill-solid-orange', inactive: 'pill-solid-green' };
  return (
    <>
      <PageHead title={title} sub={sub} actions={<CreateButton />} />
      <div className="toolbar">
        <label className="search-field" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Search size={14} aria-hidden />
          <input className="input input-sm" type="search" placeholder="Search rules" aria-label="Search rules" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 220 }} />
        </label>
        <div className="grow" />
        {d && <span className="dim" style={{ fontSize: 12.5 }}>{d.rules.length} rules · {d.rules.filter((r) => r.custom).length} created here · {d.rules.filter((r) => r.state === 'firing').length} firing</span>}
      </div>
      {q.isPending ? <TableWrap label="Rules"><StateView kind="loading" skeleton="table" /></TableWrap>
        : q.isError ? <TableWrap label="Rules"><ErrorState error={q.error} what="Rules" /></TableWrap>
          : !d!.rules.length ? <TableWrap label="Rules"><StateView kind="empty" title="No alert rules loaded" text='Prometheus has no alerting rules. Create one with "Create alert".' /></TableWrap> : (
            <>
              {!d!.editable && can('alerts.rules') && <InfoBox>Rules from files are read-only here. Set UI_RULES_FILE to allow creating rules in this page.</InfoBox>}
              <TableWrap label="Rules">
                <table className="tbl">
                  <thead><tr>{['Rule', 'Group', 'Severity', 'State', 'For', 'Query', ''].map((x, i) => <th key={x || i}>{x}</th>)}</tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={`${r.group}-${r.name}`}>
                        <td><b style={{ fontWeight: 600 }}>{r.name}</b>{r.custom && <span style={{ marginLeft: 6 }}><Pill tone="blue">created here</Pill></span>}<div className="dim" style={{ fontSize: 11.5 }}>{r.summary.replace(/\{\{.*?\}\}/g, '…')}</div></td>
                        <td className="dim">{r.group}</td>
                        <td><SeverityPill s={r.severity} /></td>
                        <td><span className={`pill ${stateP[r.state] || 'pill-muted'}`}>{r.state === 'inactive' ? 'OK' : `${r.state}${r.firing ? ` (${r.firing})` : ''}`}</span>{r.health === 'err' && <div className="c-red" style={{ fontSize: 11 }}>{r.lastError}</div>}</td>
                        <td className="dim">{r.duration ? `${Math.round(r.duration / 60)}m` : '0m'}</td>
                        <td className="mono msg" style={{ fontSize: 11.5, maxWidth: 380 }} title={r.query}>{r.query}</td>
                        <td>{r.custom && can('alerts.rules') && <button className="icon-btn" title="Delete rule" aria-label={`Delete rule ${r.name}`} onClick={async () => {
                          if (!(await confirm('Delete rule', `Delete alert rule "${r.name}"?`, 'Delete'))) return;
                          try { await api(`/rules/${encodeURIComponent(r.name)}`, { method: 'DELETE' }); toast('Rule deleted'); reload(); } catch (e) { toast((e as Error).message, 'err'); }
                        }}><Trash2 size={14} /></button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </>
          )}
    </>
  );
}

// ---------------------------------------------------------------- Silences
function SilencesPage({ title, sub }: { title: string; sub: string }) {
  const { can } = useApp();
  const qc = useQueryClient();
  const q = usePlainQuery(['alerting'], () => api<{ alerts: AmAlert[]; silences: Silence[] }>('/alerts'));
  const reload = () => { qc.invalidateQueries({ queryKey: ['alerting'] }); qc.invalidateQueries({ queryKey: ['alerts-list'] }); };
  const d = q.data;
  return (
    <>
      <PageHead title={title} sub={sub} />
      {q.isPending ? <TableWrap label="Silences"><StateView kind="loading" skeleton="table" /></TableWrap>
        : q.isError ? <TableWrap label="Silences"><ErrorState error={q.error} what="Silences" /></TableWrap>
          : !d!.silences.length ? <TableWrap label="Silences"><StateView kind="empty" title="No silences" text='Silence an alert from Active Alerts (⋮ → Silence…).' /></TableWrap> : (
            <TableWrap label="Silences">
              <table className="tbl">
                <thead><tr>{['Matchers', 'State', 'Alerts muted', 'Created by', 'Comment', timeHeader('Ends'), ''].map((x, i) => <th key={x || i}>{x}</th>)}</tr></thead>
                <tbody>
                  {d!.silences.map((s) => (
                    <tr key={s.id}>
                      <td className="mono" style={{ fontSize: 12 }}>{s.matchers.map((m) => `${m.name}="${m.value}"`).join(', ')}</td>
                      <td><Pill tone={s.state === 'active' ? 'blue' : 'muted'}>{s.state}</Pill></td>
                      <td className="num">{d!.alerts.filter((a) => a.silencedBy.includes(s.id)).length}</td>
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
          )}
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
