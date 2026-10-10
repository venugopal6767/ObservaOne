// Metrics Explorer gate.
import { chromium, BASE, ok, summary, errors, login, settle, SP } from './lib.mjs';
const b = await chromium.launch();
const p = await login(b, 'admin', '', { width: 1366, height: 900 });
const fail = (pattern, msg) => p.route(pattern, (r) => r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: msg }) }));
const txt = async (sel) => (await p.locator(sel).first().textContent().catch(() => '')) || '';
const Q = encodeURIComponent('up');
await p.route('**/api/prom/query_range?*', async (r) => { await new Promise((s) => setTimeout(s, 1500)); await r.continue().catch(() => {}); });
await p.goto(`${BASE}/metrics?q=${Q}&range=21600`); await p.waitForTimeout(500);
ok(await p.locator('#main .skeleton').count() >= 1, 'loading placeholder');
await settle(p, 2000); await p.unroute('**/api/prom/query_range?*');
ok(await p.locator('#main canvas').count() >= 1, 'live: chart drawn');
await p.click('.tabs >> text=Table'); await settle(p, 400);
await p.selectOption('#main select[aria-label=Unit]', 'percent'); await settle(p, 400);
ok(/view=table/.test(p.url()) && /unit=percent/.test(p.url()) && /range=21600/.test(p.url()), `view, unit, range in URL (${p.url().replace(BASE, '')})`);
await p.goto(p.url()); await settle(p, 2000);
ok(await p.locator('.tabs .tab.active').textContent() === 'Table' && await p.locator('#main select[aria-label=Unit]').inputValue() === 'percent', 'restored from the URL');
// refresh failure + query error
await p.waitForTimeout(6000);
await fail('**/api/prom/query_range?*', 'Prometheus is not answering');
const rowsBefore = await p.locator('#main tbody tr').count();
await p.click('#refresh-btn'); await settle(p, 800);
ok(await p.locator('#main tbody tr').count() === rowsBefore && /Couldn't refresh/.test(await txt('.stale-notice')), 'refresh failure: data kept + stale notice');
await p.unroute('**/api/prom/query_range?*');
await fail('**/api/prom/query_range?*', 'parse error: unexpected end of input');
await p.fill('#main input[aria-label="PromQL query"]', 'sum(rate('); await p.keyboard.press('Enter'); await settle(p, 800);
ok(await p.locator('[role=alert]:has-text("parse error")').count() === 1, 'bad query: the error is shown, with no old data under it');
await p.unroute('**/api/prom/query_range?*');
await p.fill('#main input[aria-label="PromQL query"]', ''); await p.keyboard.press('Enter'); await settle(p, 300);
ok(/Type a PromQL query/.test(await txt('#main')), 'empty query explains what to do');
await p.click('details.panel summary'); await p.click('details.panel button.linkish >> nth=0'); await settle(p, 1500);
ok(/q=up/.test(p.url()), 'example query is a working button');
// phone
await p.setViewportSize({ width: 390, height: 844 }); await p.goto(`${BASE}/metrics?q=${Q}`); await settle(p, 2000);
ok(await p.evaluate(() => document.documentElement.scrollWidth <= 391), '390px: no sideways scroll');
ok(!/null|undefined/.test(await p.locator('#main').innerText()), 'no stray null text');
ok(!errors.length, `no page errors ${errors.join(' | ')}`);
summary();
await b.close();
