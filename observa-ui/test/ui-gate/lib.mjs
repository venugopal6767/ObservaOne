// Shared helpers for the UI quality-gate checks. Needs Playwright: npm i -D playwright && npx playwright install chromium
// BASE (default http://127.0.0.1:8088), ADMIN_USER / ADMIN_PASS, OUT_DIR for screenshots.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = createRequire('/opt/npm-tools/node_modules/')('playwright'); }
export const { chromium } = pw;
export const BASE = process.env.BASE || 'http://127.0.0.1:8088';
export const SP = process.env.OUT_DIR || process.env.SP || './ui-gate-out';
for (const d of ['gate/before', 'gate/after', 'persona']) fs.mkdirSync(`${SP}/${d}`, { recursive: true });
const USER = process.env.ADMIN_USER || 'admin', PASS = process.env.ADMIN_PASS || 'Admin-Pass-2026!';
let pass = 0, fail = 0;
export const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };
export const summary = () => { console.log(`${pass}/${pass + fail}`); if (fail) process.exitCode = 1; };
export const errors = [];
export async function login(browser, u, p, viewport = { width: 1500, height: 950 }) {
  if (u === 'admin') { u = USER; p = PASS; }
  const ctx = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${u}: ${e.message}`));
  await page.goto(BASE + '/');
  await page.fill('input[autocomplete=username], input[name=username], #username', u);
  await page.fill('input[type=password]', p);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.topbar', { timeout: 10000 });
  await page.waitForTimeout(800);
  return page;
}
export const settle = (p, ms = 1300) => p.waitForTimeout(ms);
