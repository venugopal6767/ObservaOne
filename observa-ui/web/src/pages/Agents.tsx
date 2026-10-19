// Agents, organised per platform: an overview of the whole fleet, then one section each for Linux, Windows,
// Docker and Kubernetes with that platform's agents and its own install steps, plus enrollment tokens.
// Linux uses the ObservaOne Go agent (enrollment token -> own credential, heartbeats, status rules on the
// server); Windows, Docker and Kubernetes still use the previous-generation agent (token sent with every upload).
// Every number comes from /api/agents (the database + Prometheus). A value the agent has not reported shows
// "-"; an agent that stopped sending heartbeats shows "Not reporting" (the host may still be up).
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Copy, Trash2, ShieldCheck, Terminal, Monitor, Container, Boxes, Server, AlertTriangle, KeyRound, Pencil, Check, X as XIcon, Minus } from 'lucide-react';
import { api } from '@/lib/api';
import { fmt, ago, dateTime } from '@/lib/format';
import { toneClass } from '@/lib/theme';
import { useApp, usePlainQuery } from '@/app/AppContext';
import { ErrorState, Field, InfoBox, Modal, PageHead, Pill, Select, StateBanner, StateView, TableFoot, TableWrap, Tabs, Time, copyText, toast, useDialogs, usePager, type Tone } from '@/components/ui';
import { StatCard } from '@/components/StatCard';
import { AgentManagePanel, FleetSettings, GatewaysPanel } from '@/components/AgentManage';

type Platform = 'linux' | 'windows' | 'docker' | 'kubernetes';
type Status = 'online' | 'attention' | 'not_reporting' | 'offline' | 'pending' | 'blocked';
interface Agent {
  id: string; host: string; platform: Platform; os: string; arch: string; version: string; env: string; role: string; cluster: string; ip: string;
  kernel: string; labels: Record<string, string>; token: string | null; enrolled: boolean; enrolledAt: string | null; lastHeartbeat: string | null;
  lastData: string | null; lastSeen: string | null; bootTime: string | null; status: Status; statusReason: string; problems: string[];
  outdated: boolean; cpu: number | null; mem: number | null; diskFree: number | null;
  mode: 'push' | 'pull' | null; address: string | null; addresses: string[]; gatewayId?: string | null; tenant?: string;
  pull: { port: number | null; ips: string[]; dns: string[]; listening: boolean | null; scrapes: number | null; lastScrapeAgoSeconds: number | null; certNotAfter: string | null; refused: number | null; error: string } | null;
  diagnosis: Diagnosis | null;
  diag?: { collectors: Record<string, string> | null; collectorErrors?: Record<string, string>; uploadFailures: number | null; lastError: string; uptimeSeconds: number | null; diskBuffered?: number | null };
}
type Severity = 'ok' | 'info' | 'warning' | 'critical';
interface Diagnosis { code: string; severity: Severity; title: string; detail: string; evidence: { signal: string; value: string; ok: boolean | null }[] }
const SEV_TONE: Record<Severity, Tone> = { ok: 'green', info: 'blue', warning: 'orange', critical: 'red' };
interface AgentsData {
  agents: Agent[]; latest: string; latestPrevious: string;
  thresholds: { onlineSeconds: number; offlineSeconds: number; heartbeatSeconds: number };
}
interface InstallInfo { server: string; cert: { available: boolean; selfSigned?: boolean; sha256?: string; spkiPin?: string; issuer?: string }; versions: Record<string, string> }
interface Token { id: number; name: string; prefix: string; createdBy: string; createdAt: string; lastUsed: string | null; expiresAt: string | null; revoked: boolean; expired: boolean; usedUp: boolean; maxUses: number | null; uses: number; agents: number }

type Support = 'ready' | 'previous';
const SUPPORT: Record<Support, [string, Tone, string]> = {
  ready: ['Ready', 'green', 'ObservaOne Go agent: enrollment, heartbeats and host metrics tested end to end.'],
  previous: ['Previous agent', 'orange', 'Works with the previous-generation agent (OpenTelemetry Collector). The Go agent for this platform is planned.'],
};
const PLATFORMS: Record<Platform, { label: string; Icon: typeof Server; support: Support; desc: string }> = {
  linux: { label: 'Linux', Icon: Terminal, support: 'ready', desc: 'Servers and VMs with systemd: Ubuntu, Debian, RHEL, Rocky, AlmaLinux, Amazon Linux, SUSE. amd64 and arm64.' },
  windows: { label: 'Windows', Icon: Monitor, support: 'previous', desc: 'Windows Server 2016 and newer. Uses the previous-generation agent until the Go agent for Windows is released.' },
  docker: { label: 'Docker', Icon: Container, support: 'previous', desc: 'A Docker host and every container on it. Uses the previous-generation agent until the Go agent supports containers.' },
  kubernetes: { label: 'Kubernetes', Icon: Boxes, support: 'previous', desc: 'Every node, pod and cluster event; also OpenShift, EKS, AKS, GKE. Uses the previous-generation agent for now.' },
};
const PLATFORM_KEYS = Object.keys(PLATFORMS) as Platform[];
const STATUS: Record<Status, [string, Tone]> = {
  online: ['Online', 'solid-green'], attention: ['Needs attention', 'solid-orange'], not_reporting: ['Not reporting', 'stale'],
  offline: ['Offline', 'solid-red'], pending: ['Waiting for first heartbeat', 'muted'], blocked: ['Blocked', 'muted'],
};
const DISTROS: Record<string, [string, string]> = {
  debian: ['Ubuntu / Debian', 'sudo apt-get update && sudo apt-get install -y curl'],
  rhel: ['RHEL / Rocky / AlmaLinux / CentOS Stream', 'sudo dnf install -y curl'],
  amazon: ['Amazon Linux 2 / 2023', 'sudo yum install -y curl'],
  suse: ['SUSE / openSUSE', 'sudo zypper install -y curl'],
};
type TabKey = 'overview' | Platform | 'settings' | 'gateways' | 'tokens';
type StatusFilter = 'all' | Status;

const counts = (list: Agent[]) => ({
  total: list.length,
  online: list.filter((a) => a.status === 'online' || a.status === 'attention').length,
  attention: list.filter((a) => a.status === 'attention' || a.status === 'blocked' || a.outdated).length,
  notReporting: list.filter((a) => a.status === 'not_reporting').length,
  offline: list.filter((a) => a.status === 'offline').length,
  pending: list.filter((a) => a.status === 'pending').length,
});
const secs = (s?: number) => (!s ? '-' : s < 120 ? `${s} s` : `${Math.round(s / 60)} min`);
const StatusPill = ({ a }: { a: Pick<Agent, 'status' | 'statusReason'> }) => {
  const [label, tone] = STATUS[a.status] || [a.status, 'muted'];
  return <Pill tone={tone} title={a.statusReason || label}>{label}</Pill>;
};

