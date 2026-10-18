// Agents, organised per platform (like Datadog): an overview of the whole fleet, then one section each for
// Linux, Windows, Docker and Kubernetes with that platform's agents and its own install steps. Plus tokens.
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Copy, Trash2, ShieldCheck, Terminal, Monitor, Container, Boxes, Server, ChevronDown } from 'lucide-react';
import { api } from '@/lib/api';
import { fmt, ago } from '@/lib/format';
import { toneClass } from '@/lib/theme';
import { useApp, usePlainQuery } from '@/app/AppContext';
import { ErrorState, Field, InfoBox, Modal, PageHead, Pill, Select, StateView, TableWrap, Time, copyText, toast, useDialogs } from '@/components/ui';
import { StatCard } from '@/components/StatCard';

type Platform = 'linux' | 'windows' | 'docker' | 'kubernetes';
interface Agent { id: string; host: string; platform: Platform; os: string; arch: string; version: string; env: string; role: string; cluster: string; ip: string; token: string | null; lastSeen: string; status: 'online' | 'offline' | 'blocked'; outdated: boolean; cpu: number | null; mem: number | null; diskFree: number | null; sendFailures: number; queue: number }
interface AgentsData { agents: Agent[]; summary: { total: number; online: number; offline: number; blocked: number; outdated: number; byPlatform: Record<Platform, number> }; latest: string }
interface InstallInfo { server: string; cert: { available: boolean; selfSigned?: boolean; sha256?: string; spkiPin?: string; issuer?: string }; versions: Record<string, string> }
interface Token { id: number; name: string; prefix: string; createdBy: string; createdAt: string; lastUsed: string | null; expiresAt: string | null; revoked: boolean; expired: boolean; agents: number }

const PLATFORMS: Record<Platform, { label: string; hint: string; Icon: typeof Server; what: string }> = {
  linux: { label: 'Linux', hint: 'Ubuntu, RHEL, Debian, SUSE, Amazon Linux (systemd)', Icon: Terminal, what: 'Host metrics (node_exporter), system logs or the journal, extra log files, and OpenTelemetry traces from apps on the server.' },
  windows: { label: 'Windows', hint: 'Windows Server 2016 and newer', Icon: Monitor, what: 'Host metrics (windows_exporter), Application and System event logs, extra log files, and OpenTelemetry traces.' },
  docker: { label: 'Docker', hint: 'Host + every container (cAdvisor) + container logs', Icon: Container, what: 'The Docker host, every container\'s CPU, memory and network (cAdvisor), and container logs.' },
  kubernetes: { label: 'Kubernetes', hint: 'Every node, pods, events, kube-state-metrics (also OpenShift)', Icon: Boxes, what: 'One agent per node (DaemonSet), a cluster agent for events, and kube-state-metrics for pods, deployments and nodes.' },
};
const PLATFORM_KEYS = Object.keys(PLATFORMS) as Platform[];
type TabKey = 'overview' | Platform | 'tokens';

