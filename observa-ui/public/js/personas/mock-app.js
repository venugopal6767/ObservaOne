// Sample data for the Application Owner dashboard: applications made of services,
// with health, usage, cost against budget, releases, outside dependencies and risks.
import { rng, hash, between, int, pick, SERVICES } from './mock.js';

export const APPS = [
  { id: 'storefront', name: 'Storefront web', team: 'Commerce', owner: 'm.garcia', components: ['api-gateway', 'catalog', 'search', 'checkout', 'recommendations'], budget: 42000 },
  { id: 'mobile', name: 'Mobile app backend', team: 'Commerce', owner: 'l.chen', components: ['api-gateway', 'auth', 'orders', 'notifications'], budget: 26000 },
  { id: 'payments', name: 'Payments platform', team: 'Payments', owner: 'p.iyer', components: ['payments-api', 'auth'], budget: 31000 },
  { id: 'partner', name: 'Partner API', team: 'Platform', owner: 'a.kumar', components: ['api-gateway', 'orders', 'inventory'], budget: 12000 },
  { id: 'backoffice', name: 'Back-office portal', team: 'Commerce', owner: 'r.patel', components: ['orders', 'inventory', 'catalog'], budget: 8000 },
];
const EXTERNAL = [['Card payment gateway', 'payments'], ['Email delivery provider', 'mobile'], ['SMS provider', 'mobile'], ['Maps and geocoding API', 'storefront'], ['Tax calculation API', 'payments'], ['CDN', 'storefront']];
const CHANGE_LINES = ['Faster product page loading', 'Fix: cart total rounding', 'New: save card for later', 'Upgrade runtime to the latest LTS', 'Fix: duplicate order emails', 'Better error message on failed payment', 'Remove old v1 endpoints', 'New: partner webhook retries', 'Security patch for a library'];

function appStats(a, env) {
  const r = rng(`app|${env}|${a.id}`);
  const availability = between(r, 99.6, 99.99);
  const errorRate = r() < 0.25 ? between(r, 1, 3.5) : between(r, 0.1, 0.9);
  const p95 = between(r, 140, 650);
  const cost = a.budget * between(r, 0.7, 1.18);
  const users = Math.round(between(r, 2, 90) * 1000);
  const findings = int(r, 0, 4);
  const score = Math.round(Math.max(40, 100 - (100 - availability) * 120 - errorRate * 6 - Math.max(0, p95 - 300) / 20 - findings * 3));
  const day = 86400;
  const now = Math.floor(Date.now() / 1000);
  const usage = Array.from({ length: 30 }, (_, i) => [now - (29 - i) * day, Math.round(users * (0.8 + 0.25 * Math.sin(i / 2.2) + (r() - 0.5) * 0.12) * ((now - (29 - i) * day) / day % 7 >= 5 ? 0.75 : 1))]);
  const costParts = a.components.map((c) => [c, a.budget * between(r, 0.08, 0.35)]);
  const scale = cost / costParts.reduce((s, [, v]) => s + v, 0);
  const releases = Array.from({ length: int(r, 3, 6) }, (_, i) => {
    const comp = pick(r, a.components);
    const ok = r() > 0.12;
    return {
      id: `rel-${hash(`${a.id}|${i}`) % 90000 + 10000}`, app: a.id, appName: a.name, version: `${2026}.${10 - Math.floor(i / 2)}.${int(r, 0, 9)}`,
      at: Date.now() - (i * between(r, 2, 7) + between(r, 0.1, 1)) * 86400_000, status: ok ? 'succeeded' : 'rolled_back', components: [comp, ...(r() < 0.4 ? [pick(r, a.components)] : [])].filter((x, j, arr) => arr.indexOf(x) === j),
      changes: Array.from({ length: int(r, 2, 4) }, () => pick(r, CHANGE_LINES)).filter((x, j, arr) => arr.indexOf(x) === j), by: pick(r, ['m.garcia', 'l.chen', 'deploy-bot', 'a.kumar']),
      errBefore: errorRate * between(r, 0.7, 1.1), errAfter: ok ? errorRate * between(r, 0.6, 1.05) : errorRate * between(r, 2, 4),
    };
  }).sort((x, y) => y.at - x.at);
  const risks = [
    r() < 0.5 ? { level: 'warning', text: `TLS certificate for ${a.id}.example.local expires in ${int(r, 6, 25)} days` } : null,
    cost > a.budget ? { level: 'critical', text: `Spending is ${(((cost / a.budget) - 1) * 100).toFixed(0)}% over this month's budget` } : null,
    findings ? { level: findings > 2 ? 'critical' : 'warning', text: `${findings} open security finding${findings > 1 ? 's' : ''} in dependencies` } : null,
    r() < 0.4 ? { level: 'info', text: `${pick(r, a.components)} runs an older runtime version (support ends next quarter)` } : null,
  ].filter(Boolean);
  return {
    ...a, availability, errorRate, p95, cost, users, usersChange: between(r, -8, 15), score, findings, usage, releases, risks,
    costParts: costParts.map(([c, v]) => [c, v * scale]),
    costTrend: Array.from({ length: 6 }, (_, i) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - (5 - i)); return [d.toLocaleDateString(undefined, { month: 'short' }), i === 5 ? cost : a.budget * between(r, 0.7, 1.05)]; }),
    status: score >= 85 ? 'healthy' : score >= 70 ? 'degraded' : 'at_risk',
    external: EXTERNAL.filter(([, app]) => app === a.id).map(([name]) => ({ name, status: r() < 0.15 ? 'degraded' : 'healthy', latency: between(r, 40, 400), uptime: between(r, 99.5, 100) })),
  };
}

export function appOwnerData({ env, team, app, empty = false }) {
  if (empty) return { apps: [], releases: [], external: [], kpi: {} };
  const apps = APPS.filter((a) => (!team || a.team === team) && (!app || a.id === app)).map((a) => appStats(a, env));
  const releases = apps.flatMap((a) => a.releases).sort((x, y) => y.at - x.at);
  const month = Date.now() - 30 * 86400_000;
  return {
    apps, releases, external: apps.flatMap((a) => a.external.map((x) => ({ ...x, app: a.name }))),
    usage: apps.length ? apps[0].usage.map(([t], i) => [t, apps.reduce((s, a) => s + a.usage[i][1], 0)]) : [],
    kpi: {
      score: apps.length ? Math.round(apps.reduce((s, a) => s + a.score, 0) / apps.length) : 0,
      users: apps.reduce((s, a) => s + a.users, 0), usersChange: apps.length ? apps.reduce((s, a) => s + a.usersChange, 0) / apps.length : 0,
      errorRate: apps.length ? apps.reduce((s, a) => s + a.errorRate * a.users, 0) / Math.max(1, apps.reduce((s, a) => s + a.users, 0)) : 0,
      cost: apps.reduce((s, a) => s + a.cost, 0), budget: apps.reduce((s, a) => s + a.budget, 0),
      releases: releases.filter((x) => x.at > month).length, rolledBack: releases.filter((x) => x.at > month && x.status === 'rolled_back').length,
      risks: apps.reduce((s, a) => s + a.risks.filter((x) => x.level !== 'info').length, 0),
    },
  };
}

export function appDetail(env, id) { const a = APPS.find((x) => x.id === id); return a ? appStats(a, env) : null; }
export function releaseDetail(env, id) {
  for (const a of APPS) { const s = appStats(a, env); const rel = s.releases.find((x) => x.id === id); if (rel) return { app: s, rel }; }
  return null;
}
export const componentLang = (c) => SERVICES.find((s) => s.name === c)?.lang || '';