export default function Agents() {
  const { can } = useApp();
  const canManage = can('integrations.manage');
  const [params, setParams] = useSearchParams();
  const tab: TabKey = (() => {
    const t = params.get('tab');
    if (t === 'install') return (params.get('platform') as Platform) || 'linux';
    if (t === 'fleet') return 'overview';
    if (t && (t === 'tokens' || t === 'settings' || t === 'gateways' || t in PLATFORMS)) return t as TabKey;
    return 'overview';
  })();
  const view = params.get('view') === 'install' || params.get('tab') === 'install' ? 'install' : 'agents';
  const go = (k: TabKey, v: 'agents' | 'install' = 'agents') => {
    const n = new URLSearchParams(); if (k !== 'overview') n.set('tab', k); if (v === 'install') n.set('view', 'install'); setParams(n, { replace: true });
  };

  const q = usePlainQuery(['agents'], () => api<AgentsData>('/agents'));
  const info = useQuery({ queryKey: ['agents-install-info'], queryFn: () => api<InstallInfo>('/agents/install-info'), staleTime: 300_000 });
  const d = q.data;
  const head = <PageHead title="Agents" sub="One ObservaOne Agent per server sends its metrics to this platform"
    actions={canManage ? <><Link className="btn" to="/infrastructure/add"><Plus size={15} />Add target</Link><button className="btn btn-primary" onClick={() => go(tab in PLATFORMS ? tab : 'linux', 'install')}><Plus size={15} />Install agent</button></> : undefined} />;

  const tabs: [TabKey, string][] = [['overview', `All platforms${d ? ` (${d.agents.length})` : ''}`], ...PLATFORM_KEYS.map((p) => [p, `${PLATFORMS[p].label}${d ? ` (${d.agents.filter((a) => a.platform === p).length})` : ''}`] as [TabKey, string])];
  if (canManage) tabs.push(['settings', 'Settings'], ['gateways', 'Gateways'], ['tokens', 'Enrollment tokens']);

  return (
    <>
      {head}
      <div className="toolbar"><Tabs items={tabs} active={tab} onChange={(k) => go(k)} label="Agent platforms" /></div>
      {tab === 'tokens' ? (canManage ? <Tokens /> : null)
        : tab === 'settings' ? <FleetSettings canManage={canManage} />
        : tab === 'gateways' ? <GatewaysPanel canManage={canManage} />
        : q.isPending ? <TableWrap label="Agents"><StateView kind="loading" skeleton="table" /></TableWrap>
          : q.isError ? <TableWrap label="Agents"><ErrorState error={q.error} what="Agents" /></TableWrap>
            : tab === 'overview' ? <Overview data={d!} canManage={canManage} go={go} />
              : <PlatformSection p={tab as Platform} data={d!} canManage={canManage} view={view} go={go} info={info.data} infoError={info.error} />}
    </>
  );
}

function StatCards({ list, data, onFilter, sub }: { list: Agent[]; data: AgentsData; onFilter: (f: StatusFilter) => void; sub?: string }) {
  const c = counts(list), t = data.thresholds || {} as AgentsData['thresholds'];
  return (
    <div className="grid cards-5" style={{ marginBottom: 16 }}>
      <StatCard label="Agents" value={c.total} onClick={() => onFilter('all')} extra={<div className="dim tile-sub">{sub || (c.pending ? `${c.pending} waiting for first heartbeat` : 'enrolled')}</div>} />
      <StatCard label="Online" value={c.online} tone={c.online ? 'green' : ''} onClick={() => onFilter('online')} extra={<div className="dim tile-sub">heartbeat in the last {secs(t.onlineSeconds)}</div>} />
      <StatCard label="Not reporting" value={c.notReporting} tone={c.notReporting ? 'orange' : ''} onClick={() => onFilter('not_reporting')} extra={<div className="dim tile-sub">{c.notReporting ? 'silent; the host may still be up' : 'none'}</div>} />
      <StatCard label="Offline" value={c.offline} tone={c.offline ? 'red' : ''} onClick={() => onFilter('offline')} extra={<div className="dim tile-sub">silent for more than {secs(t.offlineSeconds)}</div>} />
      <StatCard label="Needs attention" value={c.attention} tone={c.attention ? 'orange' : ''} onClick={() => onFilter('attention')} extra={<div className="dim tile-sub">problems, outdated or blocked</div>} />
    </div>
  );
}

function Overview({ data, canManage, go }: { data: AgentsData; canManage: boolean; go: (k: TabKey, v?: 'agents' | 'install') => void }) {
  const [status, setStatus] = useState<StatusFilter>('all');
  return (
    <>
      <StatCards list={data.agents} data={data} onFilter={setStatus} />
      <div className="grid cards-4" style={{ marginBottom: 16 }}>
        {PLATFORM_KEYS.map((p) => {
          const c = counts(data.agents.filter((a) => a.platform === p)), m = PLATFORMS[p];
          return (
            <button key={p} className="panel platform-card" onClick={() => go(p, c.total ? 'agents' : canManage ? 'install' : 'agents')}>
              <div className="platform-card-head"><m.Icon size={18} /><b>{m.label}</b><span className="grow" /><Pill tone={SUPPORT[m.support][1]} title={SUPPORT[m.support][2]}>{SUPPORT[m.support][0]}</Pill></div>
              {c.total ? (
                <div className="platform-card-counts"><span className="c-green">{c.online} online</span>{c.notReporting > 0 && <span className="c-orange">{c.notReporting} not reporting</span>}{c.offline > 0 && <span className="c-red">{c.offline} offline</span>}<span className="dim">of {c.total}</span></div>
              ) : <div className="dim">{canManage ? 'No agents yet. Install one.' : 'No agents yet.'}</div>}
            </button>
          );
        })}
      </div>
      <Fleet agents={data.agents} data={data} canManage={canManage} showPlatform status={status} setStatus={setStatus} onInstall={() => go('linux', 'install')} />
    </>
  );
}

