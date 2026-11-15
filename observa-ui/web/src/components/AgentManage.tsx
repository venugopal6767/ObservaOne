// Agent management (Phase 4): settings layers (environment -> target -> agent), actions (diagnostics, restart,
// upgrade) and diagnostics bundles. Only the settings the server may change are offered; host files always win,
// and anything locked by the host is shown as such. There is no command field anywhere.
import { Fragment, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileSearch, RotateCcw, ArrowUpCircle, Settings2, Eye, KeyRound } from 'lucide-react';
import { api } from '@/lib/api';
import { ago, dateTime } from '@/lib/format';
import { ErrorState, Field, InfoBox, Modal, Pill, StateView, Time, toast, useDialogs, type Tone } from '@/components/ui';

export interface SettingSchema { type: 'duration' | 'int' | 'bool' | 'list'; label: string; hint?: string; min?: number; max?: number; of?: string[] }
export type Settings = Record<string, string | number | boolean | string[]>;
interface Layer { scope: 'env' | 'target' | 'agent'; scopeId: string; settings: Settings; version: number; updatedBy: string; updatedAt: string }
interface ActionRow { id: number; action: string; state: string; requestedBy: string; requestedAt: string; doneAt: string | null; result: { ok: boolean; message: string; version?: string; diagnosticsId?: number } | null }
export interface Manage {
  agentId: string; enrolled: boolean; supportsActions: boolean; latest: string;
  credential: { issuedAt: string | null; rotateRequested: boolean; previousValidUntil: string | null };
  config: { effective: Settings; from: Record<string, string>; version: number; applied: number; error: string; state: 'none' | 'applied' | 'pending' | 'refused'; layers: Layer[]; hostLocked: string[] };
  schema: Record<string, SettingSchema>;
  actions: ActionRow[];
  diagnostics: { id: number; actionId: number | null; createdAt: string; size: number }[];
  pastNames: { kind: string; value: string; until: string }[];
  target: { id: string; name: string } | null;
}

const SCOPE_LABEL: Record<string, string> = { env: 'environment', target: 'target', agent: 'this agent' };
const CONFIG_STATE: Record<string, [string, Tone, string]> = {
  none: ['Host files only', 'muted', 'No settings from ObservaOne: the agent uses its own files.'],
  applied: ['Applied', 'green', 'The agent confirmed the latest settings.'],
  pending: ['Pending', 'orange', 'Sent with the next heartbeat; shown as applied once the agent confirms.'],
  refused: ['Refused by the agent', 'red', 'The agent kept its previous settings.'],
};
const ACTION_STATE: Record<string, Tone> = { pending: 'muted', sent: 'blue', done: 'green', failed: 'red', expired: 'muted' };
const ACTION_LABEL: Record<string, string> = { diagnostics: 'Diagnostics', restart: 'Restart', upgrade: 'Upgrade' };

export const showValue = (v: unknown) => (Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v));