export default function Agents() {
  const { can } = useApp();
  const canManage = can('integrations.manage');
  const [params, setParams] = useSearchParams();
  // old links: ?tab=fleet -> overview, ?tab=install&platform=x -> that platform with the installer open
  const initialTab = (() => {
    const t = params.get('tab');
    if (t === 'install') return (params.get('platform') as Platform) || 'linux';
    if (t && (t === 'tokens' || t in PLATFORMS)) return t as TabKey;
    return 'overview';
  })();
  const [tab, setTabState] = useState<TabKey>(initialTab);
  const [installOpen, setInstallOpen] = useState(params.get('tab') === 'install');
  const setTab = (k: TabKey, install = false) => {
    setTabState(k); setInstallOpen(install);
    const n = new URLSearchParams(params); n.set('tab', k); n.delete('platform'); setParams(n, { replace: true });
  };

  const q = usePlainQuery(['agents'], () => api<AgentsData>('/agents'));
  const info = useQuery({ queryKey: ['agents-install-info'], queryFn: () => api<InstallInfo>('/agents/install-info'), staleTime: 300_000 });
  const d = q.data;

  const head = <PageHead title="Agents" sub="One agent per server sends metrics, logs and traces to ObservaOne"
    actions={canManage ? <button className="btn btn-primary" onClick={() => setTab(tab in PLATFORMS ? tab : 'linux', true)}><Plus size={15} />Install agent</button> : undefined} />;
  if (q.isPending) return <>{head}<TableWrap label="Agents"><StateView kind="loading" skeleton="table" /></TableWrap></>;
  if (q.isError) return <>{head}<TableWrap label="Agents"><ErrorState error={q.error} what="Agents" /></TableWrap></>;
  const s = d!.summary;
  const failing = d!.agents.filter((a) => a.sendFailures > 0).length;
  const attention = s.blocked + s.outdated + failing;

  return (
    <>
      {head}
      <div className="grid cards-4" style={{ marginBottom: 16 }}>
        <StatCard label="Agents" value={s.total} extra={<div className="dim tile-sub">{PLATFORM_KEYS.filter((p) => s.byPlatform[p]).map((p) => `${s.byPlatform[p]} ${PLATFORMS[p].label}`).join(' · ') || 'none yet'}</div>} />
        <StatCard label="Online" value={s.online} tone={s.online ? 'green' : ''} extra={<div className="dim tile-sub">sent data in the last 2½ minutes</div>} />
        <StatCard label="Offline" value={s.offline} tone={s.offline ? 'red' : ''} extra={<div className="dim tile-sub">{s.offline ? 'not heard from - check these servers' : 'all agents reporting'}</div>} />
        <StatCard label="Need attention" value={attention} tone={attention ? 'orange' : ''} extra={<div className="dim tile-sub">{s.outdated} outdated · {s.blocked} blocked · {failing} with upload errors</div>} />
      </div>

      <div className="platform-tabs" role="tablist" aria-label="Platform">
        <button role="tab" aria-selected={tab === 'overview'} className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}><Server size={15} />All platforms<span className="count-badge">{s.total}</span></button>
        {PLATFORM_KEYS.map((p) => {
          const { label, Icon } = PLATFORMS[p];
          return <button key={p} role="tab" aria-selected={tab === p} className={tab === p ? 'active' : ''} onClick={() => setTab(p)}><Icon size={15} />{label}<span className="count-badge">{s.byPlatform[p] || 0}</span></button>;
        })}
        {canManage && <button role="tab" aria-selected={tab === 'tokens'} className={`push-right ${tab === 'tokens' ? 'active' : ''}`} onClick={() => setTab('tokens')}>Tokens</button>}
      </div>

      {tab === 'overview' && (
        <>
          <div className="platform-cards">
            {PLATFORM_KEYS.map((p) => {
              const list = d!.agents.filter((a) => a.platform === p);
              const on = list.filter((a) => a.status === 'online').length, off = list.filter((a) => a.status === 'offline').length;
              const { label, Icon, hint } = PLATFORMS[p];
              return (
                <button key={p} className="platform-card" onClick={() => setTab(p, !list.length && canManage)}>
                  <div className="pc-head"><span className="pc-icon"><Icon size={18} /></span><b>{label}</b><span className="dim pc-count">{list.length}</span></div>
                  {list.length ? (
                    <div className="pc-status"><span className="c-green">{on} online</span>{off > 0 && <span className="c-red">{off} offline</span>}</div>
                  ) : <div className="dim pc-status">{canManage ? 'Not installed yet - set it up →' : 'No agents yet'}</div>}
                  <div className="dim pc-hint">{hint}</div>
                </button>
              );
            })}
          </div>
          <Fleet agents={d!.agents} latest={d!.latest} canManage={canManage} showPlatform onInstall={() => setTab('linux', true)} />
        </>
      )}

      {tab in PLATFORMS && (
        <PlatformSection p={tab as Platform} agents={d!.agents.filter((a) => a.platform === tab)} latest={d!.latest} canManage={canManage}
          info={info.data} infoError={info.error} installOpen={installOpen} setInstallOpen={setInstallOpen} />
      )}
      {tab === 'tokens' && canManage && <Tokens />}
    </>
  );
}

