import { chromium, BASE, ok, summary, errors, login, settle, SP } from './lib.mjs';
const b = await chromium.launch();
const p = await login(b, 'admin', 'Admin-Pass-2026!');
const activeLabel = () => p.evaluate(() => [...document.querySelectorAll('.nav-item.active')].map((a) => a.getAttribute('aria-label')).join('|'));
// menu groups and active item
const groups = await p.locator('.nav-group').allInnerTexts();
ok(['Observe', 'Investigate', 'Analyze', 'Manage'].every((g) => groups.map((x) => x.toLowerCase()).includes(g.toLowerCase())), `menu groups: ${groups.join(', ')}`);
await p.goto(BASE + '/views/kubernetes'); await settle(p);
ok(await activeLabel() === 'Kubernetes', `/views/kubernetes highlights Kubernetes (${await activeLabel()})`);
await p.goto(BASE + '/views/sre'); await settle(p);
ok(await activeLabel() === 'Home', `/views/sre highlights Home (${await activeLabel()})`);
await p.goto(BASE + '/settings?tab=users'); await settle(p);
ok(await activeLabel() === 'Users & Roles', `users tab highlights Users & Roles (${await activeLabel()})`);
await p.goto(BASE + '/settings?tab=profile'); await settle(p);
ok(await activeLabel() === 'Settings', `profile tab highlights Settings (${await activeLabel()})`);
ok(await p.locator('.nav-item[aria-current=page]').count() === 1, 'one aria-current item');
await p.click('.nav-item[aria-label="Alert Rules"]'); await settle(p);
ok(p.url().includes('/alerting'), 'Alert Rules opens /alerting');
// collapse
await p.click('#nav-collapse'); await settle(p, 900);
const w = await p.evaluate(() => document.querySelector('.sidebar').getBoundingClientRect().width);
ok(w <= 70, `collapsed sidebar width ${w}`);
await p.reload(); await p.waitForSelector('.topbar'); await settle(p, 1200);
ok(await p.locator('.shell.nav-collapsed').count() === 1, 'collapse remembered after reload');
await p.screenshot({ path: `${SP}/persona/shell-collapsed.png` });
await p.click('#nav-collapse'); await settle(p, 900);
ok(await p.locator('.shell.nav-collapsed').count() === 0, 'expand again');
// auto refresh + freshness
await p.goto(BASE + '/overview'); await settle(p, 2500);
ok(/Updated/.test(await p.locator('#fresh-chip').textContent()), `freshness chip: ${await p.locator('#fresh-chip').textContent()}`);
await p.selectOption('#auto-refresh', '0'); await settle(p, 900);
ok(/off/i.test(await p.locator('#fresh-chip').getAttribute('title')), 'auto-refresh off reflected in tooltip');
const me = await p.evaluate(async () => (await (await fetch('/api/me', { headers: { 'X-Requested-With': 'observa' } })).json()).prefs);
ok(me.autoRefresh === 0, `autoRefresh pref saved (${me.autoRefresh})`);
await p.selectOption('#auto-refresh', '15000'); await settle(p, 900);
let calls = 0; p.on('request', (r) => { if (r.url().includes('/api/overview')) calls++; });
await p.waitForTimeout(16500);
ok(calls >= 1, `15s auto-refresh reloads overview (${calls} calls)`);
await p.selectOption('#auto-refresh', ''); await settle(p, 900);
// help
await p.click('.help-wrap .icon-btn'); await settle(p, 400);
await p.click('.help-wrap button:has-text("Keyboard shortcuts")'); await settle(p, 400);
ok(await p.locator('.modal kbd').count() >= 3, 'shortcuts dialog');
await p.keyboard.press('Escape'); await settle(p, 300);
await p.click('.help-wrap .icon-btn'); await p.click('.help-wrap button:has-text("About")'); await settle(p, 400);
ok(/Version/.test(await p.locator('.modal').innerText()) && /\d+\.\d+\.\d+/.test(await p.locator('.modal').innerText()), 'about shows version');
await p.keyboard.press('Escape');
// command search
await p.keyboard.press('Control+k'); await p.keyboard.type('kubernetes'); await settle(p, 1500);
const kinds = await p.locator('.search-results button .kind').allInnerTexts();
ok(kinds.includes('Dashboard'), `search finds dashboards (${[...new Set(kinds)].join(',')})`);
await p.fill('.search input', 'theme'); await settle(p, 800);
ok((await p.locator('.search-results button').allInnerTexts()).some((t) => /theme/i.test(t)), 'search finds theme action');
const th0 = await p.evaluate(() => document.documentElement.dataset.theme);
await p.keyboard.press('Enter'); await settle(p, 900);
ok(await p.evaluate(() => document.documentElement.dataset.theme) !== th0, 'theme action works');
await p.keyboard.press('Control+k'); await p.keyboard.type('theme'); await settle(p, 800); await p.keyboard.press('Enter'); await settle(p, 900);
// overview attention + context
await p.goto(BASE + '/overview'); await settle(p, 2500);
ok(await p.locator('.ov-attn .attn, .ov-attn .attn-clear').count() === 1, 'overview attention strip');
if (await p.locator('.attn-more').count()) {
  const n0 = await p.locator('.ov-attn .attn-item').count();
  await p.click('.attn-more'); await settle(p, 300);
  ok(await p.locator('.ov-attn .attn-item').count() > n0, `"Show more" reveals the rest (${n0} -> ${await p.locator('.ov-attn .attn-item').count()})`);
}
ok(/Environment: .* Time range: .* Data as of/.test(await p.locator('.ov-context').innerText()), `overview context: ${await p.locator('.ov-context').innerText()}`);
// keyboard focus ring visible
await p.keyboard.press('Tab'); await p.keyboard.press('Tab');
const ring = await p.evaluate(() => getComputedStyle(document.activeElement).boxShadow);
ok(ring && ring !== 'none', 'focus ring visible on keyboard focus');
// viewer does not see Users & Roles, dt_viewer sees Kubernetes only if role allows
const v = process.env.VIEWER_USER ? await login(b, process.env.VIEWER_USER, process.env.VIEWER_PASS) : null;
if (v) {
ok(await v.locator('.nav-item[aria-label="Users & Roles"]').count() === 0, 'viewer: no Users & Roles');
await v.goto(BASE + '/settings?tab=profile'); await settle(v, 1200);
ok(await v.locator('text=No access').count() === 0, 'viewer can open own Settings');
ok(await v.locator('.nav-item.active').getAttribute('aria-label') === 'Settings', 'viewer: Settings highlighted');
} else console.log('SKIP viewer checks (set VIEWER_USER / VIEWER_PASS to a user with the viewer role)');
// phone drawer
const m = await login(b, 'admin', 'Admin-Pass-2026!', { width: 390, height: 844 });
await m.goto(BASE + '/overview'); await settle(m, 2000);
const sw = await m.evaluate(() => document.documentElement.scrollWidth);
ok(sw <= 392, `phone: no sideways scroll (${sw})`);
ok(await m.locator('#nav-burger').isVisible(), 'phone: menu button visible');
const offscreen = await m.evaluate(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 1);
ok(offscreen, 'phone: menu hidden until opened');
await m.click('#nav-burger'); await settle(m, 500);
await m.screenshot({ path: `${SP}/persona/shell-phone-drawer.png` });
ok(await m.locator('.nav-item[aria-label="Logs"] .label').isVisible(), 'phone: drawer shows labels');
await m.click('.nav-item[aria-label="Logs"]'); await settle(m, 1200);
ok(m.url().includes('/logs') && await m.locator('.shell.nav-open').count() === 0, 'phone: link navigates and closes drawer');
ok(!errors.length, `no page errors ${errors.join(' | ')}`);
summary();
await b.close();
