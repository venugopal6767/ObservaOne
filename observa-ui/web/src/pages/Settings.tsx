// Settings: my account (profile, password, two-factor, sessions, API keys) and, by permission,
// users, roles, teams, security policy, modules and the audit log.
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Copy, KeyRound } from 'lucide-react';
import { api } from '@/lib/api';
import { ago, browserName, dateTime, dateTimeZ, timeHeader, timeTitle } from '@/lib/format';
import { useApp } from '@/app/AppContext';
import { ErrorState, Field, InfoBox, Modal, PageHead, Panel, Pill, Select, StateView, Tabs, TableWrap, Time, copyText, toast, useDialogs } from '@/components/ui';
import { MfaSetup, RecoveryCodes } from './Mfa';
import { UsersTab, RolesTab, TeamsTab, SecurityTab, ModulesTab, AuditTab } from './SettingsAdmin';

const ALL_TABS: [string, string, string | null][] = [
  ['profile', 'My profile', null], ['sessions', 'Sessions', null], ['apikeys', 'API keys', null],
  ['users', 'Users', 'users.manage'], ['roles', 'Roles', 'users.manage'], ['teams', 'Teams', null],
  ['security', 'Security', 'settings.manage'], ['modules', 'Modules', 'settings.manage'], ['audit', 'Audit log', 'audit.read'],
  ['api', 'API reference', null], ['about', 'About', null],
];

export default function Settings() {
  const { can } = useApp();
  const [params, setParams] = useSearchParams();
  const tabs = ALL_TABS.filter(([, , p]) => !p || can(p));
  const want = params.get('tab') || 'profile';
  const tab = tabs.some(([k]) => k === want) ? want : 'profile';
  const setTab = (k: string) => { const n = new URLSearchParams(params); n.set('tab', k); setParams(n, { replace: true }); };
  const Body = { profile: Profile, sessions: Sessions, apikeys: ApiKeys, users: UsersTab, roles: RolesTab, teams: TeamsTab, security: SecurityTab, modules: ModulesTab, audit: AuditTab, api: ApiRef, about: About }[tab]!;
  return (
    <>
      <PageHead title="Settings" sub="Your account, security, users, roles, teams and API access" />
      <div className="tabs-scroll"><Tabs items={tabs.map(([k, l]) => [k, l] as [string, string])} active={tab} onChange={setTab} label="Settings sections" /></div>
      <div style={{ marginTop: 14 }}><Body /></div>
    </>
  );
}