function PlatformSection({ p, agents, latest, canManage, info, infoError, installOpen, setInstallOpen }: {
  p: Platform; agents: Agent[]; latest: string; canManage: boolean; info?: InstallInfo; infoError: unknown; installOpen: boolean; setInstallOpen: (v: boolean) => void;
}) {
  const { label, Icon, what } = PLATFORMS[p];
  const showInstall = installOpen || (!agents.length && canManage);
  return (
    <div className="platform-section">
      <div className="platform-intro">
        <span className="pc-icon lg"><Icon size={22} /></span>
        <div>
          <h2>{label} agents</h2>
          <p className="muted">{what}</p>
        </div>
        {canManage && agents.length > 0 && (
          <button className="btn" style={{ marginLeft: 'auto' }} aria-expanded={showInstall} onClick={() => setInstallOpen(!installOpen)}>
            <Plus size={14} />Install on {label}<ChevronDown size={14} className={`chev ${showInstall ? 'open-down' : ''}`} />
          </button>
        )}
      </div>
      {showInstall && (info ? <InstallWizard platform={p} info={info} canManage={canManage} /> : infoError ? <ErrorState error={infoError} what="Install information" /> : <StateView kind="loading" />)}
      {agents.length > 0
        ? <Fleet agents={agents} latest={latest} canManage={canManage} platform={p} />
        : !canManage && <TableWrap label={`${label} agents`}><StateView kind="empty" title={`No ${label} agents yet`} text="An administrator can install agents from this page." /></TableWrap>}
    </div>
  );
}

