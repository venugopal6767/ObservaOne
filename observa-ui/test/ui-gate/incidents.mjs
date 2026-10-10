// Incidents list + Incident detail gate.
import { chromium, BASE, ok, summary, errors, login, settle, SP } from './lib.mjs';
const OUT = process.env.OUT || 'after';
const b = await chromium.launch();
const p = await login(b, 'admin', '', { width: 1366, height: 900 });
const fail = (pattern, msg) => p.route(pattern, (r) => r.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: msg }) }));
const txt = async (sel) => (await p.locator(sel).first().textContent().catch(() => '')) || '';
await p.route('**/api/incidents?*', async (r) => { await new Promise((s) => setTimeout(s, 1500)); await r.continue().catch(() => {}); });
await p.goto(BASE + '/incidents'); await p.waitForTimeout(500);
ok(await p.locator('#main .skeleton').count() >= 1, 'list loading placeholder');
await settle(p, 2000); await p.unroute('**/api/incidents?*');
const rows = await p.locator('#main tbody tr').count();
ok(rows > 0, `list live: ${rows}`);
// filters into the URL
await p.selectOption('#main select[aria-label=Severity]', 'critical'); await settle(p, 1000);
ok(/severity=critical/.test(p.url()), 'severity filter in URL');
await p.fill('#main input[aria-label="Search incidents"]', 'zz-no-such'); await settle(p, 1200);
ok(/q=zz-no-such/.test(p.url()) && /No incidents match/.test(await txt('#main')), 'search in URL + no-match message');
await p.goto(BASE + '/incidents?severity=critical&range=21600'); await settle(p, 1500);
const sev = await p.locator('#main tbody tr td:nth-child(4)').allInnerTexts();
ok(sev.length > 0 && sev.every((t) => /Critical/.test(t)), 'URL filter applied on load');
ok(await p.locator('#main select[aria-label=Severity]').inputValue() === 'critical', 'filter control shows the URL value');
// stale + error
await p.waitForTimeout(6000);
await fail('**/api/incidents?*', 'Database busy');
await p.click('#refresh-btn'); await settle(p, 1000);
ok(await p.locator('#main tbody tr').count() === sev.length && /Couldn't refresh/.test(await txt('.stale-notice')), 'list refresh failure: kept + stale notice');
await p.goto(BASE + '/incidents'); await settle(p, 1200);
ok(await p.locator('[role=alert]:has-text("Database busy")').count() === 1 && await p.locator('#main button:has-text("Try again")').count() === 1, 'list first-load failure: cause + Try again');
await p.unroute('**/api/incidents?*');
// context into detail and back
await p.goto(BASE + '/incidents?severity=critical&range=21600'); await settle(p, 1500);
await p.locator('#main tbody tr td:nth-child(2)').first().click(); await settle(p, 1800);
const detail = p.url();
ok(/\/incidents\/\d+\?.*range=21600/.test(detail), `row keeps range (${detail.replace(BASE, '')})`);
ok(await p.locator('.detail-head h1').evaluate((e) => getComputedStyle(e).fontSize) === '22px', 'detail title 22px');
await p.click('.tabs >> text=Timeline'); await settle(p, 800);
ok(/tab=timeline/.test(p.url()) && /range=21600/.test(p.url()), 'tab keeps range');
await p.click('.detail-head a.back'); await settle(p, 1500);
ok(/\/incidents\?.*range=21600/.test(p.url()), `back arrow goes to the list with range (${p.url().replace(BASE, '')})`);
await p.goBack(); await settle(p, 1500);
ok(/\/incidents\/\d+/.test(p.url()), 'browser Back returns to the incident');
await p.goBack(); await settle(p, 1500);
ok(/severity=critical/.test(p.url()), 'Back again returns to the filtered list');
// detail states
const inc = detail.split('?')[0];
await p.goto(inc); await settle(p, 1800); await p.waitForTimeout(6000);
await fail('**/api/incidents/*', 'Database busy');
await p.click('#refresh-btn'); await settle(p, 1000);
ok(/Couldn't refresh/.test(await txt('.stale-notice')) && await p.locator('.kv').count() === 1, 'detail refresh failure: kept + stale notice');
await p.goto(inc); await settle(p, 1200);
await p.screenshot({ path: `${SP}/gate/${OUT}/state-incident-error.png` });
ok(await p.locator('#main button:has-text("Try again")').count() === 1 && await p.locator('.detail-head a.back').count() === 1, 'detail first-load failure: Try again + back');
await p.unroute('**/api/incidents/*');
// failed action is reported
await p.goto(inc); await settle(p, 1800);
await p.route('**/api/incidents/*/assign', (r) => r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Not allowed' }) }));
const assign = p.locator('#main button:has-text("Assign to me")');
if (await assign.count()) { await assign.click(); await settle(p, 600); ok(await p.locator('.toast:has-text("Not allowed")').count() >= 1, 'failed assign shows the error'); }
await p.unroute('**/api/incidents/*/assign');
// phone
await p.setViewportSize({ width: 390, height: 844 }); await p.goto(BASE + '/incidents'); await settle(p, 1800);
const fit = await p.evaluate(() => [...document.querySelectorAll('.table-wrap')].every((w) => w.scrollWidth <= w.clientWidth + 1) && document.documentElement.scrollWidth <= 391);
ok(fit, '390px: table fits');
ok(!/null|undefined/.test(await p.locator('#main').innerText()), 'no stray null text');
ok(!errors.length, `no page errors ${errors.join(' | ')}`);
summary();
await b.close();
