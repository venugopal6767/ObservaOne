// Users & Roles + Settings gate.
import { chromium, BASE, ok, summary, errors, login, settle } from './lib.mjs';
const b = await chromium.launch();
const p = await login(b, 'admin', '', { width: 1366, height: 900 });
const txt = async (sel) => (await p.locator(sel).first().textContent().catch(() => '')) || '';
const active = () => p.locator('.nav-item.active').getAttribute('aria-label');
await p.goto(`${BASE}/settings?tab=profile&range=21600`); await settle(p, 1500);
ok(await active() === 'Settings', 'profile highlights Settings');
ok(await p.locator('#refresh-btn').isDisabled() && /Nothing to refresh/.test(await p.locator('#refresh-btn').getAttribute('title')), 'refresh button disabled with a reason on a form page');
await p.click('.tabs >> text=Users'); await settle(p, 1500);
ok(/tab=users/.test(p.url()) && /range=21600/.test(p.url()) && await active() === 'Users & Roles', `in-page tab switch moves the menu highlight (${await active()})`);
ok(await p.locator('#main select[aria-label^="Role for"]').count() >= 1, 'role pickers have accessible names');
await p.click('.tabs >> text=Roles'); await settle(p, 1500);
ok(await active() === 'Users & Roles', 'Roles keeps Users & Roles highlighted');
await p.click('.tabs >> text=API reference'); await settle(p, 1500);
ok(await active() === 'Settings' && await p.locator('#main input[aria-label="Filter endpoints"]').count() === 1, 'API reference highlights Settings, filter labelled');
await p.goBack(); await settle(p, 1200);
ok(!/\/settings/.test(p.url()), 'tabs replace history, so Back leaves Settings in one step (same as other tabbed pages)');
await p.route('**/api/users', (r) => r.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Database busy' }) }));
await p.goto(`${BASE}/settings?tab=users`); await settle(p, 1500);
ok(await p.locator('[role=alert]:has-text("Database busy")').count() === 1 && await p.locator('#main button:has-text("Try again")').count() === 1, 'users load failure: cause + Try again');
await p.unroute('**/api/users');
await p.click('#main button:has-text("Try again")'); await settle(p, 1800);
ok(await p.locator('#main tbody tr').count() > 0, 'Try again recovers');
await p.setViewportSize({ width: 390, height: 844 });
for (const tab of ['users', 'profile', 'sessions']) {
  await p.goto(`${BASE}/settings?tab=${tab}`); await settle(p, 1800);
  const fit = await p.evaluate(() => [...document.querySelectorAll('.table-wrap')].every((w) => w.scrollWidth <= w.clientWidth + 1) && document.documentElement.scrollWidth <= 391);
  ok(fit, `390px ${tab}: fits`);
}
ok(!/null|undefined/.test(await p.locator('#main').innerText()), 'no stray null text');
ok(!errors.length, `no page errors ${errors.join(' | ')}`);
summary();
await b.close();