function Fleet({ agents, latest, canManage, showPlatform, platform, onInstall }: { agents: Agent[]; latest: string; canManage: boolean; showPlatform?: boolean; platform?: Platform; onInstall?: () => void }) {
  const { confirm } = useDialogs();
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState('');
  const act = async (path: string, method: string, msg: string) => {
    try { await api(path, { method }); toast(msg); qc.invalidateQueries({ queryKey: ['agents'] }); } catch (e) { toast((e as Error).message, 'err'); }
  };
  const list = useMemo(() => {
    const f = filter.toLowerCase();
    return agents.filter((a) => (!status || a.status === status) && (!f || [a.host, a.os, a.env, a.role, a.ip, a.cluster, a.token].join(' ').toLowerCase().includes(f)));
  }, [agents, filter, status]);
  if (!agents.length) {
    return <TableWrap label="Agents"><StateView kind="empty" title="No agents enrolled" text={canManage ? 'Install the agent on a server and it shows up here within a minute.' : 'No agent has reported yet. An administrator can install agents from this page.'}
      action={canManage && onInstall ? <button className="btn btn-primary" onClick={onInstall}>Install your first agent</button> : undefined} /></TableWrap>;
  }
  const k8s = platform === 'kubernetes';
  return (
    <>
      <div className="toolbar" style={{ marginTop: 4 }}>
        <input className="input" placeholder="Filter by host, OS, env, role, IP..." aria-label="Filter agents" style={{ width: 280 }} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Select className="select" label="Status" style={{ width: 150 }} value={status} onChange={setStatus} options={[['', 'Any status'], ['online', 'Online'], ['offline', 'Offline'], ['blocked', 'Blocked']]} />
        <div className="grow" />
        <span className="dim" style={{ fontSize: 12 }}>Latest agent version: {latest}</span>
      </div>
      <TableWrap label="Agents">
        <table className="tbl">
          <thead><tr>
            <th>Host</th>{showPlatform && <th>Platform</th>}{k8s && <th>Cluster</th>}<th>Env / role</th><th>Version</th><th>Status</th>
            <th className="num">CPU</th><th className="num">Memory</th><th className="num">Disk free</th><th>Uploads</th><th>Last seen</th><th />
          </tr></thead>
          <tbody>
            {list.length ? list.map((a) => (
              <tr key={a.id}>
                <td><b style={{ fontWeight: 600 }}>{a.host}</b><div className="dim" style={{ fontSize: 11 }}>{[a.ip, !k8s && a.cluster && `cluster ${a.cluster}`].filter(Boolean).join(' · ') || a.id}</div></td>
                {showPlatform && <td>{PLATFORMS[a.platform]?.label || a.platform}<div className="dim" style={{ fontSize: 11 }}>{[a.os, a.arch].filter(Boolean).join(' · ')}</div></td>}
                {k8s && <td>{a.cluster || '-'}</td>}
                <td>{[a.env, a.role].filter(Boolean).join(' / ') || <span className="dim">-</span>}</td>
                <td>{a.version ? (a.outdated ? <Pill tone="orange" title={`Latest is ${latest}. Run the install command again to update.`}>{a.version} ↑</Pill> : a.version) : '-'}</td>
                <td><Pill tone={a.status === 'online' ? 'solid-green' : a.status === 'offline' ? 'solid-red' : 'muted'}>{a.status === 'online' ? 'Online' : a.status === 'offline' ? 'Offline' : 'Blocked'}</Pill></td>
                <td className={`num ${toneClass(a.cpu)}`}>{a.cpu === null ? '-' : fmt(a.cpu, 'percent')}</td>
                <td className={`num ${toneClass(a.mem)}`}>{a.mem === null ? '-' : fmt(a.mem, 'percent')}</td>
                <td className={`num ${toneClass(a.diskFree, false)}`}>{a.diskFree === null ? '-' : fmt(a.diskFree, 'percent')}</td>
                <td>{a.sendFailures > 0 ? <span className="c-red" title="Items that failed to upload in the last 15 minutes">{fmt(a.sendFailures, 'short')} failed</span>
                  : a.queue > 0 ? <span className="c-orange" title="Items waiting to be sent">{fmt(a.queue, 'short')} queued</span> : <span className="c-green">OK</span>}</td>
                <td className="dim"><Time ms={Date.parse(a.lastSeen)} text={ago(a.lastSeen)} /></td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>
                  {canManage && (a.status === 'blocked'
                    ? <button className="btn btn-sm" onClick={() => act(`/agents/${encodeURIComponent(a.id)}/unblock`, 'POST', `${a.host} can send data again`)}>Allow</button>
                    : <button className="btn btn-sm" title="Refuse all data from this agent" onClick={async () => {
                      if (await confirm(`Block ${a.host}?`, 'The agent keeps running but ObservaOne refuses everything it sends until you allow it again.', 'Block')) act(`/agents/${encodeURIComponent(a.id)}/block`, 'POST', `${a.host} blocked`);
                    }}>Block</button>)}
                  {canManage && a.status !== 'online' && <button className="icon-btn" title="Forget this agent (after you uninstalled it)" aria-label={`Forget ${a.host}`} style={{ marginLeft: 4 }} onClick={async () => {
                    if (await confirm(`Forget ${a.host}?`, 'Removes it from this list. If the agent is still installed and its token is valid, it comes back the next time it sends data.', 'Forget')) act(`/agents/${encodeURIComponent(a.id)}`, 'DELETE', `${a.host} removed`);
                  }}><Trash2 size={15} /></button>}
                </td>
              </tr>
            )) : <tr><td colSpan={12} className="dim">No agent matches the filter.</td></tr>}
          </tbody>
        </table>
      </TableWrap>
    </>
  );
}

