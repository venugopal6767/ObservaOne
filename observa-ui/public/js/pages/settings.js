import { errorState } from '../personas/widgets.js';
import { h, api, clear, icon, errorBox, spinner, tabs, modal, field, select, toast, confirmBox, dateTime, ago, pill } from '../ui.js';
import { mfaSetupFlow, showRecovery } from './mfa.js';
import { usersTab, rolesTab, teamsTab, securityTab, auditTab, browserName } from './settings-admin.js';

export function settingsPage(main, ctx) {
  const TABS = [
    ['profile', 'My profile', null],
    ['sessions', 'Sessions', null],
    ['apikeys', 'API keys', null],
    ['users', 'Users', 'users.manage'],
    ['roles', 'Roles', 'users.manage'],
    ['teams', 'Teams', null],
    ['security', 'Security', 'settings.manage'],
    ['audit', 'Audit log', 'audit.read'],
    ['api', 'API reference', null],
    ['about', 'About', null],
  ].filter(([, , p]) => !p || ctx.can(p));
  let tab = ctx.params.get('tab') || 'profile';
  if (!TABS.some(([k]) => k === tab)) tab = 'profile';
  const tabsEl = h('div', { class: 'tabs-scroll' });
  const out = h('div', { style: { marginTop: '14px' } });
  main.append(h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Settings'), h('p', {}, 'Your account, security, users, roles, teams and API access'))), tabsEl, out);

  function drawTabs() {
    // a tab change is a route change, so the menu highlight (Users & Roles vs Settings), env and range stay right
    clear(tabsEl).append(tabs(TABS.map(([k, l]) => [k, l]), tab, (k) => ctx.navigate(ctx.link('/settings', { tab: k }), true)));
  }

  function show() {
    clear(out);
    const t = { profile, sessions, apikeys, about, api: apiRef,
      users: () => usersTab(out, ctx), roles: () => rolesTab(out, ctx), teams: () => teamsTab(out, ctx),
      security: () => securityTab(out, ctx), audit: () => auditTab(out, ctx) }[tab];
    t();
  }

  // ---------------- profile: details, password, two-factor ----------------
  async function profile() {
    const me = await ctx.reloadMe().catch(() => ctx.me);
    const u = me.user;
    const local = u.authSource === 'local';
    const email = h('input', { class: 'input', type: 'email', value: u.email || '' });
    const display = h('input', { class: 'input', value: u.displayName || '' });
    const phone = h('input', { class: 'input', type: 'tel', value: u.phone || '', placeholder: '+91 98450 00000' });
    const details = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, 'Account')),
      h('dl', { class: 'kv', style: { marginBottom: '14px' } },
        h('dt', {}, 'Username'), h('dd', {}, u.username),
        h('dt', {}, 'Role'), h('dd', {}, u.role),
        h('dt', {}, 'Signs in with'), h('dd', {}, { local: 'Username and password', ldap: 'Company directory (LDAP)', oidc: 'Single sign-on', google: 'Google', github: 'GitHub' }[u.authSource] || u.authSource),
        h('dt', {}, 'Last sign-in'), h('dd', {}, u.lastLogin ? dateTime(Date.parse(u.lastLogin)) : '-'),
        h('dt', {}, 'Session'), h('dd', {}, `Signs out after ${me.sessionIdleMinutes} minutes without activity`)),
      field('Display name', display),
      u.email ? null : h('div', { class: 'error-box warn', style: { marginBottom: '10px' } }, icon('alert', 16), h('span', {}, 'Add your e-mail address, otherwise you get no alert or incident notifications.')),
      field(local ? 'E-mail (required)' : 'E-mail', email, 'Used for alert and incident notifications.'),
      field('Mobile number', phone, 'For on-call SMS/voice paging (if your admin set it up).'),
      h('button', { class: 'btn btn-primary', onclick: async (e) => {
        e.target.disabled = true;
        try {
          await api('/me/profile', { method: 'PUT', body: { email: email.value.trim(), displayName: display.value.trim(), phone: phone.value.trim() } });
          toast('Profile saved');
        } catch (err) { toast(err.message, 'err'); } finally { e.target.disabled = false; }
      } }, 'Save'));

    const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
    const n1 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    const n2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    const password = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, 'Password')),
      local ? [
        field('Current password', cur), field('New password', n1, '12+ characters with upper case, lower case, a number and a symbol.'), field('Repeat new password', n2),
        h('button', { class: 'btn btn-primary', onclick: async (e) => {
          if (n1.value !== n2.value) return toast('New passwords do not match', 'err');
          e.target.disabled = true;
          try {
            await api('/me/password', { method: 'POST', body: { current: cur.value, next: n1.value } });
            cur.value = n1.value = n2.value = '';
            toast('Password changed. Other sessions were signed out.');
          } catch (err) { toast(err.message, 'err'); } finally { e.target.disabled = false; }
        } }, 'Change password'),
      ] : h('p', { class: 'muted' }, `Your password is managed by ${u.authSource === 'ldap' ? 'the company directory' : 'your sign-in provider'}.`));

    const mfaBox = h('div');
    const mfa = h('section', { class: 'panel', style: { gridColumn: '1 / -1' } },
      h('div', { class: 'panel-head' }, h('h3', {}, 'Two-factor sign-in'), h('div', { class: 'right' }, u.mfaEnabled ? pill('On', 'green') : pill('Off', 'muted'))), mfaBox);
    const drawMfa = () => {
      clear(mfaBox);
      if (!['local', 'ldap'].includes(u.authSource)) {
        mfaBox.append(h('p', { class: 'muted' }, 'Two-factor sign-in for your account is handled by your single sign-on provider.'));
      } else if (!u.mfaEnabled) {
        mfaBox.append(h('p', {}, 'Protect your account with a code from an authenticator app on your phone, in addition to your password.'),
          h('button', { class: 'btn btn-primary', onclick: () => mfaSetupFlow(mfaBox, { compact: true, onDone: () => { toast('Two-factor sign-in is on'); show(); } }) }, icon('shield', 14), 'Set up two-factor sign-in'));
      } else {
        const code = h('input', { class: 'input mono', inputmode: 'numeric', maxlength: 6, placeholder: '123456', style: { width: '120px' } });
        const pw = h('input', { class: 'input', type: 'password', placeholder: local ? 'Password' : '(not needed)', disabled: !local, style: { width: '180px' } });
        mfaBox.append(
          h('p', {}, 'You enter a code from your authenticator app each time you sign in.'),
          h('div', { class: 'toolbar' },
            h('span', { class: 'muted' }, 'Current code'), code,
            h('button', { class: 'btn', onclick: async () => {
              try {
                const r = await api('/me/mfa/recovery-codes', { method: 'POST', body: { code: code.value.trim() } });
                showRecovery(mfaBox, r.recoveryCodes, () => show(), true);
              } catch (e) { toast(e.message, 'err'); }
            } }, 'New recovery codes'),
            pw,
            h('button', { class: 'btn btn-danger', onclick: async () => {
              if (!(await confirmBox('Turn off two-factor sign-in', 'Your account will be protected by the password only.', 'Turn off'))) return;
              try {
                await api('/me/mfa/disable', { method: 'POST', body: { code: code.value.trim(), password: pw.value } });
                toast('Two-factor sign-in turned off');
                show();
              } catch (e) { toast(e.message, 'err'); }
            } }, 'Turn off')));
      }
    };
    drawMfa();
    clear(out).append(h('div', { class: 'grid cols-2' }, details, password, mfa));
  }

  // ---------------- my sessions (and all, for user admins) ----------------
  async function sessions() {
    out.append(h('div', { class: 'table-wrap skeleton', style: { height: '240px' } }));
    const isAdmin = ctx.can('users.manage');
    try {
      const [mine, all] = await Promise.all([api('/me/sessions'), isAdmin ? api('/sessions') : Promise.resolve(null)]);
      clear(out).append(
        h('h3', { class: 'section-title' }, 'My sign-ins'),
        sessionTable(mine, false),
        all ? h('h3', { class: 'section-title', style: { marginTop: '22px' } }, `All active sign-ins (${all.length})`) : null,
        all ? sessionTable(all, true) : null);
    } catch (e) {
      clear(out).append(errorState(e.message, () => ctx.navigate(location.pathname + location.search, true), 'This section could not load'));
    }
  }

  function sessionTable(list, adminView) {
    if (!list.length) return h('div', { class: 'table-wrap' }, h('div', { class: 'empty' }, 'No active sign-ins.'));
    return h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, [adminView ? ['User', ''] : null, ['Browser', ''], ['Method', 'col-phone-hide'], ['IP', 'col-phone-hide'], ['Signed in', 'col-phone-hide'], ['Last active', ''], ['Expires', 'col-phone-hide'], [h('span', { class: 'sr-only' }, 'Actions'), '']].filter(Boolean).map(([x, c]) => h('th', { class: c }, x)))),
      h('tbody', {}, list.map((s) => h('tr', {},
        adminView ? h('td', {}, h('b', { style: { fontWeight: 600 } }, s.username)) : null,
        h('td', { title: s.userAgent || '' }, browserName(s.userAgent), s.current ? h('span', { style: { marginLeft: '8px' } }, pill('this browser', 'blue')) : null, s.persistent ? h('span', { style: { marginLeft: '6px' } }, pill('remembered', 'muted')) : null),
        h('td', { class: 'col-phone-hide' }, s.method),
        h('td', { class: 'mono col-phone-hide' }, s.ip || '—'),
        h('td', { class: 'dim col-phone-hide' }, ago(s.createdAt)),
        h('td', { class: 'dim' }, ago(s.lastSeen)),
        h('td', { class: 'dim mono col-phone-hide' }, dateTime(Date.parse(s.expiresAt)).slice(0, 16)),
        h('td', {}, s.current ? null : h('button', { class: 'btn btn-sm', onclick: async () => {
          if (!(await confirmBox('Sign out session', `Sign out ${adminView ? `${s.username} on ` : ''}${browserName(s.userAgent)} (${s.ip})?`, 'Sign out'))) return;
          try { await api(adminView ? `/sessions/${s.id}` : `/me/sessions/${s.id}`, { method: 'DELETE' }); toast('Session ended'); } catch (e) { toast(e.message, 'err'); }
          show();
        } }, 'Sign out')))))));
  }

  // ---------------- API keys ----------------
  async function apikeys() {
    const isAdmin = ctx.can('users.manage');
    let showAll = false;
    const box = h('div', {}, spinner());
    const head = h('div', { class: 'toolbar' },
      h('div', { class: 'grow muted' }, 'API keys let scripts, CI pipelines and other tools use the API. A key never has more rights than its owner.'),
      isAdmin ? h('label', { class: 'check-row' }, h('input', { type: 'checkbox', onchange: (e) => { showAll = e.target.checked; load(); } }), 'Show all users\' keys') : null,
      h('button', { class: 'btn btn-primary', onclick: create }, icon('plus', 15), 'New API key'));
    out.append(head, box);

    async function load() {
      try {
        const keys = await api('/apikeys', { query: { all: showAll ? 1 : '' } });
        clear(box).append(keys.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, ['Name', 'Key', 'Role', 'Owner', 'Created', 'Last used', 'Expires', 'Status', ''].map((x) => h('th', {}, x)))),
          h('tbody', {}, keys.map((k) => h('tr', {},
            h('td', {}, h('b', { style: { fontWeight: 600 } }, k.name)),
            h('td', { class: 'mono dim' }, k.display),
            h('td', {}, k.role), h('td', {}, k.owner),
            h('td', { class: 'dim' }, ago(k.createdAt)),
            h('td', { class: 'dim' }, k.lastUsed ? ago(k.lastUsed) : 'never'),
            h('td', { class: 'dim' }, k.expiresAt ? dateTime(Date.parse(k.expiresAt)).slice(0, 10) : 'never'),
            h('td', {}, k.revoked ? pill('Revoked', 'muted') : k.expired ? pill('Expired', 'orange') : pill('Active', 'green')),
            h('td', {}, k.revoked ? null : h('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
              if (!(await confirmBox('Revoke API key', `Revoke "${k.name}"? Anything using it stops working at once.`, 'Revoke'))) return;
              await api(`/apikeys/${k.id}`, { method: 'DELETE' });
              toast('Key revoked');
              load();
            } }, 'Revoke'))))))) : h('div', { class: 'table-wrap' }, h('div', { class: 'empty' }, h('div', { class: 'empty-title' }, 'No API keys yet'))));
      } catch (e) {
        clear(box).append(errorState(e.message, () => load(), 'API keys could not load'));
      }
    }

    async function create() {
      const roles = (await api('/roles')).roles.filter((r) => ctx.can('*') || r.permissions.every((p) => ctx.can(p)));
      const name = h('input', { class: 'input', placeholder: 'e.g. jenkins-deploy' });
      let role = roles.find((r) => r.name === 'viewer') ? 'viewer' : roles[0]?.name;
      let days = '90';
      let svc = false;
      modal('New API key', h('div', {},
        field('Name', name, 'What will use this key?'),
        h('div', { class: 'form-row' },
          field('Role', select(roles.map((r) => [r.name, r.name]), role, (v) => { role = v; })),
          field('Expires', select([['30', 'in 30 days'], ['90', 'in 90 days'], ['365', 'in 1 year'], ['', 'never']], days, (v) => { days = v; }))),
        isAdmin ? h('label', { class: 'check-row' }, h('input', { type: 'checkbox', onchange: (e) => { svc = e.target.checked; } }), 'Service account (not tied to me; keeps working if I leave)') : null), [
        { label: 'Cancel' },
        { label: 'Create', primary: true, onclick: async () => {
          const r = await api('/apikeys', { method: 'POST', body: { name: name.value.trim(), role, expiresDays: days ? Number(days) : null, serviceAccount: svc } });
          showKey(r.key);
          load();
        } },
      ]);
    }

    function showKey(key) {
      modal('Copy your API key now', h('div', {},
        h('p', {}, 'This is the only time the key is shown. Store it in your CI secret store or password manager.'),
        h('pre', { class: 'code', style: { wordBreak: 'break-all' } }, key),
        h('button', { class: 'btn', onclick: () => navigator.clipboard?.writeText(key).then(() => toast('Copied')) }, 'Copy'),
        h('p', { class: 'muted', style: { marginTop: '12px' } }, 'Use it like this:'),
        h('pre', { class: 'code' }, `curl -H "Authorization: Bearer ${key.slice(0, 14)}..." \\\n  ${location.origin}/api/alerts`)), [{ label: 'Done', primary: true }]);
    }
    load();
  }

  // ---------------- API reference ----------------
  async function apiRef() {
    out.append(h('div', { class: 'table-wrap skeleton', style: { height: '240px' } }));
    try {
      const d = await api('/docs');
      const filter = h('input', { class: 'input', type: 'search', placeholder: 'Filter endpoints...', 'aria-label': 'Filter endpoints', style: { width: '260px' } });
      const body = h('tbody');
      const draw = () => {
        const f = filter.value.toLowerCase();
        clear(body).append(...d.routes.filter((r) => !f || `${r.method} ${r.path} ${r.permission} ${r.description}`.toLowerCase().includes(f)).map((r) => h('tr', {},
          h('td', {}, pill(r.method, { GET: 'green', POST: 'blue', PUT: 'orange', DELETE: 'red' }[r.method] || 'muted')),
          h('td', { class: 'mono' }, r.path), h('td', { class: 'mono dim col-phone-hide' }, r.permission), h('td', { class: 'muted' }, r.description))));
      };
      filter.addEventListener('input', draw);
      clear(out).append(
        h('div', { class: 'info-box' }, icon('key', 16), h('span', {}, d.auth)),
        h('div', { class: 'toolbar' }, filter, h('div', { class: 'grow' }), h('span', { class: 'muted' }, `${d.routes.length} endpoints`)),
        h('div', { class: 'table-wrap', style: { maxHeight: 'calc(100vh - 300px)' } }, h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, ['Method', 'Path', 'Permission', 'Description'].map((x, i) => h('th', { class: i === 2 ? 'col-phone-hide' : '' }, x)))), body)));
      draw();
    } catch (e) {
      clear(out).append(errorState(e.message, () => ctx.navigate(location.pathname + location.search, true), 'This section could not load'));
    }
  }

  function about() {
    out.append(h('section', { class: 'panel' }, h('dl', { class: 'kv' },
      h('dt', {}, 'Product'), h('dd', {}, `${ctx.me.brand} monitoring UI`),
      h('dt', {}, 'Metrics'), h('dd', {}, 'Prometheus'),
      h('dt', {}, 'Alerts'), h('dd', {}, 'Prometheus rules + Alertmanager'),
      h('dt', {}, 'Logs / Traces'), h('dd', {}, 'Loki / Tempo (see Data Sources)'),
      h('dt', {}, 'App database'), h('dd', {}, 'PostgreSQL'),
      h('dt', {}, 'Grafana'), h('dd', {}, h('a', { href: ctx.me.grafanaUrl, target: '_blank', rel: 'noopener' }, 'Open Grafana ', icon('external', 12))),
      h('dt', {}, 'Keyboard'), h('dd', {}, 'Press / to search'))));
  }

  drawTabs();
  show();
  return {};
}
