// Data sources: where each kind of data comes from. Always real backends: there is no demo/sample mode.
// Admin changes are stored in PostgreSQL; a small in-memory copy keeps lookups fast.
import { currentTenant, isScoped, scopePromQL, scopeMatchers } from './tenancy.js';
import { config } from './config.js';
import { q } from './db.js';
import { httpError } from './auth.js';

export const DS_META = {
  prometheus: { name: 'Prometheus', kind: 'Metrics', modes: ['live'] },
  alertmanager: { name: 'Alertmanager', kind: 'Alerts', modes: ['live'] },
  loki: { name: 'Loki', kind: 'Logs', modes: ['live'] },
  tempo: { name: 'Tempo', kind: 'Traces', modes: ['live'] },
  services: { name: 'Service metrics', kind: 'App RED metrics', modes: ['live'] },
  grafana: { name: 'Grafana', kind: 'Dashboards', modes: ['live'] },
};

let saved = {};

// Re-read every 30 s so several UI containers see each other's changes.
export async function loadDatasourceSettings() {
  const { rows } = await q('SELECT id, url, mode FROM datasource_settings');
  saved = Object.fromEntries(rows.map((r) => [r.id, { ...(r.url ? { url: r.url } : {}), ...(r.mode ? { mode: r.mode } : {}) }]));
}
setInterval(() => loadDatasourceSettings().catch(() => {}), 30_000).unref();

export function getDatasources() {
  const out = {};
  for (const [id, def] of Object.entries(config.datasources)) {
    // "mode" is always live: an old saved "demo" value (before migration 4) is ignored
    out[id] = { id, ...DS_META[id], ...def, ...(saved[id] || {}), mode: 'live' };
  }
  return out;
}

export function ds(id) {
  return getDatasources()[id];
}

// The data source must have an address before we query it. No address = "not configured"
// (a different state from "configured but not reachable", which fetchJson reports as 502).
export function requireConfigured(id) {
  const d = ds(id);
  if (!d?.url) throw httpError(503, `${DS_META[id]?.name || id} is not configured. Set its address in Data Sources.`, { state: 'not_configured', source: id });
  return d;
}

export async function updateDatasource(id, { url, mode }, byUser) {
  if (!DS_META[id]) throw httpError(404, 'Unknown data source.');
  let cleanUrl = null;
  if (url !== undefined && id !== 'services') {
    if (!/^https?:\/\/[^\s]+$/.test(url)) throw httpError(400, 'URL must start with http:// or https://');
    cleanUrl = url.replace(/\/+$/, '');
  }
  if (mode !== undefined && !DS_META[id].modes.includes(mode)) throw httpError(400, `Mode must be one of: ${DS_META[id].modes.join(', ')}`);
  await q(`INSERT INTO datasource_settings (id, url, mode, updated_at, updated_by) VALUES ($1, $2, $3, now(), $4)
           ON CONFLICT (id) DO UPDATE SET url = COALESCE($2, datasource_settings.url), mode = COALESCE($3, datasource_settings.mode),
             updated_at = now(), updated_by = $4`, [id, cleanUrl, mode ?? null, byUser || null]);
  await loadDatasourceSettings();
}

// ---- HTTP helper with timeout ----
export async function fetchJson(url, { method = 'GET', body, headers = {}, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      body,
      headers: { Accept: 'application/json', ...headers },
      signal: ctrl.signal,
    });
  } catch (e) {
    throw httpError(502, `Cannot reach ${new URL(url).host}: ${e.name === 'AbortError' ? 'timeout' : e.cause?.code || e.message}`, { state: 'unavailable' });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data?.error || data?.message || data?.raw || res.statusText;
    throw httpError(res.status >= 500 ? 502 : 400, `${String(msg).slice(0, 300)}`, res.status >= 500 ? { state: 'unavailable' } : undefined);
  }
  return data;
}

// ---- Prometheus ----
export async function prom(path, params = {}) {
  const base = ds('prometheus').url;
  // a user of a non-default tenant only ever queries that tenant's series (tenancy.js)
  const tenant = currentTenant();
  if (isScoped(tenant)) {
    params = { ...params };
    try {
      if (params.query) params.query = scopePromQL(params.query, tenant);
      if (path.startsWith('/api/v1/label') || path === '/api/v1/series') params['match[]'] = scopeMatchers(params['match[]'], tenant);
    } catch (e) {
      throw httpError(400, `This query cannot be run for your organisation: ${e.message}`);
    }
  }
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => body.append(k, x));
    else if (v !== undefined && v !== null && v !== '') body.append(k, String(v));
  }
  const usePost = path === '/api/v1/query' || path === '/api/v1/query_range';
  const url = usePost ? `${base}${path}` : `${base}${path}?${body}`;
  const r = await fetchJson(url, usePost
    ? { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    : {});
  if (r?.status !== 'success') throw httpError(400, r?.error || 'Prometheus error');
  if (isScoped(tenant) && path === '/api/v1/targets' && r.data?.activeTargets) {
    return { ...r.data, activeTargets: r.data.activeTargets.filter((t) => t.labels?.tenant === tenant), droppedTargets: [] };
  }
  return r.data;
}

export async function promInstant(query) {
  const data = await prom('/api/v1/query', { query });
  return data.result || [];
}

// ---- Alertmanager ----
export async function am(path, opts) {
  return fetchJson(`${ds('alertmanager').url}${path}`, opts);
}

// ---- Connection tests ----
export async function testDatasource(id) {
  const d = ds(id);
  if (!d) throw httpError(404, 'Unknown data source.');
  const started = Date.now();
  try {
    if (id === 'services') {
      await prom('/api/v1/query', { query: 'vector(1)' });
      return { ok: true, mode: 'live', message: 'Uses Prometheus', ms: Date.now() - started };
    }
    if (!d.url) return { ok: false, mode: 'live', message: 'Not configured' };
    const paths = {
      prometheus: '/-/ready',
      alertmanager: '/-/ready',
      loki: '/ready',
      tempo: '/ready',
      grafana: '/api/health',
    };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${d.url}${paths[id]}`, { signal: ctrl.signal }).finally(() => clearTimeout(t));
    const txt = (await res.text()).slice(0, 120).trim();
    return { ok: res.ok, mode: 'live', message: res.ok ? 'Connected' : `HTTP ${res.status}: ${txt}`, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, mode: d.mode, message: e.name === 'AbortError' ? 'Timeout after 5s' : e.cause?.code || e.message };
  }
}
