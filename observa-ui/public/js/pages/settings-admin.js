// Settings tabs for administrators: users, roles, teams, security policy, audit log.
import { h, api, clear, icon, errorBox, spinner, modal, field, select, toast, confirmBox, ago, pill, timeEl, timeHeader, stateView, stateFromError, stateBanner, paginate } from '../ui.js';

const SOURCE = { local: 'Password', ldap: 'LDAP', oidc: 'SSO', google: 'Google', github: 'GitHub' };

export function browserName(ua = '') {
  const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : (ua.split(' ')[0] || 'Unknown');
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} on ${os}` : b;
}

// ---------------- Users ----------------
export async function usersTab(out, ctx) {
  out.append(stateView('loading', { skeleton: 'table' }));
  let data;
  try { data = await api('/users'); } catch (e) { clear(out).append(h('div', { class: 'table-wrap' }, stateFromError(e, 'Settings'))); return; }
  const filter = h('input', { class: 'input', placeholder: 'Filter users...', style: { width: '220px' } });
  const body = h('tbody');
  const reload = () => { clear(out); usersTab(out, ctx); };
  const draw = () => {
    const f = filter.value.toLowerCase();
    clear(body).append(...data.users.filter((u) => !f || `${u.username} ${u.displayName || ''} ${u.email || ''} ${u.role} ${(u.teams || []).join(' ')}`.toLowerCase().includes(f)).map((u) => {
      const me = u.username === ctx.me.user.username;
      return h('tr', {},
        h('td', {}, h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          h('div', { class: 'avatar sm' }, (u.displayName || u.username)[0].toUpperCase()),
          h('div', {}, h('b', { style: { fontWeight: 600 } }, u.username), me ? h('span', { style: { marginLeft: '6px' } }, pill('you', 'blue')) : null,
            h('div', { class: 'dim', style: { fontSize: '11.5px' } }, [u.displayName, u.email].filter(Boolean).join(' · '))))),
        h('td', {}, me ? u.role : select(data.roles.map((r) => [r, r]), u.role, async (role) => {
          try { await api(`/users/${encodeURIComponent(u.username)}`, { method: 'PUT', body: { role } }); toast(`${u.username} is now ${role}`); } catch (e) { toast(e.message, 'err'); }
          reload();
        }, { class: 'select select-sm', 'aria-label': `Role of ${u.username}` })),
        h('td', {}, SOURCE[u.authSource] || u.authSource),
        h('td', {}, u.mfaEnabled ? pill('On', 'green') : h('span', { class: 'dim' }, 'off')),
        h('td', { class: 'dim', style: { fontSize: '12px' } }, (u.teams || []).join(', ') || '-'),
        h('td', {}, u.disabled ? pill('Disabled', 'red') : pill('Active', 'green')),
        h('td', {}, u.activeSessions ? pill(`${u.activeSessions} session${u.activeSessions > 1 ? 's' : ''}`, 'blue') : h('span', { class: 'dim' }, '-')),
        h('td', { class: 'dim' }, u.lastLogin ? ago(u.lastLogin) : 'never'),
        h('td', {}, me ? null : h('div', { class: 'row-actions' },
          u.authSource === 'local' ? h('button', { class: 'btn btn-sm', onclick: () => resetPassword(u) }, 'Reset password') : null,
          u.mfaEnabled ? h('button', { class: 'btn btn-sm', title: 'For a user who lost their phone', onclick: async () => {
            if (!(await confirmBox('Reset two-factor sign-in', `${u.username} will sign in with the password only, and can set up a new device.`, 'Reset'))) return;
            try { await api(`/users/${encodeURIComponent(u.username)}`, { method: 'PUT', body: { resetMfa: true } }); toast('Two-factor reset'); } catch (e) { toast(e.message, 'err'); }
            reload();
          } }, 'Reset 2FA') : null,
          h('button', { class: 'btn btn-sm', onclick: async () => {
            try { await api(`/users/${encodeURIComponent(u.username)}`, { method: 'PUT', body: { disabled: !u.disabled } }); toast(u.disabled ? 'User enabled' : 'User disabled and signed out'); } catch (e) { toast(e.message, 'err'); }
            reload();
          } }, u.disabled ? 'Enable' : 'Disable'),
          h('button', { class: 'icon-btn', title: 'Delete user', onclick: async () => {
            if (!(await confirmBox('Delete user', `Delete "${u.username}"? They will be signed out and their API keys stop working.`, 'Delete'))) return;
            try { await api(`/users/${encodeURIComponent(u.username)}`, { method: 'DELETE' }); toast('User deleted'); } catch (e) { toast(e.message, 'err'); }
            reload();
          } }, icon('trash', 14)))));
    }));
  };
  filter.addEventListener('input', draw);
  clear(out).append(
    h('div', { class: 'toolbar' }, filter, h('div', { class: 'grow' }),
      h('button', { class: 'btn btn-primary', onclick: () => addUser(data.roles) }, icon('plus', 15), 'Add user')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['User', 'Role', 'Signs in with', '2FA', 'Teams', 'Status', 'Signed in now', 'Last sign-in', ''].map((x) => h('th', {}, x)))), body)),
    h('p', { class: 'muted', style: { marginTop: '10px', fontSize: '12px' } }, 'LDAP and SSO users are created automatically the first time they sign in. Their role comes from their groups when a group mapping is set.'));
  draw();

  function addUser(roles) {
    const name = h('input', { class: 'input', autocomplete: 'off' });
    const display = h('input', { class: 'input' });
    const email = h('input', { class: 'input', type: 'email' });
    const pass = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    let role = roles.includes('viewer') ? 'viewer' : roles[0];
    modal('Add user', h('div', {},
      h('div', { class: 'form-row' }, field('Username', name, 'Letters, numbers, dot, dash, underscore, @.'), field('Display name', display)),
      field('E-mail', email),
      field('Temporary password', pass, '12+ characters with upper, lower, number and symbol. Ask the user to change it.'),
      field('Role', select(roles.map((r) => [r, r]), role, (v) => { role = v; }))), [
      { label: 'Cancel' },
      { label: 'Add user', primary: true, onclick: async () => {
        await api('/users', { method: 'POST', body: { username: name.value.trim(), displayName: display.value.trim(), email: email.value.trim(), password: pass.value, role } });
        toast('User added');
        reload();
      } },
    ]);
  }

  function resetPassword(u) {
    const pass = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    modal(`Reset password for ${u.username}`, h('div', {}, field('New password', pass, 'They will be signed out everywhere.')), [
      { label: 'Cancel' },
      { label: 'Reset', primary: true, onclick: async () => {
        await api(`/users/${encodeURIComponent(u.username)}`, { method: 'PUT', body: { password: pass.value } });
        toast('Password reset');
      } },
    ]);
  }
}

// ---------------- Roles ----------------
export async function rolesTab(out, ctx) {
  out.append(stateView('loading', { skeleton: 'table' }));
  let d;
  try { d = await api('/roles'); } catch (e) { clear(out).append(h('div', { class: 'table-wrap' }, stateFromError(e, 'Settings'))); return; }
  const reload = () => { clear(out); rolesTab(out, ctx); };
  const permKeys = Object.keys(d.permissions);
  clear(out).append(
    h('div', { class: 'toolbar' }, h('div', { class: 'grow muted' }, 'A role is a set of permissions. The three built-in roles cannot be changed; make your own for anything in between.'),
      h('button', { class: 'btn btn-primary', onclick: () => edit(null) }, icon('plus', 15), 'New role')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'tbl perm-matrix' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Permission'), d.roles.map((r) => h('th', { class: 'center' },
        h('div', {}, r.name), h('div', { class: 'dim', style: { fontWeight: 400, fontSize: '11px' } }, `${r.users} user${r.users === 1 ? '' : 's'}`),
        r.builtin ? null : h('div', { class: 'row-actions', style: { justifyContent: 'center' } },
          h('button', { class: 'icon-btn', title: 'Edit', onclick: () => edit(r) }, icon('edit', 13)),
          h('button', { class: 'icon-btn', title: 'Delete', onclick: async () => {
            if (!(await confirmBox('Delete role', `Delete role "${r.name}"?`, 'Delete'))) return;
            try { await api(`/roles/${r.name}`, { method: 'DELETE' }); toast('Role deleted'); } catch (e) { toast(e.message, 'err'); }
            reload();
          } }, icon('trash', 13))))))),
      h('tbody', {}, permKeys.map((p) => h('tr', {},
        h('td', {}, h('div', { class: 'mono', style: { fontSize: '12px' } }, p), h('div', { class: 'dim', style: { fontSize: '11.5px' } }, d.permissions[p])),
        d.roles.map((r) => h('td', { class: 'center' }, r.permissions.includes('*') || r.permissions.includes(p) ? h('span', { class: 'c-green' }, icon('check', 15)) : h('span', { class: 'dim' }, '·')))))))));

  function edit(role) {
    const name = h('input', { class: 'input', value: role?.name || '', disabled: !!role, placeholder: 'e.g. sre' });
    const desc = h('input', { class: 'input', value: role?.description || '' });
    const chosen = new Set(role?.permissions || ['view']);
    const boxes = permKeys.map((p) => h('label', { class: 'check-row perm' },
      h('input', { type: 'checkbox', checked: chosen.has(p), disabled: p === 'view' || !ctx.can(p), onchange: (e) => (e.target.checked ? chosen.add(p) : chosen.delete(p)) }),
      h('span', {}, h('span', { class: 'mono' }, p), h('span', { class: 'dim' }, ` - ${d.permissions[p]}`))));
    modal(role ? `Edit role ${role.name}` : 'New role', h('div', {},
      h('div', { class: 'form-row' }, field('Name', name, 'lower-case, e.g. sre or noc'), field('Description', desc)),
      h('div', { class: 'field-label', style: { margin: '6px 0' } }, 'Permissions'),
      h('div', { class: 'perm-list' }, boxes)), [
      { label: 'Cancel' },
      { label: role ? 'Save' : 'Create', primary: true, onclick: async () => {
        const body = { name: name.value.trim(), description: desc.value.trim(), permissions: [...chosen] };
        if (role) await api(`/roles/${role.name}`, { method: 'PUT', body });
        else await api('/roles', { method: 'POST', body });
        toast('Role saved');
        reload();
      } },
    ], { wide: true });
  }
}

// ---------------- Teams ----------------
export async function teamsTab(out, ctx) {
  out.append(stateView('loading', { skeleton: 'table' }));
  let teams, users;
  try { [teams, users] = await Promise.all([api('/teams'), api('/users/names')]); } catch (e) { clear(out).append(h('div', { class: 'table-wrap' }, stateFromError(e, 'Settings'))); return; }
  const reload = () => { clear(out); teamsTab(out, ctx); };
  const canEdit = ctx.can('users.manage');
  clear(out).append(
    h('div', { class: 'toolbar' }, h('div', { class: 'grow muted' }, 'Teams own services, dashboards, on-call schedules and incidents.'),
      canEdit ? h('button', { class: 'btn btn-primary', onclick: () => edit(null) }, icon('plus', 15), 'New team') : null),
    teams.length ? h('div', { class: 'card-grid' }, teams.map((t) => h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', {}, t.name), h('div', { class: 'right' },
        canEdit ? h('button', { class: 'icon-btn', title: 'Edit', onclick: () => edit(t) }, icon('edit', 14)) : null,
        canEdit ? h('button', { class: 'icon-btn', title: 'Delete', onclick: async () => {
          if (!(await confirmBox('Delete team', `Delete team "${t.name}"?`, 'Delete'))) return;
          await api(`/teams/${t.id}`, { method: 'DELETE' });
          reload();
        } }, icon('trash', 14)) : null)),
      h('p', { class: 'muted', style: { marginTop: 0 } }, t.description || ''),
      h('div', { class: 'chips' }, t.members.length ? t.members.map((m) => h('span', { class: 'pill pill-muted' }, m.displayName || m.username)) : h('span', { class: 'dim' }, 'No members'))))) :
      h('div', { class: 'table-wrap' }, h('div', { class: 'empty' }, h('div', { class: 'empty-title' }, 'No teams yet'))));

  function edit(team) {
    const name = h('input', { class: 'input', value: team?.name || '' });
    const desc = h('input', { class: 'input', value: team?.description || '' });
    const members = new Set((team?.members || []).map((m) => m.username));
    const list = h('div', { class: 'perm-list', style: { maxHeight: '260px' } }, users.map((u) => h('label', { class: 'check-row' },
      h('input', { type: 'checkbox', checked: members.has(u.username), onchange: (e) => (e.target.checked ? members.add(u.username) : members.delete(u.username)) }),
      u.displayName ? `${u.displayName} (${u.username})` : u.username)));
    modal(team ? `Edit ${team.name}` : 'New team', h('div', {}, field('Name', name), field('Description', desc), h('div', { class: 'field-label' }, 'Members'), list), [
      { label: 'Cancel' },
      { label: 'Save', primary: true, onclick: async () => {
        let id = team?.id;
        if (!id) id = (await api('/teams', { method: 'POST', body: { name: name.value.trim(), description: desc.value.trim() } })).id;
        await api(`/teams/${id}`, { method: 'PUT', body: { name: name.value.trim(), description: desc.value.trim(), members: [...members] } });
        toast('Team saved');
        reload();
      } },
    ]);
  }
}

// ---------------- Security policy ----------------
export async function securityTab(out, ctx) {
  out.append(stateView('loading', { skeleton: 'table' }));
  let s, roles;
  try { [s, roles] = await Promise.all([api('/settings/security'), api('/roles')]); } catch (e) { clear(out).append(h('div', { class: 'table-wrap' }, stateFromError(e, 'Settings'))); return; }
  const required = new Set(s.mfaRequiredRoles || []);
  const ldapUser = h('input', { class: 'input', placeholder: 'username to look up (optional)', style: { width: '240px' } });
  const ldapOut = h('div');
  clear(out).append(h('div', { class: 'grid cols-2' },
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, 'Two-factor sign-in policy')),
      h('p', { class: 'muted', style: { marginTop: 0 } }, 'Users with these roles must set up an authenticator app before they can use the app. Applies to password and LDAP users (SSO users use their provider\'s MFA).'),
      h('div', { class: 'perm-list' }, roles.roles.map((r) => h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', checked: required.has(r.name), onchange: (e) => (e.target.checked ? required.add(r.name) : required.delete(r.name)) }), r.name))),
      h('button', { class: 'btn btn-primary', style: { marginTop: '12px' }, onclick: async () => {
        try { await api('/settings/security', { method: 'PUT', body: { mfaRequiredRoles: [...required] } }); toast('Policy saved'); } catch (e) { toast(e.message, 'err'); }
      } }, 'Save policy')),
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, 'Sessions and lockout')),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Idle sign-out'), h('dd', {}, `${s.session.idleMinutes} minutes`),
        h('dt', {}, 'Maximum session'), h('dd', {}, `${s.session.maxHours} hours`),
        h('dt', {}, 'Lockout'), h('dd', {}, `${s.session.lockoutAfter} wrong passwords → ${s.session.lockoutMinutes} minutes`)),
      h('p', { class: 'dim', style: { fontSize: '12px' } }, 'Change these with SESSION_* and LOCKOUT_* in .env.')),
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, 'Single sign-on')),
      s.sso.length ? h('div', { class: 'chips' }, s.sso.map((p) => h('span', { class: 'pill pill-green' }, `${p.label} on`))) : h('p', { class: 'muted' }, 'No SSO provider is set up.'),
      h('p', { class: 'dim', style: { fontSize: '12px' } }, `Set OIDC_*, GOOGLE_* or GITHUB_* in .env. Redirect URL to register: ${s.publicUrl || location.origin}/api/auth/<oidc|google|github>/callback`)),
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, 'LDAP / Active Directory')),
      s.ldap ? [
        h('dl', { class: 'kv' }, h('dt', {}, 'Server'), h('dd', { class: 'mono' }, s.ldap.url), h('dt', {}, 'Base DN'), h('dd', { class: 'mono' }, s.ldap.baseDn),
          h('dt', {}, 'User filter'), h('dd', { class: 'mono' }, s.ldap.filter), h('dt', {}, 'Group mappings'), h('dd', {}, String(s.ldap.mappings)),
          h('dt', {}, 'Default role'), h('dd', {}, s.ldap.defaultRole || '(none: unmapped users refused)')),
        h('div', { class: 'toolbar', style: { marginTop: '10px' } }, ldapUser, h('button', { class: 'btn', onclick: async () => {
          clear(ldapOut).append(spinner());
          const r = await api('/settings/ldap/test', { method: 'POST', body: { username: ldapUser.value.trim() } }).catch((e) => ({ ok: false, message: e.message }));
          clear(ldapOut).append(r.ok ? h('div', { class: 'ok-box' }, icon('check', 15), h('div', {}, r.message, r.groups ? h('div', { class: 'dim', style: { fontSize: '12px' } }, `Groups: ${r.groups.join('; ') || '-'}`) : null,
            r.groups ? h('div', {}, `Role: ${r.role || 'none (would be refused)'}`) : null)) : errorBox(r.message));
        } }, 'Test')), ldapOut,
      ] : h('p', { class: 'muted' }, 'LDAP is not set up. Set LDAP_URL, LDAP_BASE_DN, LDAP_BIND_DN and LDAP_BIND_PASSWORD in .env.'))));
}

// ---------------- Modules ----------------
// Which product modules this deployment uses. Users see only enabled modules (and only those
// their role allows). Turning a module off hides it everywhere and its API answers 404; saved
// dashboards, queries and preferences are kept and come back when it is turned on again.
export async function modulesTab(out, ctx) {
  out.append(stateView('loading', { skeleton: 'table' }));
  let data;
  try { data = await api('/modules'); } catch (e) { clear(out).append(h('div', { class: 'table-wrap' }, stateFromError(e, 'Settings'))); return; }
  const on = new Set(data.enabled);
  const saveBtn = h('button', { class: 'btn btn-primary', disabled: true }, 'Save');
  const dirty = () => { saveBtn.disabled = [...on].sort().join() === [...data.enabled].sort().join(); };
  const rows = data.catalog.map((m) => {
    const box = h('input', { type: 'checkbox', checked: on.has(m.id), id: `mod-${m.id}`, onchange: (e) => { if (e.target.checked) on.add(m.id); else on.delete(m.id); dirty(); } });
    return h('label', { class: 'module-row', for: `mod-${m.id}` },
      box,
      h('div', { class: 'grow' },
        h('div', { class: 'module-name' }, m.name),
        h('div', { class: 'module-desc' }, m.description),
        h('div', { class: 'module-source' }, `Data source: ${m.source}`)));
  });
  saveBtn.onclick = async () => {
    const turnedOff = data.catalog.filter((m) => data.enabled.includes(m.id) && !on.has(m.id)).map((m) => m.name);
    if (turnedOff.length && !(await confirmBox('Turn off modules?',
      `${turnedOff.join(', ')} will disappear for every user, and their API will stop answering. Saved dashboards, queries and settings are kept.`, 'Turn off'))) return;
    saveBtn.disabled = true;
    try {
      data = await api('/modules', { method: 'PUT', body: { enabled: [...on] } });
      toast('Modules saved');
      await ctx.reloadShell(); // rebuild the menu, search and bell for the new selection
    } catch (e) {
      toast(e.message, 'err');
      dirty();
    }
  };
  clear(out).append(
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', {}, 'Modules for this deployment'), h('div', { class: 'right' }, saveBtn)),
      h('p', { class: 'muted', style: { marginTop: 0 } },
        'Users see only the modules turned on here, and within those only what their role allows. Overview, Data Sources and Settings are always available. ',
        'Turning a module on does not connect its data source: if the source is not reachable, its pages say so.'),
      data.configured ? null : h('div', { class: 'info-box', style: { marginBottom: '12px' } }, icon('alert', 16),
        h('span', {}, 'No selection has been saved yet, so every module is on. Untick the ones this deployment does not use and save.')),
      h('div', { class: 'module-list' }, rows)));
}

// ---------------- Audit log ----------------
const auditFilter = { user: '', action: '' };
export async function auditTab(out) {
  const userIn = h('input', { class: 'input', placeholder: 'User', 'aria-label': 'Filter by user', value: auditFilter.user, style: { width: '160px' } });
  const box = h('div', {}, h('div', { class: 'table-wrap' }, stateView('loading', { skeleton: 'table' })));
  const reload = () => { clear(out); auditTab(out); };
  const LIMIT = 300;
  const actIn = select([['', 'All actions'], ['login', 'Sign-ins'], ['login.failed', 'Failed sign-ins'], ['mfa.', 'Two-factor'], ['user.', 'User changes'], ['role.', 'Roles'], ['team.', 'Teams'], ['apikey.', 'API keys'], ['session.', 'Sessions'],
    ['dashboard.', 'Dashboards'], ['rule.', 'Alert rules'], ['silence.', 'Silences'], ['incident.', 'Incidents'], ['channel.', 'Notification channels'], ['datasource.', 'Data sources'], ['settings.', 'Settings'], ['modules.', 'Modules'], ['access.denied', 'Access denied']],
  auditFilter.action, (v) => { auditFilter.action = v; reload(); }, { class: 'select', 'aria-label': 'Filter by action' });
  userIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { auditFilter.user = userIn.value.trim(); reload(); } });
  out.append(h('div', { class: 'toolbar' }, userIn, actIn, h('button', { class: 'btn', onclick: () => { auditFilter.user = userIn.value.trim(); reload(); } }, 'Filter'),
    h('div', { class: 'grow' }), h('span', { class: 'muted' }, 'Stored in the database')), box);
  try {
    const rows = await api('/audit', { query: { limit: LIMIT, user: auditFilter.user, action: auditFilter.action } });
    const tone = (a) => (a.includes('failed') || a.includes('denied') || a.includes('locked') ? 'red' : a.startsWith('login') ? 'green' : 'blue');
    if (!rows.length) {
      clear(box).append(h('div', { class: 'table-wrap' }, stateView('empty', { title: 'No audit entries match', text: auditFilter.user || auditFilter.action ? 'Clear the user or action filter.' : 'Nothing has been recorded yet.' })));
      return;
    }
    let page = 0;
    const draw = () => {
      const pg = paginate(rows, { page, pageSize: 100, noun: 'entries', onPage: (p) => { page = p; draw(); }, note: rows.length >= LIMIT ? `(newest ${LIMIT} only)` : null });
      page = pg.page;
      clear(box).append(
        // the API returns the newest LIMIT entries: say so instead of implying this is everything
        rows.length >= LIMIT ? stateBanner('partial', `Showing the newest ${LIMIT} entries. Filter by user or action to find older ones.`) : '',
        h('div', { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': 'Audit log entries', style: { maxHeight: 'calc(100vh - 330px)' } }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, [timeHeader(), 'User', 'IP', 'Action', 'Details'].map((x) => h('th', {}, x)))),
      h('tbody', {}, pg.rows.map((r) => {
        const { id, time, user, ip, action, ...rest } = r;
        return h('tr', {}, h('td', { class: 'mono', style: { whiteSpace: 'nowrap' } }, timeEl(Date.parse(time))), h('td', {}, user), h('td', { class: 'mono dim' }, ip),
          h('td', {}, pill(action, tone(action))), h('td', { class: 'mono dim msg', style: { fontSize: '11.5px' }, title: JSON.stringify(rest) }, Object.keys(rest).length ? JSON.stringify(rest) : ''));
      }))), pg.foot));
    };
    draw();
  } catch (e) {
    clear(box).append(h('div', { class: 'table-wrap' }, stateFromError(e, 'Audit log')));
  }
}
