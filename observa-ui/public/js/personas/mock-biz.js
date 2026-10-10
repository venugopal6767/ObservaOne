// Sample data for the Business / Executive dashboard. Business services are what customers use
// (checkout, login...), each built from technical services. Numbers are monthly and in plain terms.
import { rng, between, int, pick } from './mock.js';
import { incidents } from './mock-sre.js';

export const BUSINESS_SERVICES = [
  { id: 'checkout', name: 'Online checkout', owner: 'Commerce', sla: 99.9, components: ['checkout', 'payments-api', 'inventory', 'api-gateway'], revenuePerHour: 48000, users: 'shoppers paying for orders' },
  { id: 'payments', name: 'Payments', owner: 'Payments', sla: 99.95, components: ['payments-api', 'auth', 'api-gateway'], revenuePerHour: 52000, users: 'card and wallet payments' },
  { id: 'login', name: 'Customer sign-in', owner: 'Identity', sla: 99.9, components: ['auth', 'api-gateway'], revenuePerHour: 9000, users: 'customers signing in' },
  { id: 'search', name: 'Product search', owner: 'Discovery', sla: 99.5, components: ['search', 'catalog', 'recommendations'], revenuePerHour: 14000, users: 'customers finding products' },
  { id: 'orders', name: 'Order tracking', owner: 'Commerce', sla: 99.5, components: ['orders', 'notifications'], revenuePerHour: 3000, users: 'customers checking deliveries' },
  { id: 'notify', name: 'Customer notifications', owner: 'Platform', sla: 99.0, components: ['notifications'], revenuePerHour: 800, users: 'emails and text messages' },
];
export const REGIONS = [['eu', 'Europe'], ['us', 'North America']];
const MONTHS = 12;

function bizService(b, env, region) {
  const r = rng(`biz|${env}|${region}|${b.id}`);
  const miss = r() < 0.25;
  const availability = miss ? b.sla - between(r, 0.01, 0.12) : Math.min(99.999, b.sla + between(r, 0.02, (100 - b.sla) * 0.9));
  const minutesDown = ((100 - availability) / 100) * 30 * 24 * 60;
  const revenueAtRisk = (minutesDown / 60) * b.revenuePerHour * between(r, 0.3, 0.7);
  const usersAffected = Math.round(minutesDown * between(r, 20, 160));
  const trend = Array.from({ length: 30 }, (_, i) => {
    const dip = r() < (miss ? 0.12 : 0.05);
    return [i, Math.min(100, dip ? b.sla - between(r, 0.05, 0.9) : 100 - between(r, 0, (100 - b.sla) * 0.6))];
  });
  const history = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
    const a = i === 0 ? availability : r() < 0.15 ? b.sla - between(r, 0.01, 0.08) : b.sla + between(r, 0.01, (100 - b.sla) * 0.9);
    return { month: d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }), availability: a, met: a >= b.sla, credits: a >= b.sla ? 0 : Math.round(between(r, 2000, 25000)) };
  });
  const volume = Math.round(between(r, 0.6, 1.4) * b.revenuePerHour * 24 * 30 / 85);
  return {
    ...b, availability, minutesDown, revenueAtRisk, usersAffected, met: availability >= b.sla, trend, history,
    health: availability < b.sla ? 'at_risk' : r() < 0.15 ? 'degraded' : 'healthy',
    volume, volumeChange: between(r, -6, 12), satisfaction: Math.max(3.4, Math.min(4.9, 4.6 - (miss ? between(r, 0.3, 0.8) : between(r, -0.2, 0.3)))),
  };
}

