// Logs + Log details gate.
import { chromium, BASE, ok, summary, errors, login, settle, SP } from './lib.mjs';
const OUT = process.env.OUT || 'after';
const b = await chromium.launch();
const p = await login(b, 'admin', '', { width: 1366, height: 900 });
const fail = (pattern, msg) => p.route(pattern, (r) => r.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: msg }) }));
const txt = async (sel) => (await p.locator(sel).first().textContent().catch(() => '')) || '';
const Q = encodeURIComponent('{service_name=~".+"}');
await p.route('**/api/logs?*', async (r) => { await new Promise((s) => setTimeout(s, 1500)); await r.continue().catch(() => {}); });
await p.goto(`${BASE}/logs?q=${Q}&range=21600`); await p.waitForTimeout(500);
ok(await p.locator('#main .skeleton').count() >= 1, 'loading placeholder');
await settle(p, 2000); await p.unroute('**/api/logs?*');
const rows = await p.locator('#main tbody tr').count();
ok(rows > 0, `live: ${rows} lines`);
ok(/range=21600/.test(p.url()) && /q=/.test(p.url()), `query and range in URL (${decodeURIComponent(p.url().replace(BASE, '')).slice(0, 80)})`);
// filters into the URL
await p.click('#main .chips button:has-text("ERROR")'); await settle(p, 400);
ok(/level=ERROR/.test(p.url()) && await p.locator('#main .chips button[aria-pressed=true]').count() === 1, 'level filter in URL, pressed state');
const svcOpt = await p.locator('#main select[aria-label=Service] option').nth(1).getAttribute('value').catch(() => null);
if (svcOpt) { await p.selectOption('#main select[aria-label=Service]', svcOpt); await settle(p, 400); ok(/service=/.test(p.url()), 'service filter in URL'); }
await p.goto(p.url()); await settle(p, 2000);
ok(await p.locator('#main .chips button.active').textContent().then((t) => /ERROR/.test(t)), 'filters restored from the URL');
// auto refresh keeps lines (no flash) and a failed refresh is stale, not empty
const before = await p.locator('#main tbody tr').count();
await p.waitForTimeout(6000);
await fail('**/api/logs?*', 'Loki is not answering');
await p.click('#refresh-btn'); await p.waitForTimeout(150);
ok(await p.locator('#main tbody tr').count() === before, 'refresh does not blank the table');
await settle(p, 800);
ok(/Couldn't refresh/.test(await txt('.stale-notice')) && await p.locator('#main tbody tr').count() === before, 'refresh failure: lines kept + stale notice');
ok(!/just now/.test(await p.locator('#refresh-btn').getAttribute('title')), 'refresh failure: freshness not reset');
await p.goto(`${BASE}/logs?q=${Q}`); await settle(p, 1200);
await p.screenshot({ path: `${SP}/gate/${OUT}/state-logs-error.png` });
ok(await p.locator('[role=alert]:has-text("Loki is not answering")').count() === 1 && await p.locator('#main button:has-text("Try again")').count() === 1, 'first-load failure: cause + Try again');
await p.unroute('**/api/logs?*');
// detail: context and back
await p.goto(`${BASE}/logs?q=${Q}&range=21600`); await settle(p, 2000);
await p.locator('#main tbody tr').first().click(); await settle(p, 1200);
ok(/\/logs\/detail\?.*range=21600/.test(p.url()), 'detail keeps range');
const vt = p.locator('.detail-head a:has-text("View Trace")');
const noTrace = p.locator('.detail-head [aria-disabled=true]');
ok(await vt.count() === 1 || (await noTrace.count() === 1 && /no trace ID/.test(await noTrace.getAttribute('title'))), 'View Trace, or a clear "No trace linked"');
await p.click('.tabs >> text=JSON'); await settle(p, 300);
await p.click('.json-head button'); await settle(p, 500);
ok(await p.locator('.toast').count() >= 1, 'Copy gives feedback');
await p.click('.detail-head a.back'); await settle(p, 1800);
ok(/\/logs\?.*range=21600/.test(p.url()), 'back arrow returns to Logs with range');
await p.goBack(); await settle(p, 1000);
ok(/\/logs\/detail/.test(p.url()), 'browser Back returns to the detail');
// phone
await p.setViewportSize({ width: 390, height: 844 }); await p.goto(`${BASE}/logs?q=${Q}`); await settle(p, 2000);
ok(await p.evaluate(() => document.documentElement.scrollWidth <= 391), '390px: no sideways scroll');
ok(await p.locator('#main th:has-text("Host / pod")').isHidden(), '390px: minor columns hidden');
ok(!/null|undefined/.test(await p.locator('#main').innerText()), 'no stray null text');
ok(!errors.length, `no page errors ${errors.join(' | ')}`);
summary();
await b.close();