function PlatformSection({ p, data, canManage, view, go, info, infoError }: {
  p: Platform; data: AgentsData; canManage: boolean; view: 'agents' | 'install'; go: (k: TabKey, v?: 'agents' | 'install') => void; info?: InstallInfo; infoError: unknown;
}) {
  const m = PLATFORMS[p];
  const list = data.agents.filter((a) => a.platform === p);
  const [status, setStatus] = useState<StatusFilter>('all');
  return (
    <div className="platform-section">
      <div className="section-head">
        <div>
          <h2><m.Icon size={18} />{m.label} <Pill tone={SUPPORT[m.support][1]} title={SUPPORT[m.support][2]}>{SUPPORT[m.support][0]}</Pill></h2>
          <p className="muted">{m.desc}</p>
        </div>
        <Tabs items={[['agents', `Agents (${list.length})`], ['install', 'Install']]} active={view} onChange={(v) => go(p, v)} label={`${m.label} sections`} />
      </div>
      {view === 'install' ? (
        !canManage ? <TableWrap label="Install"><StateView kind="empty" title='Installing agents needs the "integrations.manage" permission' text="Ask an administrator to install the agent or to give you that permission." /></TableWrap>
          : info ? <InstallWizard p={p} info={info} latest={data.latest} goTokens={() => go('tokens')} /> : infoError ? <ErrorState error={infoError} what="Install information" /> : <StateView kind="loading" />
      ) : (
        <>
          <StatCards list={list} data={data} onFilter={setStatus} sub={list.length ? undefined : 'none enrolled yet'} />
          <Fleet agents={list} data={data} canManage={canManage} status={status} setStatus={setStatus} platform={p} onInstall={() => go(p, 'install')} />
        </>
      )}
    </div>
  );
}

function Fleet({ agents, data, canManage, showPlatform, platform, status, setStatus, onInstall }: {
  agents: Agent[]; data: AgentsData; canManage: boolean; showPlatform?: boolean; platform?: Platform; status: StatusFilter; setStatus: (s: StatusFilter) => void; onInstall: () => void;
}) {
  const { open, confirm } = useDialogs();
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const act = async (path: string, method: string, msg: string) => {
    try { await api(path, { method }); toast(msg); qc.invalidateQueries({ queryKey: ['agents'] }); } catch (e) { toast((e as Error).message, 'err'); }
  };
  const list = useMemo(() => {
    const f = filter.toLowerCase();
    const match = (a: Agent) => status === 'all' || a.status === status || (status === 'online' && a.status === 'attention') || (status === 'attention' && (a.status === 'blocked' || a.outdated));
    return agents.filter((a) => match(a) && (!f || [a.host, a.os, a.env, a.role, a.ip, a.cluster, a.version, a.id, ...Object.entries(a.labels || {}).map(([k, v]) => `${k}=${v}`)].join(' ').toLowerCase().includes(f)));
  }, [agents, filter, status]);
  const pager = usePager(list, 50, `${filter}|${status}`);
  if (!agents.length) {
    return <TableWrap label="Agents"><StateView kind="empty" title={platform ? `No ${PLATFORMS[platform].label} agents enrolled` : 'No agents enrolled'}
      text={canManage ? 'Install the agent on a server and it shows up here within a minute.' : 'No agent has enrolled yet. An administrator can install agents from this page.'}
      action={canManage ? <button className="btn btn-primary" onClick={onInstall}>Install an agent</button> : undefined} /></TableWrap>;
  }
  const labelsOf = (a: Agent) => [a.env && `env=${a.env}`, a.role && `role=${a.role}`, ...Object.entries(a.labels || {}).map(([k, v]) => `${k}=${v}`)].filter(Boolean) as string[];
  const showDetail = (a: Agent) => open((close) => <AgentDetail id={a.id} host={a.host} canManage={canManage} onClose={close} />);
  return (
    <>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <input className="input" type="search" placeholder="Filter: host, env, label, version, IP..." aria-label="Filter agents" style={{ width: 300, maxWidth: '100%' }} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Select className="select" label="Filter by status" style={{ width: 190 }} value={status} onChange={setStatus}
          options={[['all', 'All statuses'], ['online', 'Online'], ['attention', 'Needs attention'], ['not_reporting', 'Not reporting'], ['offline', 'Offline'], ['pending', 'Waiting'], ['blocked', 'Blocked']]} />
        <div className="grow" />
        <span className="dim" style={{ fontSize: 12 }}>Latest agent: {data.latest}</span>
      </div>
      <TableWrap label="Agents">
        <table className="tbl">
          <thead><tr>
            <th>Host</th>{showPlatform && <th>Platform</th>}<th>Status</th><th>Labels</th><th>Version</th>
            <th className="num">CPU</th><th className="num">Memory</th><th className="num">Disk free</th><th>Last heartbeat</th><th />
          </tr></thead>
          <tbody>
            {pager.rows.length ? pager.rows.map((a) => (
              <tr key={a.id} className="clickable" tabIndex={0} onClick={(e) => { if (!(e.target as HTMLElement).closest('button, a')) showDetail(a); }} onKeyDown={(e) => { if (e.key === 'Enter') showDetail(a); }}>
                <td><b style={{ fontWeight: 600 }}>{a.host}</b>{a.mode === 'pull' && <span className="chip mode-chip" title="Prometheus scrapes this agent (pull mode)">pull</span>}{a.gatewayId && <span className="chip mode-chip" title="Reports through a site gateway">via gateway</span>}<div className="dim" style={{ fontSize: 11 }}>{[a.os, a.arch].filter(Boolean).join(' · ') || a.id}</div></td>
                {showPlatform && <td>{PLATFORMS[a.platform]?.label || a.platform}</td>}
                <td><StatusPill a={a} />{a.diagnosis && a.diagnosis.severity !== 'ok' && a.diagnosis.code !== 'rebooted'
                  ? <div className={a.diagnosis.severity === 'critical' ? 'c-red' : a.diagnosis.severity === 'warning' ? 'c-orange' : 'dim'} style={{ fontSize: 11, marginTop: 3, maxWidth: 260 }} title={a.diagnosis.detail}>{a.diagnosis.title}</div>
                  : a.problems?.length > 0 && a.status !== 'not_reporting' && a.status !== 'offline' && <div className="c-orange" style={{ fontSize: 11, marginTop: 3, maxWidth: 260 }}>{a.problems[0]}</div>}</td>
                <td>{labelsOf(a).length ? <div className="label-chips">{labelsOf(a).slice(0, 4).map((l) => <span key={l} className="chip">{l}</span>)}</div> : <span className="dim">-</span>}</td>
                <td>{a.version ? (a.outdated ? <Pill tone="orange" title={`Latest is ${a.platform === 'linux' ? data.latest : data.latestPrevious}. Run the installer again to update.`}>{a.version} ↑</Pill> : a.version) : '-'}</td>
                <td className={`num ${toneClass(a.cpu)}`}>{fmt(a.cpu, 'percent')}</td>
                <td className={`num ${toneClass(a.mem)}`}>{fmt(a.mem, 'percent')}</td>
                <td className={`num ${toneClass(a.diskFree, false)}`}>{fmt(a.diskFree, 'percent')}</td>
                <td className="dim">{a.lastSeen ? <Time ms={Date.parse(a.lastSeen)} text={ago(a.lastSeen)} /> : 'never'}</td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>
                  {canManage && (a.status === 'blocked'
                    ? <button className="btn btn-sm" onClick={() => act(`/agents/${encodeURIComponent(a.id)}/unblock`, 'POST', `${a.host} can send data again`)}>Allow</button>
                    : <button className="btn btn-sm" title="Refuse everything this agent sends" onClick={async () => {
                      if (await confirm(`Block ${a.host}?`, 'The agent keeps running but ObservaOne refuses its heartbeats and data until you allow it again.', 'Block')) act(`/agents/${encodeURIComponent(a.id)}/block`, 'POST', `${a.host} blocked`);
                    }}>Block</button>)}
                  {canManage && a.status !== 'online' && a.status !== 'attention' && <button className="icon-btn" title="Remove this agent (after you uninstalled it)" aria-label={`Remove ${a.host}`} style={{ marginLeft: 4 }} onClick={async () => {
                    if (await confirm(`Remove ${a.host}?`, a.enrolled ? 'Removes it and its credential. If the agent is still installed it can no longer send anything; install it again with a new token to bring it back.' : 'Removes it from this list. A previous-generation agent that still has a valid token comes back when it next sends data.', 'Remove')) act(`/agents/${encodeURIComponent(a.id)}`, 'DELETE', `${a.host} removed`);
                  }}><Trash2 size={15} /></button>}
                </td>
              </tr>
            )) : <tr><td colSpan={10} className="dim">No agent matches the filter.</td></tr>}
          </tbody>
        </table>
        <TableFoot pager={pager} noun="agents" />
      </TableWrap>
    </>
  );
}

