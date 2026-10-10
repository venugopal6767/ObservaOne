// Services list + Service detail gate: states, filters in the URL, context, keyboard, phone table, Back/Forward.
import { chromium, BASE, ok, summary, errors, login, settle, SP } from './lib.mjs';
const OUT = process.env.OUT || 'after';
const b = await chromium.launch();
const p = await login(b, 'admin', '', { width: 1366, height: 900 });
const fail = (pattern, msg) => p.route(pattern, (r) => r.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: msg }) }));
const txt = async (sel) => (await p.locator(sel).first().textContent().catch(() => '')) || '';
// ---- list ----
await p.route('**/api/services', async (r) => { await new Promise((s) => setTimeout(s, 1500)); await r.continue().catch(() => {}); });
await p.goto(BASE + '/services'); await p.waitForTimeout(500);
ok(await p.locator('#main .skeleton').count() >= 4, 'list loading: placeholders');
await settle(p, 2000); await p.unroute('**/api/services');
const rows = await p.locator('#main tbody tr').count();
ok(rows > 0, `list live: ${rows} rows`);
await p.waitForTimeout(6000);
await fail('**/api/services', 'Prometheus is not answering');
await p.click('#refresh-btn'); await settle(p, 1000);
await p.screenshot({ path: `${SP}/gate/${OUT}/state-services-stale.png` });
ok(await p.locator('#main tbody tr').count() === rows, 'list refresh failure: rows kept');
ok(/Couldn't refresh/.test(await txt('.stale-notice')), 'list refresh failure: stale notice');
ok(!/just now/.test(await p.locator('#refresh-btn').getAttribute('title')), 'list refresh failure: freshness not reset');
await p.goto(BASE + '/services'); await settle(p, 1200);
await p.screenshot({ path: `${SP}/gate/${OUT}/state-services-error.png` });
ok(await p.locator('[role=alert]:has-text("Prometheus is not answering")').count() === 1 && await p.locator('#main button:has-text("Try again")').count() === 1, 'list first-load failure: cause + Try again');
await p.unroute('**/api/services');
await p.click('#main button:has-text("Try again")'); await settle(p, 1500);
ok(await p.locator('#main tbody tr').count() > 0, 'list Try again recovers');
// filters in the URL, keyboard
await p.locator('.summary-btn').nth(3).focus(); await p.keyboard.press('Enter'); await settle(p, 400);
ok(/status=down/.test(p.url()), `status filter in URL (${p.url().replace(BASE, '')})`);
ok(await p.locator('.summary-btn[aria-pressed=true]').count() === 1, 'filter card shows pressed state');
await p.locator('th .th-btn:has-text("Error Rate")').focus(); await p.keyboard.press('Enter'); await settle(p, 300);
ok(/sort=errorRate/.test(p.url()) && await p.locator('th[aria-sort=descending]').count() === 1, 'sort by keyboard, in URL, aria-sort set');
await p.fill('#main input[type=search]', 'zzzz-none'); await settle(p, 300);
ok(/No services match/.test(await txt('#main tbody')), 'no-match message with Clear filter');
await p.click('#main tbody button:has-text("Clear filter")'); await settle(p, 300);
ok(await p.locator('#main tbody tr').count() === rows, 'Clear filter restores the list');
await p.goto(BASE + '/services?status=down&range=21600'); await settle(p, 1500);
const allDown = await p.locator('#main tbody tr td:nth-child(2)').allInnerTexts();
ok(allDown.length > 0 && allDown.every((t) => /Down/.test(t)), 'URL filter applied on load');
// context + Back/Forward
const first = p.locator('#main tbody tr a').first();
const href = await first.getAttribute('href');
ok(href.includes('range=21600'), `service link keeps range (${href})`);
await first.click(); await settle(p, 1800);
const detail = p.url();
await p.goBack(); await settle(p, 1500);
ok(/\/services\?.*status=down/.test(p.url()) && /range=21600/.test(p.url()), `Back returns to the filtered list (${p.url().replace(BASE, '')})`);
await p.goForward(); await settle(p, 1500);
ok(p.url() === detail, 'Forward returns to the service');
// ---- detail ----
ok(await p.locator('.detail-head h1').evaluate((e) => getComputedStyle(e).fontSize) === '22px', 'detail title 22px');
await p.click('.tabs >> text=Traces'); await settle(p, 1500);
ok(/tab=traces/.test(p.url()) && /range=21600/.test(p.url()), `tab keeps range (${p.url().replace(BASE, '')})`);
const tr = p.locator('#main tbody tr.clickable').first();
if (await tr.count()) { await tr.click(); await settle(p, 1500); ok(/\/traces\/[0-9a-f]+\?.*range=21600/.test(p.url()), 'trace row keeps range'); await p.goBack(); await settle(p, 1500); }
ok(/tab=traces/.test(p.url()), 'Back from a trace returns to the Traces tab');
await p.click('.detail-head a.back'); await settle(p, 1200);
ok(/\/services\?.*range=21600/.test(p.url()), 'back arrow keeps range');
const svcUrl = detail.split('?')[0];
await p.goto(svcUrl); await settle(p, 1800); await p.waitForTimeout(6000);
await fail('**/api/services/*', 'Prometheus is not answering');
await p.click('#refresh-btn'); await settle(p, 1000);
ok(await p.locator('.kpi').count() >= 4 && /Couldn't refresh/.test(await txt('.stale-notice')), 'detail refresh failure: data kept, stale notice');
await p.goto(svcUrl); await settle(p, 1200);
await p.screenshot({ path: `${SP}/gate/${OUT}/state-service-error.png` });
ok(await p.locator('#main button:has-text("Try again")').count() === 1 && await p.locator('.detail-head a.back').count() === 1, 'detail first-load failure: Try again, back arrow');
await p.unroute('**/api/services/*');
await fail('**/api/incidents?*', 'Database busy');
await p.goto(svcUrl); await settle(p, 2000);
ok(/could not be loaded/.test(await txt('#main')), 'related incidents failure is stated');
await p.unroute('**/api/incidents?*');
// phone table
await p.setViewportSize({ width: 390, height: 844 }); await p.goto(BASE + '/services'); await settle(p, 1800);
const sw = await p.evaluate(() => [document.documentElement.scrollWidth, document.querySelector('.table-wrap').scrollWidth, document.querySelector('.table-wrap').clientWidth]);
ok(sw[0] <= 391 && sw[1] <= sw[2] + 1, `390px: page and table fit (${sw.join('/')})`);
ok(!errors.length, `no page errors ${errors.join(' | ')}`);
summary();
await b.close();