// ------------------------------------------------------------ install wizard (one platform)
function commandFor(p: Platform, info: InstallInfo, w: { token: string; env: string; role: string; logs: string; cluster: string; securityLog: boolean }) {
  const S = info.server;
  const c = info.cert || { available: false };
  const pin = c.available && c.selfSigned;
  const t = w.token || '<TOKEN>';
  const shq = (v: string) => `'${String(v).replace(/'/g, "'\\''")}'`;
  const curlGet = pin ? `curl -fsSLk --pinnedpubkey "${c.spkiPin}"` : 'curl -fsSL';
  const opts: string[] = [];
  if (pin) opts.push(`--ca-sha256 ${c.sha256}`);
  if (w.env) opts.push(`--env ${shq(w.env)}`);
  if (w.role) opts.push(`--role ${shq(w.role)}`);
  if (w.logs.trim()) opts.push(`--logs ${shq(w.logs.trim())}`);
  if (p === 'linux' || p === 'docker') {
    if (p === 'docker') opts.unshift('--docker');
    return { where: 'Run on the server as root (or with sudo):', text: `${curlGet} ${S}/agent/install.sh | sudo bash -s -- \\\n  --server ${S} \\\n  --token ${t}${opts.length ? ` \\\n  ${opts.join(' \\\n  ')}` : ''}` };
  }
  if (p === 'windows') {
    const ps = (v: string) => `'${String(v).replace(/'/g, "''")}'`;
    const args = [`-Server ${S}`, `-Token ${t}`];
    if (pin) args.push(`-CaSha256 ${c.sha256}`);
    if (w.env) args.push(`-Env ${ps(w.env)}`);
    if (w.role) args.push(`-Role ${ps(w.role)}`);
    if (w.logs.trim()) args.push(`-Logs ${ps(w.logs.trim())}`);
    if (w.securityLog) args.push('-SecurityLog');
    const lines = ["[Net.ServicePointManager]::SecurityProtocol = 'Tls12'"];
    if (pin) {
      lines.push(`$fp = '${c.sha256}'`);
      lines.push("[Net.ServicePointManager]::ServerCertificateValidationCallback = { param($s, $c) ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($c.GetRawCertData())) -replace '-', '').ToLower() -eq $fp }");
    }
    lines.push(`& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing ${S}/agent/install.ps1).Content)) ${args.join(' ')}`);
    return { where: 'Paste into Windows PowerShell opened with "Run as administrator":', text: lines.join('\n') };
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
  return { where: 'Run where kubectl points at the cluster (cluster-admin). OpenShift: use oc, and see the note below.', text: lines.join('\n') };
}

const NOTES: Record<Platform, string[]> = {
  linux: ['Installs node_exporter (127.0.0.1:9101) and the agent as systemd services under /opt/observaone-agent, running as the user observaone-agent.',
    'Uses no inbound ports. Only outbound HTTPS to this server.',
    'Apps on the server can send OpenTelemetry traces to 127.0.0.1:4317 (gRPC) or :4318 (HTTP).',
    'Already scraping this server from Prometheus (targets file)? Remove it there to avoid counting it twice.'],
  windows: ['Installs windows_exporter (127.0.0.1:9182, no firewall opening) and the ObservaOne Agent Windows service. An existing windows_exporter is reused.',
    'Uses no inbound ports. Only outbound HTTPS to this server.',
    'Apps can send OpenTelemetry traces to 127.0.0.1:4317 (gRPC) or :4318 (HTTP).',
    'Already scraping this server from Prometheus (targets file)? Remove it there to avoid counting it twice.'],
  docker: ['Runs 3 containers (agent, node-exporter, cAdvisor) with Docker Compose in /opt/observaone-agent.',
    'Same machine as ObservaOne (lab, Docker Desktop, WSL)? Skip this command: put the token in .env as AGENT_TOKEN and run  docker compose --profile agent up -d  in the monitoring-stack folder.',
    'Container logs are named after the container ID. Set the Docker log option tag to {{.Name}} to use container names instead.',
    'Images come from Docker Hub and ghcr.io. Without internet, copy them to your own registry first.'],
  kubernetes: ['Creates the observaone namespace: a DaemonSet (one agent per node), a cluster agent for events, and kube-state-metrics.',
    'Pods send traces to the node IP: set an env var NODE_IP from status.hostIP and OTEL_EXPORTER_OTLP_ENDPOINT=http://$(NODE_IP):4318.',
    'OpenShift: also run  oc adm policy add-scc-to-user privileged -z observaone-agent -n observaone',
    'Images come from Docker Hub, quay.io and registry.k8s.io. Without internet, mirror them and edit the image names.'],
};

function InstallWizard({ platform: p, info, canManage }: { platform: Platform; info: InstallInfo; canManage: boolean }) {
  const { open } = useDialogs();
  const [w, setW] = useState({ token: '', env: '', role: '', logs: '', cluster: '', securityLog: false });
  useEffect(() => { setW((x) => ({ ...x, logs: '', role: '' })); }, [p]);
  const set = (k: keyof typeof w) => (e: React.ChangeEvent<HTMLInputElement>) => setW({ ...w, [k]: k === 'securityLog' ? e.target.checked : e.target.value });
  const cmd = commandFor(p, info, w);
  const c = info.cert || { available: false };
  return (
    <div className="agent-wizard">
      <div className="grid cols-2">
        <section className="panel">
          <div className="panel-head"><h3><span className="step-n">1</span>Agent token</h3></div>
          <p className="muted" style={{ marginTop: 0 }}>One token can be used on many servers. Revoke it to cut them all off at once.</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input mono" placeholder="oat_..." aria-label="Agent token" value={w.token} onChange={(e) => setW({ ...w, token: e.target.value.trim() })} style={{ flex: 1 }} />
            {canManage && <button className="btn" style={{ whiteSpace: 'nowrap' }} onClick={() => open((close) => <NewTokenDialog onClose={close} onUse={(tok) => setW((x) => ({ ...x, token: tok }))} />)}><Plus size={14} />New token</button>}
          </div>
          <div style={{ marginTop: 12 }}>
            {!c.available ? <div className="dim">Agents trust the server certificate through the normal system certificate store.</div>
              : c.selfSigned ? <InfoBox tone="ok"><ShieldCheck size={14} style={{ verticalAlign: -2 }} /> Your server uses a self-signed certificate. The command pins its fingerprint, so agents only ever talk to this server: <code>{c.sha256?.slice(0, 16)}…</code></InfoBox>
                : <div className="dim">Certificate issued by {c.issuer}. Agents trust it through the system certificate store (install your company CA on the servers if needed).</div>}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><h3><span className="step-n">2</span>Options</h3></div>
          <Field label="Environment (optional)"><input className="input" placeholder="prod, uat, dev" value={w.env} onChange={set('env')} /></Field>
          {p !== 'kubernetes' ? (
            <>
              <Field label="Extra log files (optional)" hint={p === 'windows' ? 'Application and System event logs are always sent.' : 'System logs (syslog/messages/auth or the journal) are always sent.'}>
                <input className="input" placeholder={p === 'windows' ? 'C:\\inetpub\\logs\\LogFiles\\*\\*.log' : '/var/log/nginx/*.log, /opt/app/logs/*.log'} value={w.logs} onChange={set('logs')} />
              </Field>
              <Field label="Role (optional)"><input className="input" placeholder={p === 'windows' ? 'sql, iis, app' : 'web, database, app'} value={w.role} onChange={set('role')} /></Field>
            </>
          ) : (
            <Field label="Cluster name" hint="Shown on the Agents page and added to every metric as cluster=..."><input className="input" placeholder="prod-cluster" value={w.cluster} onChange={set('cluster')} /></Field>
          )}
          {p === 'windows' && <label className="check-row"><input type="checkbox" checked={w.securityLog} onChange={set('securityLog')} /><span>Also send the Security event log (sign-ins, account changes - large)</span></label>}
        </section>
      </div>
      <section className="panel">
        <div className="panel-head"><h3><span className="step-n">3</span>Run this command</h3><button className="btn btn-sm right" onClick={() => copyText(cmd.text, 'Command copied')}><Copy size={13} />Copy</button></div>
        <div className="muted" style={{ marginBottom: 8 }}>{cmd.where}</div>
        <pre className="code cmd">{cmd.text}</pre>
        {!w.token && <div className="c-orange" style={{ marginTop: 8, fontSize: 12.5 }}>Add a token in step 1 - the command still shows &lt;TOKEN&gt;.</div>}
        <ul className="agent-notes">{NOTES[p].map((n) => <li key={n}>{n}</li>)}</ul>
        <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>
          Bundles OpenTelemetry Collector {info.versions.otelcol}, node_exporter {info.versions.nodeExporter}, windows_exporter {info.versions.windowsExporter}, cAdvisor {info.versions.cadvisor}, kube-state-metrics {info.versions.kubeStateMetrics}. Every download is checked against a fixed SHA-256.
          {' '}Remove: run the same install command with <code>{p === 'windows' ? '-Uninstall' : p === 'kubernetes' ? 'kubectl delete -f kubernetes.yaml' : '--uninstall'}</code>.
        </div>
        <div className="info-box" style={{ marginTop: 12, marginBottom: 0 }}><span>After it runs, the server appears in the list below within about a minute (this page refreshes by itself).</span></div>
      </section>
    </div>
  );
}

function NewTokenDialog({ onClose, onUse }: { onClose: () => void; onUse?: (t: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [days, setDays] = useState(0);
  const [token, setToken] = useState<string | null>(null);
  if (token) {
    return (
      <Modal title="Copy the token now" onClose={onClose} actions={[onUse ? { label: 'Use in the install command', primary: true, onClick: () => { onUse(token); } } : { label: 'Done', primary: true }]}>
        <p style={{ marginTop: 0 }}>This is the only time the token is shown. It goes into the install command; the agent stores it on the server.</p>
        <pre className="code" style={{ wordBreak: 'break-all' }}>{token}</pre>
        <button className="btn" onClick={() => copyText(token)}><Copy size={13} />Copy</button>
      </Modal>
    );
  }
  return (
    <Modal title="New agent token" onClose={onClose} actions={[
      { label: 'Cancel' },
      { label: 'Create', primary: true, onClick: async () => {
        const r = await api<{ token: string }>('/agent-tokens', { method: 'POST', body: { name, expiresDays: days } });
        setToken(r.token);
        qc.invalidateQueries({ queryKey: ['agent-tokens'] });
        return false; // keep the dialog open to show the token
      } },
    ]}>
      <Field label="Name" hint="Where will you use it? Shown on the Agents page next to each agent."><input className="input" maxLength={60} placeholder="e.g. Production Linux servers" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Expires" hint="Agents using an expired token stop sending. Existing installs keep the token they have."><Select options={[[0, 'Never'], [30, '30 days'], [90, '90 days'], [365, '1 year']]} value={days} onChange={setDays} /></Field>
    </Modal>
  );
}

function Tokens() {
  const { open, confirm } = useDialogs();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['agent-tokens'], queryFn: () => api<{ tokens: Token[] }>('/agent-tokens') });
  return (
    <>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <p className="muted" style={{ margin: 0 }}>Tokens let agents send data. Use one per group of servers (e.g. per environment) so you can revoke a group at once.</p>
        <div className="grow" />
        <button className="btn btn-primary" onClick={() => open((close) => <NewTokenDialog onClose={close} />)}><Plus size={15} />New token</button>
      </div>
      {q.isPending ? <TableWrap label="Tokens"><StateView kind="loading" skeleton="table" /></TableWrap>
        : q.isError ? <TableWrap label="Tokens"><ErrorState error={q.error} what="Agent tokens" /></TableWrap>
          : !q.data.tokens.length ? <TableWrap label="Tokens"><StateView kind="empty" title="No tokens yet" text="Create a token, then use it in the install command." /></TableWrap> : (
            <TableWrap label="Tokens">
              <table className="tbl">
                <thead><tr>{['Name', 'Token', 'Agents', 'Created', 'Last used', 'Expires', 'Status', ''].map((x, i) => <th key={x || i}>{x}</th>)}</tr></thead>
                <tbody>
                  {q.data.tokens.map((t) => (
                    <tr key={t.id} style={{ opacity: t.revoked ? 0.55 : 1 }}>
                      <td><b style={{ fontWeight: 600 }}>{t.name}</b></td>
                      <td className="mono dim">oat_{t.prefix}_…</td>
                      <td>{t.agents}</td>
                      <td className="dim">{ago(t.createdAt)} by {t.createdBy || '?'}</td>
                      <td className="dim">{t.lastUsed ? ago(t.lastUsed) : 'never'}</td>
                      <td className="dim">{t.expiresAt ? new Date(t.expiresAt).toLocaleDateString() : 'never'}</td>
                      <td>{t.revoked ? <Pill>Revoked</Pill> : t.expired ? <Pill tone="orange">Expired</Pill> : <Pill tone="green">Active</Pill>}</td>
                      <td className="num">{!t.revoked && <button className="btn btn-sm btn-danger" onClick={async () => {
                        if (!(await confirm(`Revoke "${t.name}"?`, `${t.agents} agent(s) use this token. They stop sending data within a minute. This cannot be undone - you would install them again with a new token.`, 'Revoke'))) return;
                        try { await api(`/agent-tokens/${t.id}`, { method: 'DELETE' }); toast('Token revoked'); qc.invalidateQueries({ queryKey: ['agent-tokens'] }); qc.invalidateQueries({ queryKey: ['agents'] }); } catch (e) { toast((e as Error).message, 'err'); }
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
