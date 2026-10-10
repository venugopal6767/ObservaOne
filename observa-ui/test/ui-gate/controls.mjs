// Interaction audit: every visible control must have a handler, a real href, be a form control, or be disabled/locked with a reason.
import { chromium, BASE, login, settle, SP } from './lib.mjs';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  const orig = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (t, fn, o) { if (this instanceof Element && ['click', 'mousedown', 'change', 'input', 'submit', 'keydown'].includes(t)) this.dataset.ooH = '1'; return orig.call(this, t, fn, o); };
});
const p = await ctx.newPage();
await p.goto(BASE + '/'); await p.fill('#username, input[autocomplete=username]', process.env.ADMIN_USER || 'admin'); await p.fill('input[type=password]', process.env.ADMIN_PASS || 'Admin-Pass-2026!'); await p.keyboard.press('Enter'); await p.waitForSelector('.topbar');
const pages = (process.env.PAGES || '/overview,/services,/services/api-gateway,/infrastructure,/incidents,/incidents/43,/logs,/traces,/metrics,/dashboards,/insights,/agents,/datasources,/alerting,/settings?tab=users,/settings?tab=profile,/views/sre,/views/kubernetes,/views/devops,/views/business,/views/itadmin,/views/security,/views/developer,/views/appowner').split(',');
let total = 0, bad = [];
for (const path of pages) {
  await p.goto(BASE + path); await settle(p, 2600);
  const r = await p.evaluate(() => {
    const vis = (el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    const has = (el) => { for (let n = el; n && n !== document.body; n = n.parentElement) if (n.dataset?.ooH) return true; return false; };
    const out = [], els = [...document.querySelectorAll('button, a, [role=button], select, input, summary')].filter(vis);
    for (const el of els) {
      const tag = el.tagName, label = (el.getAttribute('aria-label') || el.title || el.textContent || el.placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 50);
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') { if (!(el.title || el.getAttribute('aria-label'))) out.push(`disabled without reason: ${tag} "${label}"`); continue; }
      if (tag === 'A') { const h = el.getAttribute('href'); if (!h || h === '#' || h.startsWith('javascript')) { if (!has(el)) out.push(`link without target: "${label}"`); } continue; }
      if (['SELECT', 'INPUT'].includes(tag)) { if (!has(el) && !el.form && el.type !== 'hidden' && el.type !== 'checkbox') out.push(`${tag.toLowerCase()} without handler: "${label}"`); continue; }
      if (tag === 'SUMMARY') continue;
      if (el.type === 'submit' && el.form) continue;
      if (!has(el)) out.push(`button without handler: "${label}" (${el.className})`);
      if (!label) out.push(`control without accessible name: ${tag} .${el.className}`);
    }
    return { n: els.length, out };
  });
  total += r.n;
  for (const o of r.out) bad.push(`${path}: ${o}`);
}
console.log(`controls checked: ${total}`);
console.log(bad.join('\n') || 'no problem controls');
await b.close();