// ---------------- profile: details, password, two-factor ----------------
function Profile() {
  const { me, reloadMe } = useApp();
  const { confirm } = useDialogs();
  const meQ = useQuery({ queryKey: ['me-profile'], queryFn: reloadMe, initialData: me, staleTime: 0 });
  const u = meQ.data.user;
  const local = u.authSource === 'local';
  const [email, setEmail] = useState(u.email || '');
  const [display, setDisplay] = useState(u.displayName || '');
  const [phone, setPhone] = useState(u.phone || '');
  const [cur, setCur] = useState(''); const [n1, setN1] = useState(''); const [n2, setN2] = useState('');
  const [mfaMode, setMfaMode] = useState<'idle' | 'setup' | 'codes'>('idle');
  const [codes, setCodes] = useState<string[]>([]);
  const [code, setCode] = useState(''); const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); try { await fn(); toast(ok); } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); } };

  let mfaBody: React.ReactNode;
  if (!['local', 'ldap'].includes(u.authSource)) mfaBody = <p className="muted">Two-factor sign-in for your account is handled by your single sign-on provider.</p>;
  else if (mfaMode === 'setup') mfaBody = <MfaSetup compact onDone={() => { setMfaMode('idle'); toast('Two-factor sign-in is on'); meQ.refetch(); }} />;
  else if (mfaMode === 'codes') mfaBody = <RecoveryCodes codes={codes} compact onDone={() => setMfaMode('idle')} />;
  else if (!u.mfaEnabled) mfaBody = <><p>Protect your account with a code from an authenticator app on your phone, in addition to your password.</p><button className="btn btn-primary" onClick={() => setMfaMode('setup')}>Set up two-factor sign-in</button></>;
  else mfaBody = (
    <>
      <p>You enter a code from your authenticator app each time you sign in.</p>
      <div className="toolbar">
        <span className="muted">Current code</span>
        <input className="input mono" inputMode="numeric" maxLength={6} placeholder="123456" style={{ width: 120 }} value={code} onChange={(e) => setCode(e.target.value)} aria-label="Current code" />
        <button className="btn" onClick={async () => {
          try { const r = await api<{ recoveryCodes: string[] }>('/me/mfa/recovery-codes', { method: 'POST', body: { code: code.trim() } }); setCodes(r.recoveryCodes); setMfaMode('codes'); } catch (e) { toast((e as Error).message, 'err'); }
        }}>New recovery codes</button>
        <input className="input" type="password" placeholder={local ? 'Password' : '(not needed)'} disabled={!local} style={{ width: 180 }} value={pw} onChange={(e) => setPw(e.target.value)} aria-label="Password" />
        <button className="btn btn-danger" onClick={async () => {
          if (!(await confirm('Turn off two-factor sign-in', 'Your account will be protected by the password only.', 'Turn off'))) return;
          try { await api('/me/mfa/disable', { method: 'POST', body: { code: code.trim(), password: pw } }); toast('Two-factor sign-in turned off'); meQ.refetch(); } catch (e) { toast((e as Error).message, 'err'); }
        }}>Turn off</button>
      </div>
    </>
  );

  return (
    <div className="grid cols-2">
      <Panel title="Account">
        <dl className="kv" style={{ marginBottom: 14 }}>
          <dt>Username</dt><dd>{u.username}</dd>
          <dt>Role</dt><dd>{u.role}</dd>
          <dt>Signs in with</dt><dd>{({ local: 'Username and password', ldap: 'Company directory (LDAP)', oidc: 'Single sign-on', google: 'Google', github: 'GitHub' } as Record<string, string>)[u.authSource] || u.authSource}</dd>
          <dt>Last sign-in</dt><dd title={u.lastLogin ? timeTitle(Date.parse(u.lastLogin)) : ''}>{u.lastLogin ? dateTimeZ(Date.parse(u.lastLogin)) : '-'}</dd>
          <dt>Session</dt><dd>Signs out after {meQ.data.sessionIdleMinutes} minutes without activity</dd>
        </dl>
        <Field label="Display name"><input className="input" value={display} onChange={(e) => setDisplay(e.target.value)} /></Field>
        <Field label="E-mail" hint="Used for alert and incident notifications."><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Mobile number" hint="For on-call SMS/voice paging (if your admin set it up)."><input className="input" type="tel" placeholder="+91 98450 00000" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        <button className="btn btn-primary" disabled={busy} onClick={() => run(() => api('/me/profile', { method: 'PUT', body: { email: email.trim(), displayName: display.trim(), phone: phone.trim() } }), 'Profile saved')}>Save</button>
      </Panel>
      <Panel title="Password">
        {local ? (
          <>
            <Field label="Current password"><input className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
            <Field label="New password" hint="12+ characters with upper case, lower case, a number and a symbol."><input className="input" type="password" autoComplete="new-password" value={n1} onChange={(e) => setN1(e.target.value)} /></Field>
            <Field label="Repeat new password"><input className="input" type="password" autoComplete="new-password" value={n2} onChange={(e) => setN2(e.target.value)} /></Field>
            <button className="btn btn-primary" disabled={busy} onClick={() => {
              if (n1 !== n2) return toast('New passwords do not match', 'err');
              run(async () => { await api('/me/password', { method: 'POST', body: { current: cur, next: n1 } }); setCur(''); setN1(''); setN2(''); }, 'Password changed. Other sessions were signed out.');
            }}>Change password</button>
          </>
        ) : <p className="muted">Your password is managed by {u.authSource === 'ldap' ? 'the company directory' : 'your sign-in provider'}.</p>}
      </Panel>
      <Panel title="Two-factor sign-in" right={u.mfaEnabled ? <Pill tone="green">On</Pill> : <Pill>Off</Pill>} style={{ gridColumn: '1 / -1' }}>{mfaBody}</Panel>
    </div>
  );
}

