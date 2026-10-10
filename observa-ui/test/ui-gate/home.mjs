// Home (role landing dashboard) gate: landing, sample labelling, states, layout per width, context, Back/Forward.
import { chromium, BASE, ok, summary, errors, login, settle, SP } from './lib.mjs';
const OUT = process.env.OUT || 'after';
const b = await chromium.launch();
const p = await login(b, 'admin', '', { width: 1366, height: 900 });
// landing: /views opens the role's dashboard and highlights Home
await p.goto(BASE + '/views'); await settle(p, 2200);
ok(/\/views\/[a-z]+/.test(p.url()), `Home opens a role dashboard (${p.url().replace(BASE, '')})`);
ok(await p.locator('.nav-item.active').getAttribute('aria-label') === 'Home', 'Home is highlighted');
ok(await p.locator('.sample-banner .sample-tag').count() === 1, 'Sample-data banner');
ok(await p.locator('#fresh-chip').evaluate((e) => e.classList.contains('hidden')), 'top bar does not claim "Updated" for sample data');
ok(/Redraw/.test(await p.locator('#refresh-btn').getAttribute('title')), 'refresh button says it redraws sample data');
const home = p.url().split('?')[0];
// states
await p.goto(home + '?mock=error'); await settle(p, 1500);
await p.screenshot({ path: `${SP}/gate/${OUT}/state-home-error.png` });
ok(await p.locator('.state-box .state-ic.err').count() === 1 && await p.locator('.state-box button:has-text("Try again")').count() === 1, 'error state with Try again');
await p.goto(home + '?mock=empty'); await settle(p, 1500);
ok(await p.locator('.state-box, .empty').count() >= 1, 'empty state');
await p.goto(home); await p.waitForTimeout(120);
ok(await p.locator('.skeleton').count() > 0, 'loading skeleton');
await settle(p, 1500);
// context: drill-down keeps env + range, Back/Forward
await p.goto(home + '?env=production&range=21600'); await settle(p, 2000);
const link = p.locator('#main a[data-link][href*="/views/"]').first();
const href = await link.getAttribute('href');
ok(href && href.includes('env=production') && href.includes('range=21600'), `drill-down link keeps env and range (${href})`);
await link.click(); await settle(p, 1500);
const deep = p.url();
await p.goBack(); await settle(p, 1500);
ok(p.url().split('?')[0] === home && /env=production/.test(p.url()), 'Back returns to Home with env');
await p.goForward(); await settle(p, 1200);
ok(p.url() === deep, 'Forward returns to the drill-down');
// layout per width: no sideways scroll, KPI columns
for (const [w, cols] of [[390, 2], [768, 3], [1366, 6], [1920, 6]]) {
  await p.setViewportSize({ width: w, height: 900 }); await p.goto(home); await settle(p, 1800);
  const r = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cols: getComputedStyle(document.querySelector('.persona-kpis-6') || document.body).gridTemplateColumns.split(' ').length }));
  ok(r.sw <= w + 1, `${w}px: no sideways scroll (${r.sw})`);
  ok(r.cols === cols, `${w}px: ${cols} KPI cards per row (${r.cols})`);
}
ok(!errors.length, `no page errors ${errors.join(' | ')}`);
summary();
await b.close();