export function businessData({ env, region, service, empty = false }) {
  if (empty) return { services: [], issues: [], months: [], kpi: {} };
  const services = BUSINESS_SERVICES.filter((b) => !service || b.id === service).map((b) => bizService(b, env, region));
  const comp = new Set(services.flatMap((s) => s.components));
  const issues = incidents(env)
    .filter((x) => comp.has(x.service) && x.severity !== 'info' && x.startedAt > Date.now() - 31 * 86400_000)
    .map((x) => {
      const svc = services.find((s) => s.components.includes(x.service));
      const mins = ((x.resolvedAt || Date.now()) - x.startedAt) / 60_000;
      return { ...x, business: svc, impactMin: mins, revenueAtRisk: (mins / 60) * svc.revenuePerHour * (x.severity === 'critical' ? 0.6 : 0.15) };
    }).sort((a, b) => b.revenueAtRisk - a.revenueAtRisk);
  // a service's sales at risk = its problems this month + small blips that never became incidents
  for (const s of services) s.revenueAtRisk = issues.filter((x) => x.business.id === s.id).reduce((a, x) => a + x.revenueAtRisk, 0) + s.revenueAtRisk * 0.2;
  const r = rng(`biz|months|${env}|${region}|${service}`);
  const months = Array.from({ length: MONTHS }, (_, i) => {
    const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); d.setMonth(d.getMonth() - (MONTHS - 1 - i));
    const n = int(r, 1, 9);
    return { month: d.getTime(), label: d.toLocaleDateString(undefined, { month: 'short' }), incidents: n, impactMin: n * between(r, 8, 45), availability: 99.9 + between(r, -0.12, 0.08) };
  });
  const weight = services.reduce((a, s) => a + s.revenuePerHour, 0) || 1;
  return {
    services, issues, months,
    kpi: {
      availability: services.reduce((a, s) => a + s.availability * s.revenuePerHour, 0) / weight,
      slaMet: services.filter((s) => s.met).length, slaTotal: services.length,
      revenueAtRisk: services.reduce((a, s) => a + s.revenueAtRisk, 0),
      customerIncidents: issues.length, impactMin: issues.reduce((a, x) => a + x.impactMin, 0),
      usersAffected: services.reduce((a, s) => a + s.usersAffected, 0),
      satisfaction: services.reduce((a, s) => a + s.satisfaction, 0) / (services.length || 1),
      orders: services.find((s) => s.id === 'checkout')?.volume ?? services[0]?.volume ?? 0,
      ordersChange: services.find((s) => s.id === 'checkout')?.volumeChange ?? 0,
      prevAvailability: months[months.length - 2]?.availability,
    },
  };
}

export function businessService({ env, region }, id) {
  const b = BUSINESS_SERVICES.find((x) => x.id === id);
  if (!b) return null;
  const d = businessData({ env, region, service: id });
  return { svc: d.services[0], issues: d.issues };
}

// Plain-language summary lines for the top of the page
export function summaryLines(d, money) {
  const lines = [];
  const missed = d.services.filter((s) => !s.met);
  const k = d.kpi;
  lines.push({ tone: missed.length ? 'warn' : 'good', text: missed.length
    ? `${k.slaMet} of ${k.slaTotal} customer services met their promised uptime this month. ${missed.map((s) => s.name).join(' and ')} fell short.`
    : `All ${k.slaTotal} customer services met their promised uptime this month.` });
  if (d.issues[0]) {
    const x = d.issues[0];
    lines.push({ tone: 'bad', text: `The costliest problem was "${x.title}" (${Math.round(x.impactMin)} minutes, about ${money(x.revenueAtRisk)} in sales at risk). ${x.status === 'resolved' ? 'It is fixed.' : 'The team is still working on it.'}` });
  }
  lines.push({ tone: k.ordersChange >= 0 ? 'good' : 'warn', text: `Orders are ${k.ordersChange >= 0 ? 'up' : 'down'} ${Math.abs(k.ordersChange).toFixed(1)}% on last month. Customer rating is ${k.satisfaction.toFixed(1)} out of 5.` });
  const open = d.issues.filter((x) => x.status !== 'resolved');
  lines.push({ tone: open.length ? 'warn' : 'good', text: open.length ? `${open.length} customer-facing problem${open.length > 1 ? 's are' : ' is'} open right now.` : 'No customer-facing problems are open right now.' });
  return lines;
}

export const pickRegionLabel = (v) => (REGIONS.find(([k]) => k === v)?.[1]) || 'All regions';
export { pick };