// ---------------- sessions ----------------
interface Session { id: string; username: string; userAgent: string; method: string; ip: string; createdAt: string; lastSeen: string; expiresAt: string; current: boolean; persistent: boolean }
function Sessions() {
  const { can } = useApp();
  const isAdmin = can('users.manage');
  const q = useQuery({ queryKey: ['sessions', isAdmin], queryFn: async () => ({ mine: await api<Session[]>('/me/sessions'), all: isAdmin ? await api<Session[]>('/sessions') : null }) });
  if (q.isPending) return <StateView kind="loading" skeleton="table" />;
  if (q.isError) return <TableWrap label="Sessions"><ErrorState error={q.error} what="Sessions" /></TableWrap>;
  return (
    <>
      <h3 className="section-title">My sign-ins</h3>
      <SessionTable list={q.data.mine} admin={false} onChanged={() => q.refetch()} />
      {q.data.all && <><h3 className="section-title" style={{ marginTop: 22 }}>All active sign-ins ({q.data.all.length})</h3><SessionTable list={q.data.all} admin onChanged={() => q.refetch()} /></>}
    </>
  );
}
function SessionTable({ list, admin, onChanged }: { list: Session[]; admin: boolean; onChanged: () => void }) {
  const { confirm } = useDialogs();
  if (!list.length) return <TableWrap label="Sessions"><StateView kind="empty" title="No active sign-ins" /></TableWrap>;
  return (
    <TableWrap label={admin ? 'All sessions' : 'My sessions'}>
      <table className="tbl">
        <thead><tr>{[admin ? 'User' : null, 'Browser', 'Method', 'IP', 'Signed in', 'Last active', timeHeader('Expires'), ''].filter((x) => x !== null).map((x, i) => <th key={i}>{x}</th>)}</tr></thead>
        <tbody>
          {list.map((s) => (
            <tr key={s.id}>
              {admin && <td><b style={{ fontWeight: 600 }}>{s.username}</b></td>}
              <td title={s.userAgent}>{browserName(s.userAgent)}{s.current && <span style={{ marginLeft: 8 }}><Pill tone="blue">this browser</Pill></span>}{s.persistent && <span style={{ marginLeft: 6 }}><Pill>remembered</Pill></span>}</td>
              <td>{s.method}</td><td className="mono">{s.ip || '-'}</td>
              <td className="dim"><Time ms={Date.parse(s.createdAt)} text={ago(s.createdAt)} /></td>
              <td className="dim"><Time ms={Date.parse(s.lastSeen)} text={ago(s.lastSeen)} /></td>
              <td className="dim mono"><Time ms={Date.parse(s.expiresAt)} text={dateTime(Date.parse(s.expiresAt)).slice(0, 16)} /></td>
              <td>{!s.current && <button className="btn btn-sm" onClick={async () => {
                if (!(await confirm('Sign out session', `Sign out ${admin ? `${s.username} on ` : ''}${browserName(s.userAgent)} (${s.ip})?`, 'Sign out'))) return;
                try { await api(admin ? `/sessions/${s.id}` : `/me/sessions/${s.id}`, { method: 'DELETE' }); toast('Session ended'); } catch (e) { toast((e as Error).message, 'err'); }
                onChanged();
              }}>Sign out</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

// ---------------- API keys ----------------
interface ApiKey { id: string; name: string; display: string; role: string; owner: string; createdAt: string; lastUsed: string | null; expiresAt: string | null; revoked: boolean; expired: boolean }
function ApiKeys() {
  const { can } = useApp();
  const { open, confirm } = useDialogs();
  const isAdmin = can('users.manage');
  const [showAll, setShowAll] = useState(false);
  const q = useQuery({ queryKey: ['apikeys', showAll], queryFn: () => api<ApiKey[]>('/apikeys', { query: { all: showAll ? 1 : '' } }) });
  return (
    <>
      <div className="toolbar">
        <div className="grow muted">API keys let scripts, CI pipelines and other tools use the API. A key never has more rights than its owner.</div>
        {isAdmin && <label className="check-row"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />Show all users' keys</label>}
        <button className="btn btn-primary" onClick={() => open((close) => <NewKey onClose={close} onCreated={() => q.refetch()} />)}><Plus size={15} />New API key</button>
      </div>
      {q.isPending ? <StateView kind="loading" skeleton="table" /> : q.isError ? <TableWrap label="API keys"><ErrorState error={q.error} what="API keys" /></TableWrap>
        : !q.data.length ? <TableWrap label="API keys"><StateView kind="empty" title="No API keys yet" /></TableWrap> : (
          <TableWrap label="API keys">
            <table className="tbl">
              <thead><tr>{['Name', 'Key', 'Role', 'Owner', 'Created', 'Last used', 'Expires', 'Status', ''].map((x, i) => <th key={x || i}>{x}</th>)}</tr></thead>
              <tbody>
                {q.data.map((k) => (
                  <tr key={k.id}>
                    <td><b style={{ fontWeight: 600 }}>{k.name}</b></td><td className="mono dim">{k.display}</td><td>{k.role}</td><td>{k.owner}</td>
                    <td className="dim">{ago(k.createdAt)}</td><td className="dim">{k.lastUsed ? ago(k.lastUsed) : 'never'}</td>
                    <td className="dim">{k.expiresAt ? dateTime(Date.parse(k.expiresAt)).slice(0, 10) : 'never'}</td>
                    <td>{k.revoked ? <Pill>Revoked</Pill> : k.expired ? <Pill tone="orange">Expired</Pill> : <Pill tone="green">Active</Pill>}</td>
                    <td>{!k.revoked && <button className="btn btn-sm btn-danger" onClick={async () => {
                      if (!(await confirm('Revoke API key', `Revoke "${k.name}"? Anything using it stops working at once.`, 'Revoke'))) return;
                      try { await api(`/apikeys/${k.id}`, { method: 'DELETE' }); toast('Key revoked'); q.refetch(); } catch (e) { toast((e as Error).message, 'err'); }
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
function NewKey({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { can } = useApp();
  const isAdmin = can('users.manage');
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<{ roles: { name: string; permissions: string[] }[] }>('/roles') });
  const allowed = useMemo(() => (roles.data?.roles || []).filter((r) => can('*') || r.permissions.every((p) => can(p))), [roles.data, can]);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [days, setDays] = useState('90');
  const [svc, setSvc] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const roleValue = role || (allowed.find((r) => r.name === 'viewer') ? 'viewer' : allowed[0]?.name || '');
  if (key) {
    return (
      <Modal title="Copy your API key now" onClose={onClose} actions={[{ label: 'Done', primary: true }]}>
        <p style={{ marginTop: 0 }}>This is the only time the key is shown. Store it in your CI secret store or password manager.</p>
        <pre className="code" style={{ wordBreak: 'break-all' }}>{key}</pre>
        <button className="btn" onClick={() => copyText(key)}><Copy size={13} />Copy</button>
        <p className="muted" style={{ marginTop: 12 }}>Use it like this:</p>
        <pre className="code">{`curl -H "Authorization: Bearer ${key.slice(0, 14)}..." \\\n  ${location.origin}/api/alerts`}</pre>
      </Modal>
    );
  }
  return (
    <Modal title="New API key" onClose={onClose} actions={[
      { label: 'Cancel' },
      { label: 'Create', primary: true, onClick: async () => {
        const r = await api<{ key: string }>('/apikeys', { method: 'POST', body: { name: name.trim(), role: roleValue, expiresDays: days ? Number(days) : null, serviceAccount: svc } });
        setKey(r.key); onCreated();
        return false;
      } },
    ]}>
      <Field label="Name" hint="What will use this key?"><input className="input" placeholder="e.g. jenkins-deploy" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="form-row">
        <Field label="Role"><Select options={allowed.map((r) => [r.name, r.name] as [string, string])} value={roleValue} onChange={setRole} /></Field>
        <Field label="Expires"><Select options={[['30', 'in 30 days'], ['90', 'in 90 days'], ['365', 'in 1 year'], ['', 'never']]} value={days} onChange={setDays} /></Field>
      </div>
      {isAdmin && <label className="check-row"><input type="checkbox" checked={svc} onChange={(e) => setSvc(e.target.checked)} />Service account (not tied to me; keeps working if I leave)</label>}
    </Modal>
  );
}

// ---------------- API reference ----------------
function ApiRef() {
  const q = useQuery({ queryKey: ['api-docs'], queryFn: () => api<{ auth: string; routes: { method: string; path: string; permission: string; description: string }[] }>('/docs') });
  const [f, setF] = useState('');
  if (q.isPending) return <StateView kind="loading" skeleton="table" />;
  if (q.isError) return <TableWrap label="API"><ErrorState error={q.error} what="API reference" /></TableWrap>;
  const rows = q.data.routes.filter((r) => !f || `${r.method} ${r.path} ${r.permission} ${r.description}`.toLowerCase().includes(f.toLowerCase()));
  const tone: Record<string, 'green' | 'blue' | 'orange' | 'red'> = { GET: 'green', POST: 'blue', PUT: 'orange', DELETE: 'red' };
  return (
    <>
      <InfoBox><KeyRound size={14} style={{ verticalAlign: -2 }} /> {q.data.auth}</InfoBox>
      <div className="toolbar"><input className="input" placeholder="Filter endpoints..." aria-label="Filter endpoints" style={{ width: 260 }} value={f} onChange={(e) => setF(e.target.value)} /><div className="grow" /><span className="muted">{q.data.routes.length} endpoints</span></div>
      <TableWrap label="API endpoints" style={{ maxHeight: 'calc(100vh - 300px)' }}>
        <table className="tbl">
          <thead><tr><th>Method</th><th>Path</th><th>Permission</th><th>Description</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={`${r.method} ${r.path}`}><td><Pill tone={tone[r.method] || 'muted'}>{r.method}</Pill></td><td className="mono">{r.path}</td><td className="mono dim">{r.permission}</td><td className="muted">{r.description}</td></tr>)}</tbody>
        </table>
      </TableWrap>
    </>
  );
}

function About() {
  const { me } = useApp();
  const qc = useQueryClient();
  return (
    <Panel>
      <dl className="kv">
        <dt>Product</dt><dd>{me.brand} monitoring UI</dd>
        <dt>Web UI</dt><dd>React + TypeScript (Vite build)</dd>
        <dt>Metrics</dt><dd>Prometheus</dd>
        <dt>Alerts</dt><dd>Prometheus rules + Alertmanager</dd>
        <dt>Logs / Traces</dt><dd>Loki / Tempo (see Data Sources)</dd>
        <dt>App database</dt><dd>PostgreSQL</dd>
        <dt>Keyboard</dt><dd>Ctrl+K or / to search and jump anywhere</dd>
        <dt>Cached queries</dt><dd>{qc.getQueryCache().getAll().length} <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => { qc.clear(); toast('Cache cleared'); }}>Clear</button></dd>
      </dl>
    </Panel>
  );
}
