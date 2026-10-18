// Settings tabs for administrators: users, roles, teams, security policy, modules, audit log.
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Check } from 'lucide-react';
import { api } from '@/lib/api';
import { ago, timeHeader } from '@/lib/format';
import { useApp } from '@/app/AppContext';
import { ErrorState, Field, InfoBox, Modal, Panel, Pill, Select, StateBanner, StateView, TableFoot, TableWrap, Time, toast, useDialogs, usePager } from '@/components/ui';

const SOURCE: Record<string, string> = { local: 'Password', ldap: 'LDAP', oidc: 'SSO', google: 'Google', github: 'GitHub' };
const errMsg = (e: unknown) => toast((e as Error).message, 'err');

// ---------------- Users ----------------
interface UserRow { username: string; displayName?: string; email?: string; role: string; authSource: string; mfaEnabled: boolean; teams?: string[]; disabled: boolean; activeSessions: number; lastLogin?: string }
export function UsersTab() {
  const { me } = useApp();
  const { open, confirm } = useDialogs();
  const q = useQuery({ queryKey: ['users'], queryFn: () => api<{ users: UserRow[]; roles: string[] }>('/users') });
  const [f, setF] = useState('');
  if (q.isPending) return <StateView kind="loading" skeleton="table" />;
  if (q.isError) return <TableWrap label="Users"><ErrorState error={q.error} what="Users" /></TableWrap>;
  const { users, roles } = q.data;
  const reload = () => q.refetch();
  const put = async (u: UserRow, body: object, ok: string) => { try { await api(`/users/${encodeURIComponent(u.username)}`, { method: 'PUT', body }); toast(ok); } catch (e) { errMsg(e); } reload(); };
  const shown = users.filter((u) => !f || `${u.username} ${u.displayName || ''} ${u.email || ''} ${u.role} ${(u.teams || []).join(' ')}`.toLowerCase().includes(f.toLowerCase()));
  return (
    <>
      <div className="toolbar">
        <input className="input" placeholder="Filter users..." aria-label="Filter users" style={{ width: 220 }} value={f} onChange={(e) => setF(e.target.value)} />
        <div className="grow" />
        <button className="btn btn-primary" onClick={() => open((close) => <AddUser roles={roles} onClose={close} onDone={reload} />)}><Plus size={15} />Add user</button>
      </div>
      <TableWrap label="Users">
        <table className="tbl">
          <thead><tr>{['User', 'Role', 'Signs in with', '2FA', 'Teams', 'Status', 'Signed in now', 'Last sign-in', ''].map((x, i) => <th key={x || i}>{x}</th>)}</tr></thead>
          <tbody>
            {shown.map((u) => {
              const self = u.username === me.user.username;
              return (
                <tr key={u.username}>
                  <td><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div className="avatar sm">{(u.displayName || u.username)[0].toUpperCase()}</div>
                    <div><b style={{ fontWeight: 600 }}>{u.username}</b>{self && <span style={{ marginLeft: 6 }}><Pill tone="blue">you</Pill></span>}
                      <div className="dim" style={{ fontSize: 11.5 }}>{[u.displayName, u.email].filter(Boolean).join(' · ')}</div></div>
                  </div></td>
                  <td>{self ? u.role : <Select className="select select-sm" label={`Role of ${u.username}`} options={roles} value={u.role} onChange={(role) => put(u, { role }, `${u.username} is now ${role}`)} />}</td>
                  <td>{SOURCE[u.authSource] || u.authSource}</td>
                  <td>{u.mfaEnabled ? <Pill tone="green">On</Pill> : <span className="dim">off</span>}</td>
                  <td className="dim" style={{ fontSize: 12 }}>{(u.teams || []).join(', ') || '-'}</td>
                  <td>{u.disabled ? <Pill tone="red">Disabled</Pill> : <Pill tone="green">Active</Pill>}</td>
                  <td>{u.activeSessions ? <Pill tone="blue">{u.activeSessions} session{u.activeSessions > 1 ? 's' : ''}</Pill> : <span className="dim">-</span>}</td>
                  <td className="dim">{u.lastLogin ? ago(u.lastLogin) : 'never'}</td>
                  <td>{!self && (
                    <div className="row-actions">
                      {u.authSource === 'local' && <button className="btn btn-sm" onClick={() => open((close) => <ResetPassword u={u} onClose={close} />)}>Reset password</button>}
                      {u.mfaEnabled && <button className="btn btn-sm" title="For a user who lost their phone" onClick={async () => {
                        if (await confirm('Reset two-factor sign-in', `${u.username} will sign in with the password only, and can set up a new device.`, 'Reset')) put(u, { resetMfa: true }, 'Two-factor reset');
                      }}>Reset 2FA</button>}
                      <button className="btn btn-sm" onClick={() => put(u, { disabled: !u.disabled }, u.disabled ? 'User enabled' : 'User disabled and signed out')}>{u.disabled ? 'Enable' : 'Disable'}</button>
                      <button className="icon-btn" title="Delete user" aria-label={`Delete ${u.username}`} onClick={async () => {
                        if (!(await confirm('Delete user', `Delete "${u.username}"? They will be signed out and their API keys stop working.`, 'Delete'))) return;
                        try { await api(`/users/${encodeURIComponent(u.username)}`, { method: 'DELETE' }); toast('User deleted'); } catch (e) { errMsg(e); }
                        reload();
                      }}><Trash2 size={14} /></button>
                    </div>
                  )}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableWrap>
      <p className="muted" style={{ marginTop: 10, fontSize: 12 }}>LDAP and SSO users are created automatically the first time they sign in. Their role comes from their groups when a group mapping is set.</p>
    </>
  );
}
function AddUser({ roles, onClose, onDone }: { roles: string[]; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ username: '', displayName: '', email: '', password: '', role: roles.includes('viewer') ? 'viewer' : roles[0] });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value });
  return (
    <Modal title="Add user" onClose={onClose} actions={[{ label: 'Cancel' }, { label: 'Add user', primary: true, onClick: async () => { await api('/users', { method: 'POST', body: { ...v, username: v.username.trim(), displayName: v.displayName.trim(), email: v.email.trim() } }); toast('User added'); onDone(); } }]}>
      <div className="form-row">
        <Field label="Username" hint="Letters, numbers, dot, dash, underscore, @."><input className="input" autoComplete="off" value={v.username} onChange={set('username')} /></Field>
        <Field label="Display name"><input className="input" value={v.displayName} onChange={set('displayName')} /></Field>
      </div>
      <Field label="E-mail"><input className="input" type="email" value={v.email} onChange={set('email')} /></Field>
      <Field label="Temporary password" hint="12+ characters with upper, lower, number and symbol. Ask the user to change it."><input className="input" type="password" autoComplete="new-password" value={v.password} onChange={set('password')} /></Field>
      <Field label="Role"><Select options={roles} value={v.role} onChange={(role) => setV({ ...v, role })} /></Field>
    </Modal>
  );
}
function ResetPassword({ u, onClose }: { u: UserRow; onClose: () => void }) {
  const [pw, setPw] = useState('');
  return (
    <Modal title={`Reset password for ${u.username}`} onClose={onClose} actions={[{ label: 'Cancel' }, { label: 'Reset', primary: true, onClick: async () => { await api(`/users/${encodeURIComponent(u.username)}`, { method: 'PUT', body: { password: pw } }); toast('Password reset'); } }]}>
      <Field label="New password" hint="They will be signed out everywhere."><input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
    </Modal>
  );
}

// ---------------- Roles ----------------
interface Role { name: string; description?: string; permissions: string[]; builtin: boolean; users: number }
export function RolesTab() {
  const { open, confirm } = useDialogs();
  const q = useQuery({ queryKey: ['roles'], queryFn: () => api<{ roles: Role[]; permissions: Record<string, string> }>('/roles') });
  if (q.isPending) return <StateView kind="loading" skeleton="table" />;
  if (q.isError) return <TableWrap label="Roles"><ErrorState error={q.error} what="Roles" /></TableWrap>;
  const d = q.data;
  const perms = Object.keys(d.permissions);
  const edit = (role: Role | null) => open((close) => <EditRole role={role} permissions={d.permissions} onClose={close} onDone={() => q.refetch()} />);
  return (
    <>
      <div className="toolbar"><div className="grow muted">A role is a set of permissions. The three built-in roles cannot be changed; make your own for anything in between.</div>
        <button className="btn btn-primary" onClick={() => edit(null)}><Plus size={15} />New role</button></div>
      <TableWrap label="Roles">
        <table className="tbl perm-matrix">
          <thead><tr><th>Permission</th>{d.roles.map((r) => (
            <th key={r.name} className="center">
              <div>{r.name}</div><div className="dim" style={{ fontWeight: 400, fontSize: 11 }}>{r.users} user{r.users === 1 ? '' : 's'}</div>
              {!r.builtin && <div className="row-actions" style={{ justifyContent: 'center' }}>
                <button className="icon-btn" title="Edit" aria-label={`Edit role ${r.name}`} onClick={() => edit(r)}><Pencil size={13} /></button>
                <button className="icon-btn" title="Delete" aria-label={`Delete role ${r.name}`} onClick={async () => {
                  if (!(await confirm('Delete role', `Delete role "${r.name}"?`, 'Delete'))) return;
                  try { await api(`/roles/${r.name}`, { method: 'DELETE' }); toast('Role deleted'); } catch (e) { errMsg(e); }
                  q.refetch();
                }}><Trash2 size={13} /></button>
              </div>}
            </th>
          ))}</tr></thead>
          <tbody>{perms.map((p) => (
            <tr key={p}>
              <td><div className="mono" style={{ fontSize: 12 }}>{p}</div><div className="dim" style={{ fontSize: 11.5 }}>{d.permissions[p]}</div></td>
              {d.roles.map((r) => <td key={r.name} className="center">{r.permissions.includes('*') || r.permissions.includes(p) ? <span className="c-green"><Check size={15} aria-label="yes" /></span> : <span className="dim">·</span>}</td>)}
            </tr>
          ))}</tbody>
        </table>
      </TableWrap>
    </>
  );
}
function EditRole({ role, permissions, onClose, onDone }: { role: Role | null; permissions: Record<string, string>; onClose: () => void; onDone: () => void }) {
  const { can } = useApp();
  const [name, setName] = useState(role?.name || '');
  const [desc, setDesc] = useState(role?.description || '');
  const [chosen, setChosen] = useState(new Set(role?.permissions || ['view']));
  return (
    <Modal title={role ? `Edit role ${role.name}` : 'New role'} wide onClose={onClose} actions={[{ label: 'Cancel' }, { label: role ? 'Save' : 'Create', primary: true, onClick: async () => {
      const body = { name: name.trim(), description: desc.trim(), permissions: [...chosen] };
      if (role) await api(`/roles/${role.name}`, { method: 'PUT', body }); else await api('/roles', { method: 'POST', body });
      toast('Role saved'); onDone();
    } }]}>
      <div className="form-row">
        <Field label="Name" hint="lower-case, e.g. sre or noc"><input className="input" disabled={!!role} placeholder="e.g. sre" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Description"><input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
      </div>
      <div className="field-label" style={{ margin: '6px 0' }}>Permissions</div>
      <div className="perm-list">
        {Object.entries(permissions).map(([p, text]) => (
          <label key={p} className="check-row perm">
            <input type="checkbox" checked={chosen.has(p)} disabled={p === 'view' || !can(p)} onChange={(e) => { const n = new Set(chosen); if (e.target.checked) n.add(p); else n.delete(p); setChosen(n); }} />
            <span><span className="mono">{p}</span><span className="dim"> - {text}</span></span>
          </label>
        ))}
      </div>
    </Modal>
  );
}

// ---------------- Teams ----------------
interface Team { id: string; name: string; description?: string; members: { username: string; displayName?: string }[] }
export function TeamsTab() {
  const { can } = useApp();
  const { open, confirm } = useDialogs();
  const q = useQuery({ queryKey: ['teams'], queryFn: async () => ({ teams: await api<Team[]>('/teams'), users: await api<{ username: string; displayName?: string }[]>('/users/names') }) });
  if (q.isPending) return <StateView kind="loading" skeleton="table" />;
  if (q.isError) return <TableWrap label="Teams"><ErrorState error={q.error} what="Teams" /></TableWrap>;
  const canEdit = can('users.manage');
  const edit = (t: Team | null) => open((close) => <EditTeam team={t} users={q.data.users} onClose={close} onDone={() => q.refetch()} />);
  return (
    <>
      <div className="toolbar"><div className="grow muted">Teams own services, dashboards, on-call schedules and incidents.</div>
        {canEdit && <button className="btn btn-primary" onClick={() => edit(null)}><Plus size={15} />New team</button>}</div>
      {!q.data.teams.length ? <TableWrap label="Teams"><StateView kind="empty" title="No teams yet" /></TableWrap> : (
        <div className="card-grid">
          {q.data.teams.map((t) => (
            <Panel key={t.id} title={t.name} right={canEdit && <>
              <button className="icon-btn" title="Edit" aria-label={`Edit ${t.name}`} onClick={() => edit(t)}><Pencil size={14} /></button>
              <button className="icon-btn" title="Delete" aria-label={`Delete ${t.name}`} onClick={async () => {
                if (!(await confirm('Delete team', `Delete team "${t.name}"?`, 'Delete'))) return;
                try { await api(`/teams/${t.id}`, { method: 'DELETE' }); } catch (e) { errMsg(e); }
                q.refetch();
              }}><Trash2 size={14} /></button>
            </>}>
              <p className="muted" style={{ marginTop: 0 }}>{t.description || ''}</p>
              <div className="chips">{t.members.length ? t.members.map((m) => <Pill key={m.username}>{m.displayName || m.username}</Pill>) : <span className="dim">No members</span>}</div>
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}
function EditTeam({ team, users, onClose, onDone }: { team: Team | null; users: { username: string; displayName?: string }[]; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(team?.name || '');
  const [desc, setDesc] = useState(team?.description || '');
  const [members, setMembers] = useState(new Set((team?.members || []).map((m) => m.username)));
  return (
    <Modal title={team ? `Edit ${team.name}` : 'New team'} onClose={onClose} actions={[{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: async () => {
      let id = team?.id;
      if (!id) id = (await api<{ id: string }>('/teams', { method: 'POST', body: { name: name.trim(), description: desc.trim() } })).id;
      await api(`/teams/${id}`, { method: 'PUT', body: { name: name.trim(), description: desc.trim(), members: [...members] } });
      toast('Team saved'); onDone();
    } }]}>
      <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Description"><input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
      <div className="field-label">Members</div>
      <div className="perm-list" style={{ maxHeight: 260 }}>
        {users.map((u) => (
          <label key={u.username} className="check-row">
            <input type="checkbox" checked={members.has(u.username)} onChange={(e) => { const n = new Set(members); if (e.target.checked) n.add(u.username); else n.delete(u.username); setMembers(n); }} />
            {u.displayName ? `${u.displayName} (${u.username})` : u.username}
          </label>
        ))}
      </div>
    </Modal>
  );
}

// ---------------- Security policy ----------------
interface Security { mfaRequiredRoles: string[]; session: { idleMinutes: number; maxHours: number; lockoutAfter: number; lockoutMinutes: number }; sso: { label: string }[]; publicUrl?: string; ldap: null | { url: string; baseDn: string; filter: string; mappings: number; defaultRole?: string } }
export function SecurityTab() {
  const q = useQuery({ queryKey: ['security'], queryFn: async () => ({ s: await api<Security>('/settings/security'), roles: (await api<{ roles: Role[] }>('/roles')).roles }) });
  const [required, setRequired] = useState<Set<string> | null>(null);
  const [ldapUser, setLdapUser] = useState('');
  const [ldapOut, setLdapOut] = useState<{ ok: boolean; message: string; groups?: string[]; role?: string } | 'busy' | null>(null);
  if (q.isPending) return <StateView kind="loading" skeleton="table" />;
  if (q.isError) return <TableWrap label="Security"><ErrorState error={q.error} what="Security settings" /></TableWrap>;
  const { s, roles } = q.data;
  const req = required ?? new Set(s.mfaRequiredRoles || []);
  return (
    <div className="grid cols-2">
      <Panel title="Two-factor sign-in policy">
        <p className="muted" style={{ marginTop: 0 }}>Users with these roles must set up an authenticator app before they can use the app. Applies to password and LDAP users (SSO users use their provider's MFA).</p>
        <div className="perm-list">
          {roles.map((r) => <label key={r.name} className="check-row"><input type="checkbox" checked={req.has(r.name)} onChange={(e) => { const n = new Set(req); if (e.target.checked) n.add(r.name); else n.delete(r.name); setRequired(n); }} />{r.name}</label>)}
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={async () => {
          try { await api('/settings/security', { method: 'PUT', body: { mfaRequiredRoles: [...req] } }); toast('Policy saved'); } catch (e) { errMsg(e); }
        }}>Save policy</button>
      </Panel>
      <Panel title="Sessions and lockout">
        <dl className="kv">
          <dt>Idle sign-out</dt><dd>{s.session.idleMinutes} minutes</dd>
          <dt>Maximum session</dt><dd>{s.session.maxHours} hours</dd>
          <dt>Lockout</dt><dd>{s.session.lockoutAfter} wrong passwords → {s.session.lockoutMinutes} minutes</dd>
        </dl>
        <p className="dim" style={{ fontSize: 12 }}>Change these with SESSION_* and LOCKOUT_* in .env.</p>
      </Panel>
      <Panel title="Single sign-on">
        {s.sso.length ? <div className="chips">{s.sso.map((p) => <Pill key={p.label} tone="green">{p.label} on</Pill>)}</div> : <p className="muted">No SSO provider is set up.</p>}
        <p className="dim" style={{ fontSize: 12 }}>Set OIDC_*, GOOGLE_* or GITHUB_* in .env. Redirect URL to register: {s.publicUrl || location.origin}/api/auth/&lt;oidc|google|github&gt;/callback</p>
      </Panel>
      <Panel title="LDAP / Active Directory">
        {s.ldap ? (
          <>
            <dl className="kv">
              <dt>Server</dt><dd className="mono">{s.ldap.url}</dd><dt>Base DN</dt><dd className="mono">{s.ldap.baseDn}</dd>
              <dt>User filter</dt><dd className="mono">{s.ldap.filter}</dd><dt>Group mappings</dt><dd>{s.ldap.mappings}</dd>
              <dt>Default role</dt><dd>{s.ldap.defaultRole || '(none: unmapped users refused)'}</dd>
            </dl>
            <div className="toolbar" style={{ marginTop: 10 }}>
              <input className="input" placeholder="username to look up (optional)" style={{ width: 240 }} value={ldapUser} onChange={(e) => setLdapUser(e.target.value)} />
              <button className="btn" onClick={async () => {
                setLdapOut('busy');
                setLdapOut(await api<{ ok: boolean; message: string; groups?: string[]; role?: string }>('/settings/ldap/test', { method: 'POST', body: { username: ldapUser.trim() } }).catch((e) => ({ ok: false, message: (e as Error).message })));
              }}>Test</button>
            </div>
            {ldapOut === 'busy' ? <div className="spinner" /> : ldapOut && (ldapOut.ok
              ? <InfoBox tone="ok">{ldapOut.message}{ldapOut.groups && <><br /><span className="dim">Groups: {ldapOut.groups.join('; ') || '-'}</span><br />Role: {ldapOut.role || 'none (would be refused)'}</>}</InfoBox>
              : <InfoBox tone="error">{ldapOut.message}</InfoBox>)}
          </>
        ) : <p className="muted">LDAP is not set up. Set LDAP_URL, LDAP_BASE_DN, LDAP_BIND_DN and LDAP_BIND_PASSWORD in .env.</p>}
      </Panel>
    </div>
  );
}

// ---------------- Modules ----------------
// Which product modules this deployment uses. Turning one off hides it for everyone and its API answers 404;
// saved dashboards, queries and preferences are kept and come back when it is turned on again.
export function ModulesTab() {
  const { reloadMe } = useApp();
  const { confirm } = useDialogs();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['modules'], queryFn: () => api<{ catalog: { id: string; name: string; description: string; source: string }[]; enabled: string[]; configured: boolean }>('/modules') });
  const [on, setOn] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const current = useMemo(() => on ?? new Set(q.data?.enabled || []), [on, q.data]);
  if (q.isPending) return <StateView kind="loading" skeleton="table" />;
  if (q.isError) return <TableWrap label="Modules"><ErrorState error={q.error} what="Modules" /></TableWrap>;
  const d = q.data;
  const dirty = [...current].sort().join() !== [...d.enabled].sort().join();
  async function save() {
    const off = d.catalog.filter((m) => d.enabled.includes(m.id) && !current.has(m.id)).map((m) => m.name);
    if (off.length && !(await confirm('Turn off modules?', `${off.join(', ')} will disappear for every user, and their API will stop answering. Saved dashboards, queries and settings are kept.`, 'Turn off'))) return;
    setBusy(true);
    try {
      await api('/modules', { method: 'PUT', body: { enabled: [...current] } });
      toast('Modules saved');
      setOn(null);
      await q.refetch();
      await reloadMe(); // rebuild the menu, search and bell for the new selection
      qc.invalidateQueries();
    } catch (e) { errMsg(e); } finally { setBusy(false); }
  }
  return (
    <Panel title="Modules for this deployment" right={<button className="btn btn-primary" disabled={!dirty || busy} onClick={save}>Save</button>}>
      <p className="muted" style={{ marginTop: 0 }}>Users see only the modules turned on here, and within those only what their role allows. Overview, Data Sources and Settings are always available. Turning a module on does not connect its data source: if the source is not reachable, its pages say so.</p>
      {!d.configured && <InfoBox>No selection has been saved yet, so every module is on. Untick the ones this deployment does not use and save.</InfoBox>}
      <div className="module-list">
        {d.catalog.map((m) => (
          <label key={m.id} className="module-row">
            <input type="checkbox" checked={current.has(m.id)} onChange={(e) => { const n = new Set(current); if (e.target.checked) n.add(m.id); else n.delete(m.id); setOn(n); }} />
            <div className="grow"><div className="module-name">{m.name}</div><div className="module-desc">{m.description}</div><div className="module-source">Data source: {m.source}</div></div>
          </label>
        ))}
      </div>
    </Panel>
  );
}

// ---------------- Audit log ----------------
const ACTIONS: [string, string][] = [['', 'All actions'], ['login', 'Sign-ins'], ['login.failed', 'Failed sign-ins'], ['mfa.', 'Two-factor'], ['user.', 'User changes'], ['role.', 'Roles'], ['team.', 'Teams'], ['apikey.', 'API keys'], ['session.', 'Sessions'],
  ['dashboard.', 'Dashboards'], ['rule.', 'Alert rules'], ['silence.', 'Silences'], ['agent.', 'Agents'], ['datasource.', 'Data sources'], ['settings.', 'Settings'], ['modules.', 'Modules'], ['access.denied', 'Access denied']];
const LIMIT = 300;
export function AuditTab() {
  const [userIn, setUserIn] = useState('');
  const [filter, setFilter] = useState({ user: '', action: '' });
  const q = useQuery({ queryKey: ['audit', filter], queryFn: () => api<{ id: number; time: string; user: string; ip: string; action: string; [k: string]: unknown }[]>('/audit', { query: { limit: LIMIT, ...filter } }) });
  const rows = q.data || [];
  const pager = usePager(rows, 100, JSON.stringify(filter));
  const tone = (a: string) => (a.includes('failed') || a.includes('denied') || a.includes('locked') ? 'red' : a.startsWith('login') ? 'green' : 'blue');
  return (
    <>
      <div className="toolbar">
        <input className="input" placeholder="User" aria-label="Filter by user" style={{ width: 160 }} value={userIn} onChange={(e) => setUserIn(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setFilter({ ...filter, user: userIn.trim() })} />
        <Select label="Filter by action" options={ACTIONS} value={filter.action} onChange={(action) => setFilter({ ...filter, action })} />
        <button className="btn" onClick={() => setFilter({ ...filter, user: userIn.trim() })}>Filter</button>
        <div className="grow" /><span className="muted">Stored in the database</span>
      </div>
      {q.isPending ? <TableWrap label="Audit log"><StateView kind="loading" skeleton="table" /></TableWrap>
        : q.isError ? <TableWrap label="Audit log"><ErrorState error={q.error} what="Audit log" /></TableWrap>
          : !rows.length ? <TableWrap label="Audit log"><StateView kind="empty" title="No audit entries match" text={filter.user || filter.action ? 'Clear the user or action filter.' : 'Nothing has been recorded yet.'} /></TableWrap> : (
            <>
              {rows.length >= LIMIT && <StateBanner>Showing the newest {LIMIT} entries. Filter by user or action to find older ones.</StateBanner>}
              <TableWrap label="Audit log entries" style={{ maxHeight: 'calc(100vh - 330px)' }}>
                <table className="tbl">
                  <thead><tr>{[timeHeader(), 'User', 'IP', 'Action', 'Details'].map((x) => <th key={x}>{x}</th>)}</tr></thead>
                  <tbody>
                    {pager.rows.map((r) => {
                      const { id, time, user, ip, action, ...rest } = r;
                      const details = Object.keys(rest).length ? JSON.stringify(rest) : '';
                      return (
                        <tr key={id}>
                          <td className="mono" style={{ whiteSpace: 'nowrap' }}><Time ms={Date.parse(time)} /></td><td>{user}</td><td className="mono dim">{ip}</td>
                          <td><Pill tone={tone(action)}>{action}</Pill></td><td className="mono dim msg" style={{ fontSize: 11.5 }} title={details}>{details}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <TableFoot pager={pager} noun="entries" note={rows.length >= LIMIT ? `(newest ${LIMIT} only)` : undefined} />
              </TableWrap>
            </>
          )}
    </>
  );
}
