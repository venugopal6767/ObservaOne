// Honest signals + removals gate (audit batch 1, v1.8.4):
// idle service = "No traffic" not Down; exporter failure = "Not reporting" not host DOWN;
// no Grafana links; no top-bar dashboard selector; role dashboards listed on the Dashboards page.
import { chromium, BASE, ok, summary, errors, login, settle } from './lib.mjs';
const b = await chromium.launch();
const p = await login(b, 'admin', '', { width: 1366, height: 900 });
const txt = async (sel) => (await p.locator(sel).first().innerText().catch(() => '')) || '';
const IDLE = { name: 'zz-idle-svc', namespace: '', rps: 0, errorRate: 0, p95: null, status: 'down' };
const DEAD = { name: 'zz-broken-svc', namespace: '', rps: 3, errorRate: 40, p95: 120, status: 'down' };
// add one idle and one really failing service to whatever the server returns
const addServices = (d) => {
  if (!d?.list) return d;
  const list = [...d.list, IDLE, DEAD];
  return { ...d, list, summary: { ...d.summary, total: list.length, down: (d.summary.down || 0) + 2 } };
};
await p.route('**/api/services', async (r) => { const res = await r.fetch(); r.fulfill({ response: res, json: addServices(await res.json()) }); });
await p.route('**/api/overview?*', async (r) => { const res = await r.fetch(); const j = await res.json(); r.fulfill({ response: res, json: { ...j, services: addServices(j.services), hostsDown: ['zz-host-1'], hosts: { ...j.hosts, unhealthy: 1 } } }); });
await p.route('**/api/services/zz-idle-svc*', (r) => r.fulfill({ json: { demo: false, service: IDLE, uptime: 0, series: { rps: [], errorRate: [], p95: [] }, dependencies: { calls: [], calledBy: [], known: false } } }));
await p.route('**/api/prom/targets', async (r) => { const res = await r.fetch(); const j = await res.json();
  r.fulfill({ response: res, json: [...j, { job: 'linux', instance: '10.0.0.9:9100', host: 'zz-host-1', os: 'linux', env: '', role: '', health: 'down', lastScrape: null, durationMs: 0, lastError: 'connection refused', source: 'pull' }] }); });

// --- services list
await p.goto(`${BASE}/services`); await settle(p, 2000);
const idleRow = p.locator('#main tbody tr', { hasText: 'zz-idle-svc' });
const deadRow = p.locator('#main tbody tr', { hasText: 'zz-broken-svc' });
ok(/No traffic/.test(await idleRow.innerText()), 'idle service shows "No traffic"');
ok(/Down/.test(await deadRow.innerText()), 'failing service still shows "Down"');
ok(/no traffic right now/.test(await txt('#main')), 'services: note explains No traffic');
await p.click('#main button:has-text("Show only these")'); await settle(p, 300);
ok(/status=idle/.test(p.url()) && await p.locator('#main tbody tr').count() === 1, 'filter to idle services (in URL)');
// --- service detail
await p.goto(`${BASE}/services/zz-idle-svc`); await settle(p, 1500);
const head = await txt('.detail-head');
ok(/No traffic/.test(head) && !/Unhealthy/.test(head), 'detail: No traffic, not Unhealthy');
ok(/Uptime\s*No data/.test(await txt('#main .grid')), 'detail: uptime not shown as 0% for an idle service');
// --- overview
await p.goto(`${BASE}/overview`); await settle(p, 2500);
const ov = await txt('#main');
ok(/no traffic/i.test(ov), 'overview: idle services counted as no traffic');
ok(/not reporting \(exporter not answering\)/.test(ov) && !/not responding/.test(ov), 'overview: hosts "not reporting", not "not responding"');
ok(/1 not reporting/.test(await txt('.kpi'), ) && !/unhealthy/.test(await txt('.kpi')), 'overview: host KPI says not reporting');
// --- infrastructure
await p.goto(`${BASE}/infrastructure`); await settle(p, 2000);
const hostRow = p.locator('#main tbody tr', { hasText: 'zz-host-1' }).first();
const pillEl = hostRow.locator('.pill');
ok(/NOT REPORTING/.test(await pillEl.innerText()) && /host's own state is unknown/.test(await pillEl.getAttribute('title')), 'infrastructure: NOT REPORTING with explanation');
// --- removals
ok(await p.locator('.dsel, .dsel-btn').count() === 0, 'top bar: no dashboard selector');
await p.goto(`${BASE}/dashboards`); await settle(p, 1500);
const roles = p.locator('nav.role-dash a');
ok(await roles.count() >= 2 && await p.locator('nav.role-dash a', { hasText: 'Overview' }).count() === 1, `dashboards page lists role dashboards (${await roles.count()})`);
ok(await p.locator('nav.role-dash .role-dash-home').count() === 1, 'landing dashboard marked once');
await roles.nth(1).click(); await settle(p, 1200);
ok(/^\/views\//.test(new URL(p.url()).pathname), 'role dashboard link opens it');
for (const path of ['/dashboards/linux-servers', '/dashboards/windows-servers', '/dashboards/infrastructure-overview', '/settings?tab=about']) {
  await p.goto(BASE + path); await settle(p, 1500);
  const n = await p.evaluate(() => [...document.querySelectorAll('a[href]')].filter((a) => /grafana/i.test(a.getAttribute('href'))).length);
  ok(n === 0, `${path}: no Grafana link`);
}
ok(!/null|undefined/.test(await txt('#main')), 'no stray null text');
ok(!errors.length, `no page errors ${errors.join(' | ')}`);
summary();
await b.close();