// ------------------------------------------------------------ agent detail
function DiagnosisPanel({ d }: { d: Diagnosis }) {
  const icon = (ok: boolean | null) => (ok === true ? <Check size={13} /> : ok === false ? <XIcon size={13} /> : <Minus size={13} />);
  return (
    <section className={`panel diag diag-${d.severity}`} aria-label="Diagnosis">
      <div className="diag-head"><Pill tone={SEV_TONE[d.severity]}>{d.title}</Pill></div>
      <p className="diag-detail">{d.detail}</p>
      <ul className="diag-evidence">
        {d.evidence.map((e) => <li key={e.signal} className={e.ok === true ? 'ok' : e.ok === false ? 'bad' : 'unk'}>{icon(e.ok)}<span className="sig">{e.signal}</span><span className="val">{e.value}</span></li>)}
      </ul>
    </section>
  );
}

function RenameAgent({ id, host }: { id: string; host: string }) {
  const qc = useQueryClient();
  const [edit, setEdit] = useState(false);
  const [name, setName] = useState(host);
  const save = async () => {
    try {
      await api(`/agents/${encodeURIComponent(id)}`, { method: 'PATCH', body: { host: name.trim() } });
      toast(`Renamed to ${name.trim()}. New data uses the new name; older data keeps ${host}.`);
      setEdit(false);
      qc.invalidateQueries({ queryKey: ['agents'] }); qc.invalidateQueries({ queryKey: ['agent', id] });
    } catch (e) { toast((e as Error).message, 'err'); }
  };
  if (!edit) return <button className="icon-btn" title="Rename this agent" aria-label="Rename" onClick={() => setEdit(true)}><Pencil size={13} /></button>;
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, width: '100%' }}>
      <input className="input" style={{ flex: '1 1 140px', minWidth: 0, height: 28 }} aria-label="New name" value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEdit(false); }} />
      <button className="btn btn-sm btn-primary" onClick={save}>Save</button><button className="btn btn-sm" onClick={() => setEdit(false)}>Cancel</button>
    </span>
  );
}

