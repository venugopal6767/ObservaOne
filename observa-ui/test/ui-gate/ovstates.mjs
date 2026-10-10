// Overview data states: loading, live, error on first load, refresh failure (stale), partial failure, slow.
import { chromium, BASE, ok, summary, errors, login, settle, SP } from './lib.mjs';
const OUT = process.env.OUT || 'before';
const b = await chromium.launch();
const p = await login(b, 'admin', 'Admin-Pass-2026!', { width: 1366, height: 900 });
const txt = async (sel) => (await p.locator(sel).first().textContent().catch(() => '')) || '';
// 1 loading: delay /api/overview
await p.route('**/api/overview?*', async (r) => { await new Promise((s) => setTimeout(s, 2500)); await r.continue().catch(() => {}); });
await p.goto(BASE + '/overview'); await p.waitForTimeout(700);
await p.screenshot({ path: `${SP}/gate/${OUT}/state-overview-loading.png` });
const loadingMarks = await p.locator('#main .skeleton, #main .spinner').count();
ok(loadingMarks >= 3, `loading: placeholders in KPI row and panels (${loadingMarks})`);
await settle(p, 3200); await p.unroute('**/api/overview?*');
// 2 live
ok(await p.locator('.ov-kpis .kpi').count() === 5, 'live: 5 KPI cards');
// 3 refresh failure keeps data, says stale, freshness not reset
await p.waitForTimeout(7000);
await p.route('**/api/overview?*', (r) => r.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Prometheus is not answering' }) }));
await p.click('#refresh-btn'); await settle(p, 1200);
await p.screenshot({ path: `${SP}/gate/${OUT}/state-overview-stale.png` });
ok(await p.locator('.ov-kpis .kpi').count() === 5, 'refresh failure: last good KPIs still shown');
ok(/couldn.t refresh at .* showing data from/i.test(await txt('.stale-notice')), `refresh failure: stale notice (${await txt('.stale-notice')})`);
ok(await p.locator('.stale-notice button:has-text("Try again")').count() === 1, 'refresh failure: Try again on the notice');
ok(!/just now/.test(await p.locator('#refresh-btn').getAttribute('title')), `refresh failure: freshness not reset (${await p.locator('#refresh-btn').getAttribute('title')})`);
// 4 first-load failure: error with retry, nothing fake
await p.goto(BASE + '/overview'); await settle(p, 1500);
await p.screenshot({ path: `${SP}/gate/${OUT}/state-overview-error.png` });
ok(await p.locator('#main [role=alert]:has-text("Prometheus is not answering")').count() >= 1, 'first-load failure: error names the cause');
ok(await p.locator('#main button:has-text("Try again")').count() === 1, 'first-load failure: Try again button');
ok(await p.locator('#fresh-chip').evaluate((e) => e.classList.contains('hidden')), 'first-load failure: no "Updated" stamp');
ok(await p.locator('.ov-kpis .kpi').count() === 0, 'first-load failure: no numbers invented');
await p.unroute('**/api/overview?*');
if (await p.locator('#main button:has-text("Try again")').count()) { await p.click('#main button:has-text("Try again")'); await settle(p, 2500); ok(await p.locator('.ov-kpis .kpi').count() === 5, 'retry recovers'); }
// 5 partial: incidents API down
await p.route('**/api/incidents?*', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Database busy' }) }));
await p.goto(BASE + '/overview'); await settle(p, 2500);
await p.screenshot({ path: `${SP}/gate/${OUT}/state-overview-partial.png` });
ok(/Could not check incidents/.test(await txt('.ov-attn')), 'partial: attention says incidents could not be checked');
ok(/N\/A/.test(await txt('.ov-kpis')), 'partial: incident KPI N/A');
await p.unroute('**/api/incidents?*');
// 6 logs/traces down
await p.route('**/api/logs?*', (r) => r.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Loki is not answering' }) }));
await p.goto(BASE + '/overview'); await settle(p, 2500);
ok(/Loki is not answering|logs unavailable|could not load/i.test(await txt('.ov-row-c')), 'partial: recent logs panel names the failure');
await p.unroute('**/api/logs?*');
// 7 context: env + range travel with drill-downs; Back / Forward replay them
await p.goto(BASE + '/overview?env=&range=21600'); await settle(p, 2500);
await p.click('.ov-kpis a.kpi >> nth=0'); await settle(p, 1500);
ok(/\/infrastructure\?.*range=21600/.test(p.url()), `KPI drill keeps range (${p.url().replace(BASE, '')})`);
await p.goBack(); await settle(p, 2000);
ok(/\/overview/.test(p.url()) && await p.locator('.ov-kpis .kpi').count() === 5, 'Back returns to a working Overview');
ok(/last 6 hours/.test(await txt('.ov-context')), `Back keeps the time range (${await txt('.ov-context')})`);
await p.goForward(); await settle(p, 1500);
ok(/\/infrastructure/.test(p.url()), 'Forward returns to Infrastructure');
await p.goto(BASE + '/overview?range=21600'); await settle(p, 2500);
const ah = await p.locator('.ov-attn .attn-item a').first().getAttribute('href').catch(() => null);
ok(!ah || ah.includes('range=21600'), `attention action keeps range (${ah})`);
await p.locator('.ov-row-a tbody tr.clickable td.ov-title').first().click().catch(() => {}); await settle(p, 1500);
ok(/\/incidents\/\d+\?.*range=21600/.test(p.url()), `incident row keeps range (${p.url().replace(BASE, '')})`);
ok(await p.locator('.btn.demo-btn').count() === 0, 'no duplicate page-level demo button');
summary();
await b.close();
