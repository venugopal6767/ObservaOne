// Screenshots + console/network errors for the quality gate. OUT=before|after
import { chromium, BASE, login, settle, SP } from './lib.mjs';
const OUT = process.env.OUT || 'before';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const b = await chromium.launch();
const pages = [['home', '/views'], ['overview', '/overview'], ['services', '/services'], ['service', '/services/api-gateway'], ['infra', '/infrastructure'], ['incidents', '/incidents'], ['incident', '/incidents/43'], ['logs', '/logs'], ['traces', '/traces'], ['metrics', '/metrics'], ['dashboards', '/dashboards'], ['insights', '/insights'], ['k8s', '/views/kubernetes'], ['sre', '/views/sre'], ['devops', '/views/devops/deployments'], ['appowner', '/views/appowner'], ['agents', '/agents'], ['datasources', '/datasources'], ['alerting', '/alerting'], ['settings', '/settings?tab=users']].filter(([n]) => !ONLY || ONLY.includes(n));
// detail pages: the first service and incident this install has
{ const p0 = await login(b, 'admin', '', { width: 800, height: 600 });
  const j = (u) => p0.evaluate(async (x) => (await fetch(x, { headers: { 'X-Requested-With': 'observa' } })).json(), u);
  const svc = (await j('/api/services')).list?.[0]?.name, inc = (await j('/api/incidents?status=all&limit=1')).incidents?.[0]?.id;
  for (const x of pages) { if (x[0] === 'service' && svc) x[1] = `/services/${encodeURIComponent(svc)}`; if (x[0] === 'incident' && inc) x[1] = `/incidents/${inc}`; }
  await p0.context().close(); }
const widths = [[390, 844], [768, 1024], [1366, 768], [1920, 1080]];
const problems = [];
for (const theme of (process.env.THEMES || 'dark,light').split(',')) for (const [w, hgt] of widths) {
  const p = await login(b, 'admin', 'Admin-Pass-2026!', { width: w, height: hgt });
  await p.evaluate((t) => fetch('/api/me/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'observa' }, body: JSON.stringify({ theme: t, navCollapsed: false }) }), theme);
  p.on('console', (m) => { if (m.type() === 'error') problems.push(`${w} ${theme} ${p.url()} console: ${m.text().slice(0, 160)}`); });
  p.on('response', (r) => { if (r.status() >= 400 && r.url().includes('/api/')) problems.push(`${w} ${theme} ${p.url()} HTTP ${r.status()} ${r.url().replace(BASE, '').slice(0, 100)}`); });
  p.on('pageerror', (e) => problems.push(`${w} ${theme} pageerror ${e.message}`));
  for (const [n, path] of pages) {
    if (theme === 'light' && !['home', 'overview', 'incident', 'service'].includes(n)) continue;
    await p.goto(BASE + path); await settle(p, 2600);
    const m = await p.evaluate(() => {
      const sw = document.documentElement.scrollWidth, vw = innerWidth;
      // text clipped: elements whose content overflows horizontally but hide it (ellipsis allowed only with title)
      let clipped = 0;
      for (const el of document.querySelectorAll('#main *')) {
        if (el.children.length || !el.textContent.trim() || el.closest('.sr-only')) continue;
        const cs = getComputedStyle(el);
        if (el.scrollWidth > el.clientWidth + 1 && cs.overflow !== 'visible' && cs.textOverflow !== 'ellipsis') clipped++;
      }
      // stray "null" / "undefined" text from a DOM append of a missing value
      let stray = 0;
      for (const el of document.querySelectorAll('#main *')) for (const n of el.childNodes) if (n.nodeType === 3 && /^\s*(null|undefined|\[object)/.test(n.textContent)) stray++;
      return { sw, vw, clipped, stray };
    });
    if (m.sw > m.vw + 1) problems.push(`${w} ${theme} ${path} horizontal scroll ${m.sw}>${m.vw}`);
    if (m.stray) problems.push(`${w} ${theme} ${path} ${m.stray} stray null/undefined text`);
    if (m.clipped) problems.push(`${w} ${theme} ${path} ${m.clipped} clipped text element(s)`);
    await p.screenshot({ path: `${SP}/gate/${OUT}/${n}-${w}-${theme}.png`, fullPage: false });
  }
  await p.context().close();
}
console.log(problems.join('\n') || 'no problems');
await b.close();
