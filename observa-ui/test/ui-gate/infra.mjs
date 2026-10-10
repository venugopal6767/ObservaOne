// Infrastructure gate: states, failed metric queries reported, environment filter, context, phone table.
import { chromium, BASE, ok, summary, errors, login, settle, SP } from './lib.mjs';
const OUT = process.env.OUT || 'after';
const b = await chromium.launch();
const p = await login(b, 'admin', '', { width: 1366, height: 900 });
const fail = (pattern, msg) => p.route(pattern, (r) => r.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: msg }) }));
const txt = async (sel) => (await p.locator(sel).first().textContent().catch(() => '')) || '';
await p.route('**/api/prom/targets', async (r) => { await new Promise((s) => setTimeout(s, 1500)); await r.continue().catch(() => {}); });
await p.goto(BASE + '/infrastructure?env='); await p.waitForTimeout(500);
ok(await p.locator('#main .skeleton').count() >= 1, 'loading placeholder');
await settle(p, 2000); await p.unroute('**/api/prom/targets');
const rows = await p.locator('#main table').first().locator('tbody tr').count();
ok(rows > 0, `live: ${rows} servers`);
// one metric query failing is reported, not shown as blanks
await p.route('**/api/prom/query?*', (r) => (decodeURIComponent(r.request().url()).includes('MemAvailable') ? r.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'query timed out' }) }) : r.continue()));
await p.goto(BASE + '/infrastructure'); await settle(p, 2000);
await p.screenshot({ path: `${SP}/gate/${OUT}/state-infra-partial.png` });
ok(/Memory: query timed out/.test(await txt('#main')), 'failed memory query is named');
ok(!/null|undefined/.test(await p.locator('#main').innerText()), 'no stray null text');
await p.unroute('**/api/prom/query?*');
// refresh failure keeps the table
await p.goto(BASE + '/infrastructure'); await settle(p, 2000); await p.waitForTimeout(6000);
await fail('**/api/prom/targets', 'Prometheus is not answering');
await p.click('#refresh-btn'); await settle(p, 1000);
ok(await p.locator('#main table').first().locator('tbody tr').count() === rows && /Couldn't refresh/.test(await txt('.stale-notice')), 'refresh failure: table kept, stale notice');
ok(!/just now/.test(await p.locator('#refresh-btn').getAttribute('title')), 'refresh failure: freshness not reset');
await p.goto(BASE + '/infrastructure'); await settle(p, 1200);
await p.screenshot({ path: `${SP}/gate/${OUT}/state-infra-error.png` });
ok(await p.locator('[role=alert]:has-text("Prometheus is not answering")').count() === 1 && await p.locator('#main button:has-text("Try again")').count() === 1, 'first-load failure: cause + Try again');
await p.unroute('**/api/prom/targets');
await p.click('#main button:has-text("Try again")'); await settle(p, 1500);
ok(await p.locator('#main table').first().locator('tbody tr').count() === rows, 'Try again recovers');
// environment filter: label the servers in the response (browser-side only) so the check runs on any install
await p.route('**/api/prom/targets', async (r) => { const res = await r.fetch(); const j = await res.json(); let i = 0; for (const t of j) if (t.job === 'linux' || t.job === 'windows') t.env = i++ % 2 ? 'staging' : 'production'; await r.fulfill({ response: res, json: j }); });
await p.goto(BASE + '/infrastructure?env='); await settle(p, 1800);
const envs = await p.evaluate(() => [...document.querySelectorAll('#main table')[0].querySelectorAll('tbody tr td:nth-child(4)')].map((x) => x.textContent));
const someEnv = envs.find((e) => e && e !== '—');
if (someEnv) {
  await p.goto(BASE + `/infrastructure?env=${someEnv}`); await settle(p, 1800);
  const shown = await p.evaluate(() => [...document.querySelectorAll('#main table')[0].querySelectorAll('tbody tr td:nth-child(4)')].map((x) => x.textContent));
  ok(shown.length > 0 && shown.every((e) => e === someEnv) && new RegExp(`Environment ${someEnv}: \\d+ of \\d+`).test(await txt('#main')), `env ${someEnv} filters the servers and says so`);
  await p.click('#main a:has-text("Show all environments")'); await settle(p, 1800);
  ok(await p.locator('#main table').first().locator('tbody tr').count() === rows, 'Show all environments clears it');
} else ok(false, 'env labels missing');
await p.unroute('**/api/prom/targets');
// context
await p.goto(BASE + '/infrastructure?range=21600'); await settle(p, 1800);
const dash = await p.locator('#main a[href*="/dashboards/"]').first().getAttribute('href');
ok(dash.includes('range=21600'), `dashboard link keeps range (${dash})`);
await p.locator('#main a[href*="/dashboards/"]').first().click(); await settle(p, 2000);
await p.goBack(); await settle(p, 1500);
ok(/\/infrastructure/.test(p.url()), 'Back returns to Infrastructure');
// phone
await p.setViewportSize({ width: 390, height: 844 }); await p.goto(BASE + '/infrastructure'); await settle(p, 1800);
const fit = await p.evaluate(() => [...document.querySelectorAll('.table-wrap')].map((w) => `${w.scrollWidth}/${w.clientWidth}`).concat(document.documentElement.scrollWidth));
ok(fit.slice(0, -1).every((x) => { const [a, b] = x.split('/').map(Number); return a <= b + 1; }) && fit.at(-1) <= 391, `390px: tables fit (${fit.join(' ')})`);
ok(!errors.length, `no page errors ${errors.join(' | ')}`);
summary();
await b.close();