// ------------------------------------------------------------ settings editor (one layer)
export function SettingsEditor({ schema, value, inherited, locked = [], onSave, onClose, title, note }: {
  schema: Record<string, SettingSchema>; value: Settings; inherited?: Record<string, { value: unknown; from: string }>; locked?: string[];
  onSave: (s: Settings) => Promise<void>; onClose: () => void; title: string; note?: React.ReactNode;
}) {
  const [draft, setDraft] = useState<Record<string, string | boolean | string[] | ''>>(() => {
    const d: Record<string, string | boolean | string[] | ''> = {};
    for (const k of Object.keys(schema)) {
      const v = value[k];
      d[k] = v === undefined ? (schema[k].type === 'list' ? [] : schema[k].type === 'bool' ? '' : '') : Array.isArray(v) ? v : typeof v === 'boolean' ? v : String(v);
    }
    return d;
  });
  const [set, setSet] = useState<Record<string, boolean>>(() => Object.fromEntries(Object.keys(schema).map((k) => [k, value[k] !== undefined])));
  const save = async () => {
    const out: Settings = {};
    for (const [k, s] of Object.entries(schema)) {
      if (!set[k]) continue;
      const v = draft[k];
      if (s.type === 'int') out[k] = Number(v);
      else if (s.type === 'bool') out[k] = v === true;
      else if (s.type === 'list') out[k] = v as string[];
      else out[k] = String(v);
    }
    await onSave(out);
  };
  return (
    <Modal title={title} onClose={onClose} wide actions={[{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: save }]}>
      {note && <div className="muted" style={{ marginBottom: 12 }}>{note}</div>}
      <div className="settings-grid">
        {Object.entries(schema).map(([k, s]) => {
          const inh = inherited?.[k];
          const isLocked = locked.includes(k);
          return (
            <div key={k} className={`setting-row ${set[k] ? 'is-set' : ''}`}>
              <label className="check-row" style={{ margin: 0 }}>
                <input type="checkbox" checked={!!set[k]} onChange={(e) => setSet({ ...set, [k]: e.target.checked })} aria-label={`Set ${s.label}`} />
                <span><b>{s.label}</b> <code className="dim">{k}</code></span>
              </label>
              <div className="setting-input">
                {!set[k] ? <span className="dim">{inh ? `inherits ${showValue(inh.value)} from ${SCOPE_LABEL[inh.from] || inh.from}` : 'agent default or host files'}</span>
                  : s.type === 'bool' ? (
                    <label className="check-row" style={{ margin: 0 }}><input type="checkbox" checked={draft[k] === true} onChange={(e) => setDraft({ ...draft, [k]: e.target.checked })} /><span>{draft[k] === true ? 'on' : 'off'}</span></label>
                  ) : s.type === 'list' ? (
                    <div className="chip-picks" role="group" aria-label={s.label}>
                      {(s.of || []).map((c) => {
                        const on = (draft[k] as string[]).includes(c);
                        return <button key={c} type="button" className={`chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => setDraft({ ...draft, [k]: on ? (draft[k] as string[]).filter((x) => x !== c) : [...(draft[k] as string[]), c] })}>{c}</button>;
                      })}
                    </div>
                  ) : (
                    <input className="input" style={{ maxWidth: 180 }} value={String(draft[k] ?? '')} placeholder={s.type === 'duration' ? '30s' : String(s.min ?? '')} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} aria-label={s.label} />
                  )}
                {s.hint && set[k] && s.type !== 'list' && <span className="dim" style={{ fontSize: 12, marginLeft: 8 }}>{s.hint}</span>}
                {isLocked && <div className="c-orange" style={{ fontSize: 12, marginTop: 4 }}>Set in a file on the host: the host value wins over this one.</div>}
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ the management panel in the agent detail
export function AgentManagePanel({ id, host, canManage }: { id: string; host: string; canManage: boolean }) {
  const qc = useQueryClient();
  const { open, confirm } = useDialogs();
  const q = useQuery({ queryKey: ['agent-manage', id], queryFn: () => api<Manage>(`/agents/${encodeURIComponent(id)}/manage`), refetchInterval: 5000 });
  const m = q.data;
  if (q.isPending) return <StateView kind="loading" skeleton="cards" />;
  if (q.isError) return <ErrorState error={q.error} what="Agent management" />;
  if (!m || !m.enrolled) return null;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['agent-manage', id] }); qc.invalidateQueries({ queryKey: ['agents'] }); };
  const act = async (action: string, title: string, text: string) => {
    if (!(await confirm(title, text, ACTION_LABEL[action], action !== 'diagnostics'))) return;
    try { await api(`/agents/${encodeURIComponent(id)}/actions`, { method: 'POST', body: { action } }); toast(`${ACTION_LABEL[action]} requested: delivered with the next heartbeat`); refresh(); }
    catch (e) { toast((e as Error).message, 'err'); }
  };
  const agentLayer = m.config.layers.find((l) => l.scope === 'agent');
  const inherited: Record<string, { value: unknown; from: string }> = {};
  for (const l of m.config.layers) if (l.scope !== 'agent') for (const [k, v] of Object.entries(l.settings)) inherited[k] = { value: v, from: l.scope };
  const configure = () => open((close) => (
    <SettingsEditor title={`Settings for ${host}`} schema={m.schema} value={agentLayer?.settings || {}} inherited={inherited} locked={m.config.hostLocked} onClose={close}
      note={<>Applies to this agent only and wins over environment and target settings. Files on the host still win over everything set here.</>}
      onSave={async (s) => {
        await api(`/agents/${encodeURIComponent(id)}/config`, { method: 'PUT', body: { settings: s } });
        toast('Saved: the agent applies it at its next heartbeat'); refresh();
      }} />
  ));
  const [label, tone, why] = CONFIG_STATE[m.config.state];
  const keys = Object.keys(m.config.effective);
  const busy = (a: string) => m.actions.some((x) => x.action === a && (x.state === 'pending' || x.state === 'sent'));
  return (
    <div className="grid cols-2" style={{ marginTop: 14 }}>
      <section className="panel">
        <div className="panel-head"><h3>Settings from ObservaOne</h3>{canManage && <button className="btn btn-sm right" onClick={configure}><Settings2 size={13} />Configure</button>}</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
          <Pill tone={tone} title={why}>{label}</Pill>
          {m.config.version > 0 && <span className="dim" style={{ fontSize: 12 }}>version {m.config.version}{m.config.applied ? ` · agent has ${m.config.applied}` : ''}</span>}
        </div>
        {m.config.state === 'refused' && <InfoBox tone="error">{m.config.error}</InfoBox>}
        {keys.length ? (
          <dl className="kv">{keys.map((k) => <Fragment key={k}><dt>{m.schema[k]?.label || k}</dt><dd>{showValue(m.config.effective[k])} <span className="dim">({SCOPE_LABEL[m.config.from[k]] || m.config.from[k]})</span>{m.config.hostLocked.includes(k) && <span className="c-orange"> · host file wins</span>}</dd></Fragment>)}</dl>
        ) : <div className="dim">Nothing set: defaults and the host's own files apply.</div>}
        {m.target && <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>Target: {m.target.name}</div>}
      </section>
      <section className="panel">
        <div className="panel-head"><h3>Actions</h3></div>
        {!m.supportsActions ? <div className="dim">Actions need agent 1.3.0 or newer. Run the installer on the host once; after that, upgrades work from here.</div> : canManage && (
          <div className="toolbar" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
            <button className="btn btn-sm" disabled={busy('diagnostics')} onClick={() => act('diagnostics', 'Request diagnostics?', 'The agent uploads a bundle: status, settings in effect, collectors, system facts, connectivity checks and recent log lines. No secrets.')}><FileSearch size={13} />Request diagnostics</button>
            <button className="btn btn-sm" disabled={busy('restart')} onClick={() => act('restart', `Restart the agent on ${host}?`, 'The agent stops and systemd starts it again within about 10 seconds. Collection pauses briefly; nothing else on the host is touched.')}><RotateCcw size={13} />Restart agent</button>
            <button className="btn btn-sm" disabled={m.credential.rotateRequested} title="The agent takes a new credential at its next heartbeat; the old one stops working 10 minutes after the new one is first used"
              onClick={async () => { if (!(await confirm(`Rotate the credential of ${host}?`, 'The agent gets a new credential at its next heartbeat. Nothing to do on the host.', 'Rotate', false))) return; try { await api(`/agents/${encodeURIComponent(id)}/rotate-credential`, { method: 'POST' }); toast('Rotation requested'); refresh(); } catch (e) { toast((e as Error).message, 'err'); } }}><KeyRound size={13} />{m.credential.rotateRequested ? 'Rotation pending' : 'Rotate credential'}</button>
            <button className="btn btn-sm" disabled={busy('upgrade')} onClick={() => act('upgrade', `Upgrade ${host} to ${m.latest}?`, 'The updater on the host downloads the new version from this server, checks it, installs it and restarts the agent. If the new version does not report within 60 seconds it rolls back automatically.')}><ArrowUpCircle size={13} />Upgrade to {m.latest}</button>
          </div>
        )}
        {m.actions.length ? (
          <table className="tbl compact">
            <thead><tr><th>Action</th><th>State</th><th>Requested</th><th>Result</th></tr></thead>
            <tbody>{m.actions.slice(0, 8).map((a) => (
              <tr key={a.id}><td>{ACTION_LABEL[a.action] || a.action}</td><td><Pill tone={ACTION_STATE[a.state] || 'muted'}>{a.state === 'sent' ? 'delivered' : a.state}</Pill></td>
                <td className="dim"><Time ms={Date.parse(a.requestedAt)} text={ago(a.requestedAt)} /> · {a.requestedBy}</td>
                <td className="dim" style={{ maxWidth: 240 }}>{a.result?.message || (a.state === 'pending' ? 'waiting for the next heartbeat' : a.state === 'sent' ? 'the agent is working on it' : '')}</td></tr>
            ))}</tbody>
          </table>
        ) : <div className="dim">No actions yet.</div>}
        {m.diagnostics.length > 0 && (
          <>
            <h4 style={{ margin: '14px 0 6px' }}>Diagnostics bundles</h4>
            <ul className="plain-list">{m.diagnostics.map((d) => (
              <li key={d.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span>{dateTime(Date.parse(d.createdAt)).slice(0, 16)}</span><span className="dim">{Math.round(d.size / 1024)} kB</span>
                {canManage && <>
                  <button className="btn btn-sm" onClick={() => open((close) => <BundleView id={id} did={d.id} onClose={close} />)}><Eye size={13} />View</button>
                  <a className="btn btn-sm" href={`/api/agents/${encodeURIComponent(id)}/diagnostics/${d.id}?download=1`} download><Download size={13} />Download</a>
                </>}
              </li>
            ))}</ul>
          </>
        )}
        {m.credential.issuedAt && <div className="dim" style={{ fontSize: 12, marginTop: 10 }}>Credential issued {ago(m.credential.issuedAt)}{m.credential.previousValidUntil ? ` · previous one valid until ${dateTime(Date.parse(m.credential.previousValidUntil)).slice(11, 16)}` : ''}</div>}
        {m.pastNames.length > 0 && <div className="dim" style={{ fontSize: 12, marginTop: 10 }}>Previously: {m.pastNames.map((p) => `${p.value} (${p.kind === 'ip' ? 'address' : 'name'})`).join(', ')}</div>}
      </section>
    </div>
  );
}

interface Bundle { host: string; createdAt: string; bundle: Record<string, unknown> & { checks?: Record<string, unknown>; logs?: string[]; settings?: { setting: string; value: string; source: string }[]; system?: Record<string, unknown>; status?: Record<string, unknown> } }
function BundleView({ id, did, onClose }: { id: string; did: number; onClose: () => void }) {
  const q = useQuery({ queryKey: ['bundle', id, did], queryFn: () => api<Bundle>(`/agents/${encodeURIComponent(id)}/diagnostics/${did}`) });
  const b = q.data?.bundle;
  return (
    <Modal title={`Diagnostics: ${q.data?.host || ''}`} onClose={onClose} wide actions={[{ label: 'Close' }]}>
      {q.isPending ? <StateView kind="loading" /> : q.isError ? <ErrorState error={q.error} what="Bundle" /> : b && (
        <>
          <div className="grid cols-2">
            <section className="panel"><div className="panel-head"><h3>Connectivity</h3></div>
              <dl className="kv">{Object.entries(b.checks || {}).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd></Fragment>)}</dl>
            </section>
            <section className="panel"><div className="panel-head"><h3>System</h3></div>
              <dl className="kv">{Object.entries(b.system || {}).filter(([, v]) => !Array.isArray(v)).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{String(v)}</dd></Fragment>)}</dl>
            </section>
          </div>
          <section className="panel" style={{ marginTop: 14 }}><div className="panel-head"><h3>Settings in effect</h3></div>
            <table className="tbl compact"><thead><tr><th>Setting</th><th>Value</th><th>From</th></tr></thead>
              <tbody>{(b.settings || []).map((s) => <tr key={s.setting}><td className="mono">{s.setting}</td><td>{s.value || <span className="dim">-</span>}</td><td className="dim">{s.source}</td></tr>)}</tbody></table>
          </section>
          <section className="panel" style={{ marginTop: 14 }}><div className="panel-head"><h3>Recent log lines</h3></div>
            <pre className="code" style={{ maxHeight: 280, overflow: 'auto', fontSize: 11.5 }}>{(b.logs || []).slice(-80).join('\n') || 'none'}</pre>
          </section>
        </>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------ environment layer (Agents -> Settings)
interface EnvRow { env: string; agents: number; settings: Settings; version: number; updatedBy?: string; updatedAt?: string }
export function FleetSettings({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const { open } = useDialogs();
  const q = useQuery({ queryKey: ['agent-config'], queryFn: () => api<{ environments: EnvRow[]; schema: Record<string, SettingSchema> }>('/agent-config') });
  const [newEnv, setNewEnv] = useState('');
  if (q.isPending) return <StateView kind="loading" skeleton="table" />;
  if (q.isError) return <ErrorState error={q.error} what="Settings" />;
  const edit = (env: string, cur: Settings) => open((close) => (
    <SettingsEditor title={`Settings for environment ${env}`} schema={q.data.schema} value={cur} onClose={close}
      note={<>Every agent with <code>env={env}</code> gets these, unless its target or the agent itself sets another value. Files on the host always win.</>}
      onSave={async (s) => {
        await api(`/agent-config/env/${encodeURIComponent(env)}`, { method: 'PUT', body: { settings: s } });
        toast(`Saved for ${env}: agents apply it at their next heartbeat`); qc.invalidateQueries({ queryKey: ['agent-config'] });
      }} />
  ));
  return (
    <section className="panel">
      <div className="panel-head"><h3>Settings per environment</h3></div>
      <p className="muted" style={{ marginTop: 0 }}>Layers, later wins: environment → target → agent (Configure in an agent's detail) → files on the host. Only collection settings can be set here; the server address, trust and network settings are set on the host only.</p>
      <table className="tbl">
        <thead><tr><th>Environment</th><th className="num">Agents</th><th>Settings</th><th>Changed</th><th /></tr></thead>
        <tbody>
          {q.data.environments.map((e) => (
            <tr key={e.env}><td><b>{e.env}</b></td><td className="num">{e.agents}</td>
              <td>{Object.keys(e.settings).length ? Object.entries(e.settings).map(([k, v]) => `${k}=${showValue(v)}`).join(' · ') : <span className="dim">none</span>}</td>
              <td className="dim">{e.updatedAt ? `${ago(e.updatedAt)} by ${e.updatedBy}` : '-'}</td>
              <td className="num">{canManage && <button className="btn btn-sm" onClick={() => edit(e.env, e.settings)}>Edit</button>}</td></tr>
          ))}
          {!q.data.environments.length && <tr><td colSpan={5} className="dim">No environments yet: agents get one from --env at install.</td></tr>}
        </tbody>
      </table>
      {canManage && (
        <div className="toolbar" style={{ marginTop: 10 }}>
          <Field label="Another environment"><input className="input" placeholder="uat" value={newEnv} onChange={(e) => setNewEnv(e.target.value.trim())} style={{ width: 180 }} /></Field>
          <button className="btn" disabled={!/^[A-Za-z0-9._-]{1,64}$/.test(newEnv)} onClick={() => edit(newEnv, {})}>Set its settings</button>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------ site gateways (Agents -> Gateways)
interface GatewayRow { id: string; name: string; createdBy: string; createdAt: string; lastSeen: string | null; lastIp: string; version: string; revoked: boolean; agents: number; online: boolean;
  stats: { agents?: number; spooledFiles?: number; spooledBytes?: number; pendingHeartbeats?: number; replayed?: number; dropped?: number; lastUpstreamError?: string } }
export function GatewaysPanel({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const { open, confirm } = useDialogs();
  const q = useQuery({ queryKey: ['gateways'], queryFn: () => api<{ gateways: GatewayRow[] }>('/gateways'), refetchInterval: 15000 });
  const [name, setName] = useState('');
  if (q.isPending) return <StateView kind="loading" skeleton="table" />;
  if (q.isError) return <ErrorState error={q.error} what="Gateways" />;
  const add = async () => {
    try {
      const r = await api<{ id: string; name: string; token: string }>('/gateways', { method: 'POST', body: { name } });
      setName(''); qc.invalidateQueries({ queryKey: ['gateways'] });
      open((close) => (
        <Modal title={`Gateway ${r.name} created`} onClose={close} actions={[{ label: 'Done', primary: true }]}>
          <p>Put this token in the gateway's <code>.env</code> as <code>GATEWAY_TOKEN</code>. It is shown only now.</p>
          <pre className="code" style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{r.token}</pre>
          <p className="dim">Then on the gateway machine: <code>cd gateway && docker compose up -d --build</code> (see gateway/README.md).</p>
        </Modal>
      ));
    } catch (e) { toast((e as Error).message, 'err'); }
  };
  return (
    <section className="panel">
      <div className="panel-head"><h3>Site gateways</h3></div>
      <p className="muted" style={{ marginTop: 0 }}>A gateway relays the agents of a site that cannot reach this server, and keeps their heartbeats and metrics while the link is down (replayed when it is back). Agents there are installed with the gateway's address.</p>
      <table className="tbl">
        <thead><tr><th>Gateway</th><th>Status</th><th className="num">Agents</th><th>Spooled</th><th>Last seen</th><th /></tr></thead>
        <tbody>
          {q.data.gateways.map((g) => (
            <tr key={g.id}>
              <td><b>{g.name}</b><div className="dim" style={{ fontSize: 11 }}>{g.id}{g.version ? ` · ${g.version}` : ''}{g.lastIp ? ` · ${g.lastIp}` : ''}</div></td>
              <td>{g.revoked ? <Pill tone="muted">revoked</Pill> : g.online ? <Pill tone="green">online</Pill> : g.lastSeen ? <Pill tone="red">not reporting</Pill> : <Pill tone="muted">never connected</Pill>}
                {g.stats?.lastUpstreamError && <div className="c-orange" style={{ fontSize: 11 }}>{g.stats.lastUpstreamError}</div>}</td>
              <td className="num">{g.agents}</td>
              <td>{g.stats?.spooledFiles ? `${g.stats.spooledFiles} uploads (${Math.round((g.stats.spooledBytes || 0) / 1024)} kB)` : <span className="dim">nothing waiting</span>}{g.stats?.pendingHeartbeats ? ` · ${g.stats.pendingHeartbeats} heartbeats` : ''}</td>
              <td className="dim">{g.lastSeen ? ago(g.lastSeen) : '-'}</td>
              <td className="num">{canManage && !g.revoked && <button className="btn btn-sm" onClick={async () => {
                if (!(await confirm(`Revoke ${g.name}?`, 'The gateway can no longer relay anything. Its agents stop reporting until they reach this server another way.', 'Revoke'))) return;
                try { await api(`/gateways/${g.id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['gateways'] }); } catch (e) { toast((e as Error).message, 'err'); }
              }}>Revoke</button>}</td>
            </tr>
          ))}
          {!q.data.gateways.length && <tr><td colSpan={6} className="dim">No gateways. Most sites do not need one: agents talk to this server directly.</td></tr>}
        </tbody>
      </table>
      {canManage && <div className="toolbar" style={{ marginTop: 10 }}><input className="input" placeholder="Gateway name, e.g. Mumbai DC" aria-label="Gateway name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 260 }} /><button className="btn" disabled={!name.trim()} onClick={add}>Add gateway</button></div>}
    </section>
  );
}