function AgentDetail({ id, host, canManage, onClose }: { id: string; host: string; canManage: boolean; onClose: () => void }) {
  const { canOpen } = useApp();
  const q = useQuery({ queryKey: ['agent', id], queryFn: () => api<{ agent: Agent }>(`/agents/${encodeURIComponent(id)}`) });
  const d = q.data?.agent;
  const when = (x: string | null) => (x ? <span><Time ms={Date.parse(x)} text={dateTime(Date.parse(x)).slice(0, 16)} /><span className="dim"> ({ago(x)})</span></span> : <span className="dim">-</span>);
  const row = (k: string, v: React.ReactNode) => <><dt>{k}</dt><dd>{v === null || v === undefined || v === '' ? <span className="dim">-</span> : v}</dd></>;
  const coll = d?.diag?.collectors || {};
  const errs = d?.diag?.collectorErrors || {};
  const collTone: Record<string, Tone> = { ok: 'green', running: 'green', unavailable: 'muted', disabled: 'muted', error: 'red', failed: 'red', stopped: 'red' };
  return (
    <Modal title={host} onClose={onClose} wide actions={[{ label: 'Close' }]}>
      {q.isPending ? <StateView kind="loading" skeleton="cards" /> : q.isError ? <ErrorState error={q.error} what="Agent" /> : d && (
        <>
          <div className="detail-status"><StatusPill a={d} /><span className="muted">{d.statusReason || 'Everything is reporting normally.'}</span></div>
          {d.diagnosis && <DiagnosisPanel d={d.diagnosis} />}
          {d.problems?.length > 0 && <ul className="problem-list">{d.problems.map((p) => <li key={p}><AlertTriangle size={14} />{p}</li>)}</ul>}
          <div className="grid cols-2">
            <section className="panel">
              <div className="panel-head"><h3>Identity</h3></div>
              <dl className="kv">
                {row('Name', <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>{d.host}{canManage && d.enrolled && <RenameAgent id={d.id} host={d.host} />}</span>)}
                {row('Agent ID', <code>{d.id}</code>)}{row('Platform', PLATFORMS[d.platform]?.label || d.platform)}{row('OS', d.os)}
                {d.platform === 'linux' && row('Kernel', d.kernel)}{row('Architecture', d.arch)}{row('Version', d.version)}{row('Address', d.ip)}
                {d.addresses?.length > 0 && row('Host addresses', d.addresses.join(', '))}
                {d.enrolled && row('Transport', d.mode === 'pull' ? 'Pull: Prometheus scrapes the agent (mutual TLS)' : 'Push: the agent sends metrics over HTTPS')}
                {row('Labels', [d.env && `env=${d.env}`, d.role && `role=${d.role}`, ...Object.entries(d.labels || {}).map(([k, v]) => `${k}=${v}`)].filter(Boolean).join(', '))}
                {row('Enrolled', when(d.enrolledAt))}{row('Token', d.token)}{row('Credential', d.enrolled ? 'Own credential (enrolled)' : 'Shared token (previous agent)')}
              </dl>
            </section>
            <section className="panel">
              <div className="panel-head"><h3>Reporting</h3></div>
              <dl className="kv">
                {row('Last heartbeat', d.enrolled ? when(d.lastHeartbeat) : <span className="dim">Not sent by the previous-generation agent; status comes from its last data</span>)}
                {row('Last data', when(d.lastData))}{d.enrolled && row('Host booted', when(d.bootTime))}
                {row('CPU', fmt(d.cpu, 'percent'))}{row('Memory', fmt(d.mem, 'percent'))}{row('Lowest disk free', fmt(d.diskFree, 'percent'))}
                {d.enrolled && row('Upload failures', d.diag?.uploadFailures != null ? String(d.diag.uploadFailures) : null)}
                {d.enrolled && (d.diag?.diskBuffered ?? 0) > 0 && row('Disk buffer', `${d.diag!.diskBuffered} collections waiting`)}
                {d.enrolled && row('Agent error', d.diag?.lastError || null)}
                {d.mode === 'pull' && d.pull && <>
                  {row('Scraped at', d.address)}
                  {row('Pull endpoint', d.pull.listening === false ? <span className="c-red">not listening{d.pull.error ? `: ${d.pull.error}` : ''}</span> : d.pull.listening ? 'listening' : null)}
                  {row('Last scrape', d.pull.lastScrapeAgoSeconds != null ? `${secs(d.pull.lastScrapeAgoSeconds)} ago (${d.pull.scrapes ?? 0} in total)` : 'never')}
                  {Number(d.pull.refused) > 0 && row('Refused connections', `${d.pull.refused} (outside pull.allow)`)}
                  {row('Certificate valid until', d.pull.certNotAfter ? dateTime(Date.parse(d.pull.certNotAfter)).slice(0, 10) : null)}
                </>}
              </dl>
            </section>
          </div>
          {Object.keys(coll).length > 0 && (
            <section className="panel" style={{ marginTop: 14 }}>
              <div className="panel-head"><h3>Collectors</h3></div>
              <table className="tbl compact">
                <thead><tr><th>Collector</th><th>State</th><th>Detail</th></tr></thead>
                <tbody>{Object.keys(coll).sort().map((k) => <tr key={k}><td>{k}</td><td><Pill tone={collTone[coll[k]] || 'muted'}>{coll[k]}</Pill></td><td className="dim">{errs[k] || ''}</td></tr>)}</tbody>
              </table>
            </section>
          )}
          {d.enrolled && <AgentManagePanel id={d.id} host={d.host} canManage={canManage} />}
          {canOpen('/metrics') && <p style={{ marginTop: 12 }}><Link to={`/metrics/host/${encodeURIComponent(d.host)}`} onClick={onClose}>Open the host view for {d.host} →</Link></p>}
        </>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------ install (one platform)
const shq = (v: string) => `'${String(v).replace(/'/g, "'\\''")}'`;
function commandFor(p: Platform, info: InstallInfo, w: Wiz): string {
  const S = info.server;
  const c = info.cert || { available: false };
  const pin = c.available && c.selfSigned;
  const curlGet = pin ? `curl -fsSLk --pinnedpubkey "${c.spkiPin}"` : 'curl -fsSL';
  if (p === 'linux') {
    // no --token: the installer asks for it and hides what is typed (never in shell history or ps)
    const opts = [`--server ${S}`];
    if (pin) opts.push(`--ca-sha256 ${c.sha256}`);
    if (w.env) opts.push(`--env ${shq(w.env)}`);
    if (w.role) opts.push(`--role ${shq(w.role)}`);
    for (const l of w.labels.split(',').map((x) => x.trim()).filter(Boolean)) opts.push(`--label ${shq(l)}`);
    if (w.mode === 'pull') {
      opts.push('--mode pull');
      if (w.pullPort.trim()) opts.push(`--pull-port ${shq(w.pullPort.trim())}`);
      if (w.pullAdvertise.trim()) opts.push(`--pull-advertise ${shq(w.pullAdvertise.trim())}`);
      for (const a of w.pullAllow.split(',').map((x) => x.trim()).filter(Boolean)) opts.push(`--pull-allow ${shq(a)}`);
    }
    if (w.dockerMetrics) opts.push('--docker-metrics');
    if (w.nginx.trim()) opts.push(`--nginx-status ${shq(w.nginx.trim())}`);
    for (const j of w.jolokia.split(',').map((x) => x.trim()).filter(Boolean)) opts.push(`--jolokia ${shq(j)}`);
    for (const j of w.exporters.split(',').map((x) => x.trim()).filter(Boolean)) opts.push(`--exporter ${shq(j)}`);
    return [`${curlGet} ${S}/agent/install.sh -o observaone-install.sh`, `sudo bash observaone-install.sh \\\n  ${opts.join(' \\\n  ')}`].join('\n');
  }
  const t = w.token || '<TOKEN>';
  if (p === 'docker') {
    const opts = ['--docker', `--server ${S}`, `--token ${t}`];
    if (pin) opts.push(`--ca-sha256 ${c.sha256}`);
    if (w.env) opts.push(`--env ${shq(w.env)}`);
    if (w.role) opts.push(`--role ${shq(w.role)}`);
    if (w.logs.trim()) opts.push(`--logs ${shq(w.logs.trim())}`);
    return `${curlGet} ${S}/agent/install-legacy.sh | sudo bash -s -- \\\n  ${opts.join(' \\\n  ')}`;
  }
  if (p === 'windows') {
    const ps = (v: string) => `'${String(v).replace(/'/g, "''")}'`;
    const args = [`-Server ${S}`]; // no -Token: the installer asks for it (hidden), so it stays out of PowerShell history
    if (pin) args.push(`-CaSha256 ${c.sha256}`);
    if (w.env) args.push(`-Env ${ps(w.env)}`);
    if (w.role) args.push(`-Role ${ps(w.role)}`);
    if (w.logs.trim()) args.push(`-Logs ${ps(w.logs.trim())}`);
    if (w.securityLog) args.push('-SecurityLog');
    const lines = ["[Net.ServicePointManager]::SecurityProtocol = 'Tls12'"];
    if (pin) {
      // compiled fingerprint check, for this server only (other sites keep the normal check);
      // a script-block callback fails in Windows PowerShell 5.1
      lines.push('Add-Type @"');
      lines.push('using System; using System.Net; using System.Net.Security; using System.Security.Cryptography; using System.Security.Cryptography.X509Certificates;');
      lines.push('public static class ObservaOneCertPin { static string fp; static string host;');
      lines.push('  static bool Check(object s, X509Certificate c, X509Chain ch, SslPolicyErrors e) { var r = s as HttpWebRequest; if (r == null || !string.Equals(r.RequestUri.Host, host, StringComparison.OrdinalIgnoreCase)) return e == SslPolicyErrors.None; if (c == null) return false; using (var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(c.GetRawCertData())).Replace("-", "").ToLower() == fp; }');
      lines.push('  public static void Enable(string f, string hst) { fp = f; host = hst; ServicePointManager.ServerCertificateValidationCallback = Check; } }');
      lines.push('"@');
      lines.push(`[ObservaOneCertPin]::Enable('${c.sha256}', '${new URL(S).hostname}')`);
    }
    lines.push(`& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing ${S}/agent/install.ps1).Content)) ${args.join(' ')}`);
    return lines.join('\n');
  }
  const cluster = w.cluster || '<CLUSTER-NAME>';
  const lines = ['kubectl create namespace observaone'];
  let caArgs = '';
  if (pin) {
    lines.push(`${curlGet} -o observaone-ca.crt ${S}/agent/server.crt`);
    caArgs = ' \\\n  --from-file=ca.crt=observaone-ca.crt --from-literal=caFile=/etc/observaone-agent/ca.crt';
  }
  lines.push(`kubectl -n observaone create secret generic observaone-agent \\\n  --from-literal=server=${S} \\\n  --from-literal=token=${t} \\\n  --from-literal=cluster=${shq(cluster)}${w.env ? ` \\\n  --from-literal=env=${shq(w.env)}` : ''}${caArgs}`);
  lines.push(`${curlGet} ${S}/agent/kubernetes.yaml | kubectl apply -f -`);
  return lines.join('\n');
}

interface Wiz { distro: string; env: string; role: string; labels: string; logs: string; cluster: string; token: string; securityLog: boolean; mode: 'push' | 'pull'; pullPort: string; pullAdvertise: string; pullAllow: string; dockerMetrics: boolean; nginx: string; jolokia: string; exporters: string }
function InstallWizard({ p, info, latest, goTokens }: { p: Platform; info: InstallInfo; latest: string; goTokens: () => void }) {
  const { open } = useDialogs();
  const [w, setW] = useState<Wiz>({ distro: 'debian', env: '', role: '', labels: '', logs: '', cluster: '', token: '', securityLog: false, mode: 'push', pullPort: '', pullAdvertise: '', pullAllow: '', dockerMetrics: false, nginx: '', jolokia: '', exporters: '' });
  const set = (k: keyof Wiz) => (e: React.ChangeEvent<HTMLInputElement>) => setW({ ...w, [k]: k === 'securityLog' || k === 'dockerMetrics' ? e.target.checked : e.target.value });
  const S = info.server;
  const c = info.cert || { available: false };
  const pin = c.available && c.selfSigned;
  const cmd = commandFor(p, info, w);
  const hostPort = S.replace(/^https?:\/\//, '');
  const tokenInCommand = p === 'docker' || p === 'kubernetes';
  const req: Record<Platform, string[]> = {
    linux: ['systemd; amd64 or arm64; about 15 MB of disk', 'root (sudo) to install; the agent itself runs as the unprivileged user observaone-agent',
      w.mode === 'pull' ? `outbound HTTPS (443) to ${hostPort} for heartbeats, and inbound TCP ${w.pullPort || '9110'} from the ObservaOne server for Prometheus scrapes`
        : `outbound HTTPS (443) from the server to ${hostPort}; no inbound port is opened`, 'curl and sha256sum (preinstalled on most distributions)'],
    windows: ['Windows Server 2016 or newer, PowerShell 5.1+', 'an Administrator PowerShell', `outbound HTTPS (443) to ${hostPort}`],
    docker: ['Docker Engine with the compose plugin', 'root (sudo)', `outbound HTTPS (443) to ${hostPort}`, 'images from Docker Hub and ghcr.io (or your mirror)'],
    kubernetes: ['kubectl with cluster-admin', `outbound HTTPS (443) from the nodes to ${hostPort}`, 'images from Docker Hub, quay.io and registry.k8s.io (or your mirror)'],
  };
  const where: Record<Platform, string> = {
    linux: 'Run on the server (the first line downloads the installer, the second runs it and asks for the token):',
    windows: 'Paste into Windows PowerShell opened with "Run as administrator" (it asks for the token at the end):',
    docker: 'Run on the Docker host as root (or with sudo):', kubernetes: 'Run where kubectl points at the cluster:',
  };
  const after: Record<Platform, React.ReactNode[]> = {
    linux: [<>Check it: <code>sudo observaone-agent status</code></>, <>Logs: <code>journalctl -u observaone-agent -f</code></>,
      <>Settings: <code>/etc/observaone-agent/agent.yaml</code> and <code>conf.d/*.yaml</code>, then <code>sudo systemctl reload observaone-agent</code></>,
      ...(w.mode === 'pull' ? [<>Open the pull port to the ObservaOne server only, e.g. <code>sudo ufw allow from SERVER_IP to any port {w.pullPort || '9110'} proto tcp</code>. If Prometheus cannot reach it, the Agents page says so.</>] : []),
      'Upgrade: run the same two lines again (identity and your settings are kept; a failed upgrade rolls back).', <>Remove: <code>sudo bash observaone-install.sh --uninstall</code></>],
    windows: ['Remove: run the same command with -Uninstall.'],
    docker: ['Runs the agent, node-exporter and cAdvisor containers in /opt/observaone-agent.', 'Remove: run the same command with --uninstall.'],
    kubernetes: ['Creates a DaemonSet (one agent per node), a cluster agent and kube-state-metrics in the observaone namespace.', 'OpenShift: also run  oc adm policy add-scc-to-user privileged -z observaone-agent -n observaone', 'Remove: kubectl delete -f kubernetes.yaml'],
  };
  return (
    <div className="agent-wizard">
      {!/^https:\/\//.test(S) && <StateBanner>This page was opened at {S}. Agents need the HTTPS address of this server as they reach it (never localhost): set PUBLIC_URL=https://your-server in .env, or open ObservaOne through its https:// address.</StateBanner>}
      <section className="panel">
        <div className="panel-head"><h3>1. Requirements</h3></div>
        <ul className="agent-notes" style={{ marginTop: 0 }}>{req[p].map((r) => <li key={r}>{r}</li>)}</ul>
        {p === 'linux' && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <span className="muted">Distribution</span>
            <Select className="select" label="Linux distribution" style={{ width: 300 }} value={w.distro} onChange={(v) => setW({ ...w, distro: v })} options={Object.entries(DISTROS).map(([k, [l]]) => [k, l] as [string, string])} />
            <span className="dim">curl missing?</span><code>{DISTROS[w.distro][1]}</code>
          </div>
        )}
        {!c.available ? <div className="dim">Agents trust the server certificate through the normal system certificate store.</div>
          : pin ? <InfoBox tone="ok"><ShieldCheck size={14} style={{ verticalAlign: -2 }} /> Self-signed server certificate: the commands pin its fingerprint, so agents only ever talk to this server: <code>{c.sha256?.slice(0, 16)}…</code></InfoBox>
            : <div className="dim">Certificate issued by {c.issuer}. Agents verify it through their system certificate store.</div>}
      </section>
      <section className="panel">
        <div className="panel-head"><h3>2. Enrollment token</h3></div>
        <p className="muted" style={{ marginTop: 0 }}>
          {p === 'linux' ? <>The installer asks for the token and hides what you type, so it never ends up in shell history or the process list. Each server swaps it for its own credential; revoking the token later only stops new enrollments. For automation use <code>--token-file FILE</code>.</>
            : p === 'windows' ? 'The installer asks for the token and hides what you type, so it stays out of PowerShell history. The previous-generation Windows agent keeps it on the server and sends it with every upload: revoking the token stops every agent that uses it.'
              : 'The previous-generation agent keeps the token on the server and sends it with every upload. Revoking the token stops every agent that uses it.'}
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {tokenInCommand && <input className="input mono" placeholder="oat_..." aria-label="Agent token" value={w.token} onChange={(e) => setW({ ...w, token: e.target.value.trim() })} style={{ flex: 1, minWidth: 220 }} />}
          <button className="btn" style={{ whiteSpace: 'nowrap' }} onClick={() => open((close) => <NewTokenDialog platform={p} onClose={close} onCreated={(tok) => { if (tokenInCommand) setW((x) => ({ ...x, token: tok })); }} />)}><Plus size={14} />Create a token</button>
          <button className="btn btn-ghost" onClick={goTokens}><KeyRound size={14} />Manage tokens</button>
        </div>
      </section>
      <section className="panel">
        <div className="panel-head"><h3>3. Options</h3></div>
        <div className="grid cols-2">
          <Field label="Environment (optional)"><input className="input" placeholder="prod, uat, dev" value={w.env} onChange={set('env')} /></Field>
          {p !== 'kubernetes' && <Field label="Role (optional)"><input className="input" placeholder={p === 'windows' ? 'sql, iis, app' : 'web, database, app'} value={w.role} onChange={set('role')} /></Field>}
          {p === 'linux' && <Field label="Labels (optional)" hint="key=value, comma separated; lower-case keys. Up to 10."><input className="input" placeholder="team=payments, tier=1" value={w.labels} onChange={set('labels')} /></Field>}
          {p === 'linux' && <Field label="How metrics travel" hint={w.mode === 'push' ? 'The agent sends metrics out over HTTPS. Works through NAT and firewalls; nothing listens on the server.' : "ObservaOne's Prometheus scrapes the agent over mutual TLS. Needs an inbound port on the server."}>
            <Select className="select" label="Transport" value={w.mode} onChange={(v) => setW({ ...w, mode: v as Wiz['mode'] })} options={[['push', 'Push (recommended)'], ['pull', 'Pull (Prometheus scrapes the agent)']]} />
          </Field>}
          {p === 'linux' && w.mode === 'pull' && <>
            <Field label="Pull port (optional)" hint="Default 9110 (1024-65535)."><input className="input" placeholder="9110" value={w.pullPort} onChange={set('pullPort')} /></Field>
            <Field label="Address to scrape (optional)" hint="Only when ObservaOne must use another address than the server's own (NAT, several networks)."><input className="input" placeholder="10.0.0.5" value={w.pullAdvertise} onChange={set('pullAdvertise')} /></Field>
            <Field label="Allowed sources (optional)" hint="IPs or CIDRs, comma separated. A client certificate is always required as well."><input className="input" placeholder="10.0.0.0/8" value={w.pullAllow} onChange={set('pullAllow')} /></Field>
          </>}
          {p === 'kubernetes' && <Field label="Cluster name" hint="Added to every metric as cluster=..."><input className="input" placeholder="prod-cluster" value={w.cluster} onChange={set('cluster')} /></Field>}
          {(p === 'windows' || p === 'docker') && <Field label="Extra log files (optional)"><input className="input" placeholder={p === 'windows' ? 'C:\\inetpub\\logs\\LogFiles\\*\\*.log' : '/var/log/nginx/*.log'} value={w.logs} onChange={set('logs')} /></Field>}
        </div>
        {p === 'windows' && <label className="check-row"><input type="checkbox" checked={w.securityLog} onChange={set('securityLog')} /><span>Also send the Security event log (large)</span></label>}
        {p === 'linux' && (
          <details className="app-collectors">
            <summary>Applications on this server (optional): Docker, Nginx, JVM, local exporters</summary>
            <div className="grid cols-2" style={{ marginTop: 10 }}>
              <Field label="Nginx stub_status URL" hint="stub_status must be on, e.g. location /nginx_status { stub_status; allow 127.0.0.1; deny all; }"><input className="input" placeholder="http://127.0.0.1/nginx_status" value={w.nginx} onChange={set('nginx')} /></Field>
              <Field label="JVMs through Jolokia" hint="name=URL, comma separated; the name becomes service_name."><input className="input" placeholder="payments=http://127.0.0.1:8778/jolokia" value={w.jolokia} onChange={set('jolokia')} /></Field>
              <Field label="Local exporters to forward" hint="name=URL, comma separated; samples get exporter=name."><input className="input" placeholder="postgres=http://127.0.0.1:9187/metrics" value={w.exporters} onChange={set('exporters')} /></Field>
              <div>
                <label className="check-row"><input type="checkbox" checked={w.dockerMetrics} onChange={set('dockerMetrics')} /><span>Docker containers (CPU, memory, state)</span></label>
                {w.dockerMetrics && <div className="c-orange" style={{ fontSize: 12 }}>Adds the agent user to the docker group, which is root-equivalent on the host. The agent only reads (GET) from the Docker API.</div>}
              </div>
            </div>
            <div className="dim" style={{ fontSize: 12 }}>Top processes are on by default (10 by CPU and 10 by memory); change it under Agents → Settings or per agent.</div>
          </details>
        )}
      </section>
      <section className="panel">
        <div className="panel-head"><h3>4. Run</h3><button className="btn btn-sm right" onClick={() => copyText(cmd, 'Command copied')}><Copy size={13} />Copy</button></div>
        <div className="muted" style={{ marginBottom: 8 }}>{where[p]}</div>
        <pre className="code cmd" tabIndex={0} aria-label="Install command">{cmd}</pre>
        {tokenInCommand && !w.token && <div className="c-orange" style={{ marginTop: 8, fontSize: 12.5 }}>Create a token in step 2: the command still shows &lt;TOKEN&gt;.</div>}
        <ul className="agent-notes">{after[p].map((n, i) => <li key={i}>{n}</li>)}</ul>
        <div className="dim" style={{ fontSize: 12 }}>
          {p === 'linux' ? `ObservaOne Go agent ${latest}, about 7 MB, checksum-verified on download. The host appears under Agents and Infrastructure within a minute.`
            : `Previous-generation agent: OpenTelemetry Collector ${info.versions.otelcol || ''}. Every download is checked against a fixed SHA-256.`}
        </div>
      </section>
    </div>
  );
}

// ------------------------------------------------------------ tokens
function NewTokenDialog({ onClose, onCreated, platform }: { onClose: () => void; onCreated?: (t: string) => void; platform?: Platform }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [days, setDays] = useState(7);
  const [uses, setUses] = useState(platform === 'linux' ? 1 : 0);
  const [token, setToken] = useState<string | null>(null);
  if (token) {
    return (
      <Modal title="Copy the token now" onClose={onClose} actions={[{ label: 'Done', primary: true, onClick: () => { onCreated?.(token); } }]}>
        <p style={{ marginTop: 0 }}>This is the only time the token is shown. ObservaOne keeps only a fingerprint of it.</p>
        <pre className="code" style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>{token}</pre>
        <button className="btn" onClick={() => copyText(token)}><Copy size={13} />Copy</button>
      </Modal>
    );
  }
  return (
    <Modal title="New enrollment token" onClose={onClose} actions={[
      { label: 'Cancel' },
      { label: 'Create', primary: true, onClick: async () => {
        const r = await api<{ token: string }>('/agent-tokens', { method: 'POST', body: { name, expiresDays: days, maxUses: uses || null } });
        setToken(r.token);
        qc.invalidateQueries({ queryKey: ['agent-tokens'] });
        return false; // keep the dialog open to show the token
      } },
    ]}>
      <Field label="Name" hint="Where will you use it? Shown next to each agent that enrolled with it."><input className="input" maxLength={60} placeholder={platform ? `e.g. ${PLATFORMS[platform].label} servers, prod` : 'e.g. Production Linux servers'} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="grid cols-2">
        <Field label="Valid for" hint="After this, new enrollments are refused. Enrolled agents keep working."><Select options={[[1, '1 day'], [7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'Never']]} value={days} onChange={setDays} /></Field>
        <Field label="Can enroll" hint="Limits how many servers can enroll with it."><Select options={[[1, 'Once (one server)'], [10, '10 servers'], [100, '100 servers'], [0, 'Unlimited']]} value={uses} onChange={setUses} /></Field>
      </div>
    </Modal>
  );
}

function Tokens() {
  const { open, confirm } = useDialogs();
  const qc = useQueryClient();
  const [showOld, setShowOld] = useState(false);
  const q = useQuery({ queryKey: ['agent-tokens'], queryFn: () => api<{ tokens: Token[]; purgeMinutes: number }>('/agent-tokens') });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['agent-tokens'] }); qc.invalidateQueries({ queryKey: ['agents'] }); };
  const dead = (t: Token) => t.revoked || t.expired; // can never be used again
  const all = q.data?.tokens || [];
  const old = all.filter(dead);
  const tokens = showOld ? all : all.filter((t) => !dead(t));
  const purge = q.data?.purgeMinutes || 0;
  const remove = async (list: Token[]) => {
    const one = list.length === 1;
    if (!(await confirm(one ? `Delete "${list[0].name}"?` : `Delete ${list.length} revoked or expired tokens?`, 'They are removed from this list for good. Agents keep running, and the audit log keeps the record.', 'Delete'))) return;
    let failed = 0;
    for (const t of list) { try { await api(`/agent-tokens/${t.id}/permanently`, { method: 'DELETE' }); } catch { failed++; } }
    toast(failed ? `${list.length - failed} deleted, ${failed} failed` : one ? 'Token deleted' : `${list.length} tokens deleted`, failed ? 'err' : undefined);
    refresh();
  };
  return (
    <>
      <div className="section-head">
        <div>
          <h2>Enrollment tokens</h2>
          <p className="muted">A token lets servers enroll. Use one per group (environment, team) and limit how many servers and how long. Linux agents swap the token for their own credential, so revoking a token only stops new enrollments.</p>
        </div>
        <button className="btn btn-primary" onClick={() => open((close) => <NewTokenDialog onClose={close} />)}><Plus size={15} />New token</button>
      </div>
      {old.length > 0 && (
        <div className="toolbar">
          <label className="dim" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}><input type="checkbox" checked={showOld} onChange={(e) => setShowOld(e.target.checked)} />Show revoked and expired ({old.length})</label>
          {purge > 0 && <span className="dim" style={{ fontSize: 12 }}>Revoked and expired tokens are deleted automatically after {purge} min.</span>}
          <div className="grow" />
          <button className="btn btn-sm" onClick={() => remove(old)}><Trash2 size={14} />Delete revoked and expired ({old.length})</button>
        </div>
      )}
      {q.isPending ? <TableWrap label="Tokens"><StateView kind="loading" skeleton="table" /></TableWrap>
        : q.isError ? <TableWrap label="Tokens"><ErrorState error={q.error} what="Tokens" /></TableWrap>
          : !tokens.length ? <TableWrap label="Tokens"><StateView kind="empty" title={all.length ? 'No active tokens' : 'No tokens yet'} text={all.length ? 'Create a token when you install an agent. Revoked and expired tokens are hidden.' : 'Create a token, then use it when you install an agent.'} /></TableWrap> : (
            <TableWrap label="Tokens">
              <table className="tbl">
                <thead><tr>{['Name', 'Token', 'Used', 'Agents', 'Created', 'Last used', 'Expires', 'Status', ''].map((x, i) => <th key={x || i}>{x}</th>)}</tr></thead>
                <tbody>
                  {tokens.map((t) => (
                    <tr key={t.id}>
                      <td><b style={{ fontWeight: 600 }}>{t.name}</b></td>
                      <td className="mono dim">oat_{t.prefix}_…</td>
                      <td>{t.maxUses ? `${t.uses} of ${t.maxUses}` : `${t.uses} (no limit)`}</td>
                      <td>{t.agents}</td>
                      <td className="dim">{ago(t.createdAt)} by {t.createdBy || '?'}</td>
                      <td className="dim">{t.lastUsed ? ago(t.lastUsed) : 'never'}</td>
                      <td className="dim">{t.expiresAt ? dateTime(Date.parse(t.expiresAt)).slice(0, 16) : 'never'}</td>
                      <td>{t.revoked ? <Pill>Revoked</Pill> : t.expired ? <Pill tone="orange">Expired</Pill> : t.usedUp ? <Pill>Used up</Pill> : <Pill tone="green">Active</Pill>}</td>
                      <td className="num">{dead(t) ? <button className="btn btn-sm" onClick={() => remove([t])}>Delete</button>
                        : <button className="btn btn-sm btn-danger" onClick={async () => {
                          if (!(await confirm(`Revoke "${t.name}"?`, `New enrollments with this token are refused at once. Enrolled Linux agents keep their own credentials; previous-generation agents using this token stop sending within a minute.${purge > 0 ? ` A revoked token is hidden and deleted after ${purge} min.` : ''}`, 'Revoke'))) return;
                          try { await api(`/agent-tokens/${t.id}`, { method: 'DELETE' }); toast('Token revoked'); refresh(); } catch (e) { toast((e as Error).message, 'err'); }
                        }}>Revoke</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
    </>
  );
}
