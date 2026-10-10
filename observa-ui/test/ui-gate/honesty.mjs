import { chromium, BASE, ok, summary, errors, login, settle, SP } from './lib.mjs';
const b = await chromium.launch();
const p = await login(b, 'admin', 'Admin-Pass-2026!');
for (const id of ['business', 'devops', 'developer', 'sre', 'security', 'appowner', 'itadmin', 'kubernetes']) {
  await p.goto(`${BASE}/views/${id}`); await settle(p, 1500);
  ok(await p.locator('.sample-banner .sample-tag').count() === 1, `${id}: sample data banner`);
}
await p.goto(`${BASE}/views/kubernetes`); await settle(p, 1500);
const live = p.locator('.sample-banner a').first();
const href = await live.getAttribute('href');
ok(href && href.includes('/dashboards/kubernetes-cluster'), `kubernetes banner links live dashboard (${href})`);
await p.goto(`${BASE}/views/sre`); await settle(p, 1500);
ok(/kept only in this browser tab/.test(await p.locator('.sample-banner').innerText()), 'sre banner says changes stay in this tab');
await p.screenshot({ path: `${SP}/v18/sample-banner-sre.png` });
// every unavailable action: locked, says why, changes nothing
const pages = ['/views/devops', '/views/kubernetes', '/views/itadmin', '/views/sre', '/views/business', '/views/developer'];
let locked = 0;
for (const path of pages) {
  await p.goto(BASE + path); await settle(p, 1500);
  const n = await p.locator('.btn-unavail, .qa-unavail').count();
  locked += n;
  if (n) {
    const url0 = p.url();
    await p.locator('.btn-unavail, .qa-unavail').first().dispatchEvent('click'); await settle(p, 400);
    ok(await p.locator('.toast:has-text("not available yet")').count() >= 1 && p.url() === url0 && await p.locator('.modal').count() === 0, `${path}: locked action explains and changes nothing`);
  }
}
ok(locked >= 4, `locked actions found on dashboards (${locked})`);
// no "(demo)" fake-success toasts left in the code paths we can reach
ok(!errors.length, `no page errors ${errors.join('|')}`);
summary();
await b.close();
