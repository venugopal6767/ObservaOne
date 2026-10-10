// Preview mode: no server. Answers the few /api calls the shell needs with sample data,
// and adds a "Preview as" switch so you can see what each role is allowed to open.
(function () {
  const ROLES = {
    admin: { label: 'Admin', perms: ['*'], dashboards: ['business', 'devops', 'developer', 'sre', 'security', 'appowner', 'itadmin', 'kubernetes'], landing: 'itadmin' },
    operator: { label: 'Operator', dashboards: ['business', 'devops', 'developer', 'sre', 'security', 'appowner', 'kubernetes'], landing: 'devops', perms: ['view', 'dashboards.edit', 'alerts.silence', 'incidents.manage', 'oncall.manage', 'slo.manage', 'synthetics.manage', 'catalog.manage', 'ai.use', 'security.read'] },
    viewer: { label: 'Viewer', perms: ['view'], dashboards: ['business', 'developer', 'appowner'], landing: 'business' },
  };
  // In-page router: the hosted preview is one page, so routes live in memory instead of the address bar.
  // The bundle reads location.pathname / location.search / history.* through this object.
  const a = document.createElement('a');
  a.href = '/';
  // a link like ...#developer opens that dashboard first
  const start = /^#[a-z]+$/.test(location.hash) ? `/views/${location.hash.slice(1)}` : '/views';
  const stack = [{ path: start, search: '' }];
  const cur = () => stack[stack.length - 1];
  const parse = (url) => { const u = new URL(String(url), 'http://preview.local'); return { path: u.pathname, search: u.search }; };
  window.__ooNav = {
    get pathname() { return cur().path; },
    get search() { return cur().search; },
    origin: a.origin,
    get length() { return stack.length; },
    pushState(_s, _t, url) { stack.push(parse(url)); },
    replaceState(_s, _t, url) { stack[stack.length - 1] = parse(url); },
    back() { if (stack.length > 1) { stack.pop(); window.dispatchEvent(new PopStateEvent('popstate')); } },
  };
  let role = 'admin';
  try { role = localStorage.getItem('oo.preview.role') || 'admin'; } catch (e) { /* ignore */ }
  if (!ROLES[role]) role = 'admin';
  const prefs = {};
  const SERVICES = ['checkout', 'payments-api', 'orders', 'catalog', 'search', 'recommendations', 'auth', 'notifications', 'inventory', 'api-gateway'];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input.url;
    const u = new URL(url, 'http://preview.local');
    if (!u.pathname.startsWith('/api/')) return realFetch(input, init);
    const p = u.pathname.slice(4);
    const method = (init && init.method) || 'GET';
    if (p === '/me' && method === 'GET') {
      return Promise.resolve(json({
        user: { username: `${role}.demo`, role, permissions: ROLES[role].perms, displayName: `${ROLES[role].label} (preview)`, authSource: 'local', email: `${role}@example.local`, dashboards: ROLES[role].dashboards, landing: ROLES[role].landing },
        brand: 'ObservaOne', version: '1.8.2 (preview)', sessionIdleMinutes: 60, grafanaUrl: null, rulesEditable: false, prefs, teams: [{ id: 1, name: 'Payments' }],
      }));
    }
    if (p === '/me/prefs') { try { Object.assign(prefs, JSON.parse(init.body)); } catch (e) { /* ignore */ } return Promise.resolve(json({ ok: true })); }
    if (p === '/datasources') return Promise.resolve(json([{ id: 'prometheus', mode: 'demo' }]));
    if (p === '/alerts/count') return Promise.resolve(json({ active: 5, critical: 2 }));
    if (p === '/incidents/count') return Promise.resolve(json({ active: 3 }));
    if (p === '/services') return Promise.resolve(json({ list: SERVICES.map((name) => ({ name })) }));
    if (p === '/prom/metric-names') return Promise.resolve(json(['up', 'node_cpu_seconds_total', 'http_server_request_duration_seconds']));
    if (p === '/dashboards') return Promise.resolve(json([]));
    if (p === '/logout') return Promise.resolve(json({ ok: true }));
    return Promise.resolve(json({ error: 'This page needs the ObservaOne server. The preview only includes the role dashboards (My Dashboard).' }, 503));
  };

  // floating role switch + banner
  function bar() {
    if (document.getElementById('preview-bar')) return;
    const b = document.createElement('div');
    b.id = 'preview-bar';
    b.innerHTML = '<b>Preview</b><span>sample data, no server</span><label>View as <select aria-label="Preview role">'
      + Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${k === role ? 'selected' : ''}>${v.label}</option>`).join('') + '</select></label>';
    b.querySelector('select').addEventListener('change', (e) => {
      try { localStorage.setItem('oo.preview.role', e.target.value); } catch (err) { /* ignore */ }
      location.reload();
    });
    document.body.appendChild(b);
  }
  const css = document.createElement('style');
  css.textContent = '#preview-bar{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:300;display:flex;align-items:center;gap:10px;padding:7px 12px;border-radius:20px;background:#1e293b;color:#e2e8f0;font:12px Inter,system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);border:1px solid #334155}'
    + '#preview-bar b{color:#fbbf24}#preview-bar span{color:#94a3b8}#preview-bar select{margin-left:6px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:2px 6px}';
  document.head.appendChild(css);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bar); else bar();
})();
