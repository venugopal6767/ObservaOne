// Multi-tenancy (Phase 6).
//
// Every agent, token, target and settings layer belongs to a tenant (t_default until a second one exists). The
// tenant comes from the credential (agents) or the signed-in user (UI), never from a request field.
//
//   - Users of the default tenant (the operator of the platform) see every tenant, like today.
//   - Users of any other tenant see only their own agents, tokens and targets (others answer 404, not 403), and
//     every Prometheus query they run is rewritten so each vector selector also matches tenant="<theirs>".
//   - Series from a non-default tenant's agents carry tenant="<id>", set by the server (relabel / discovery),
//     so an agent cannot claim another tenant.
//
// The request's tenant is kept in AsyncLocalStorage, so the Prometheus helpers (datasources.js) scope queries
// for every route without each route passing it along.
import { AsyncLocalStorage } from 'node:async_hooks';

export const DEFAULT_TENANT = 't_default';
export const TENANT_RE = /^t_[a-z0-9][a-z0-9_-]{0,40}$/;
export const tenantStore = new AsyncLocalStorage();

// Express middleware (after authentication)
export function tenantContext(req, res, next) {
  const tenant = req.user?.tenant || DEFAULT_TENANT;
  tenantStore.run({ tenant }, () => next());
}

export const currentTenant = () => tenantStore.getStore()?.tenant || DEFAULT_TENANT;
export const isScoped = (t = currentTenant()) => t !== DEFAULT_TENANT;

// SQL helper: "AND <col> = $n" for scoped users, nothing for the default tenant.
export function tenantFilter(col, params, t = currentTenant()) {
  if (!isScoped(t)) return '';
  params.push(t);
  return ` AND ${col} = $${params.length}`;
}

// ---------------- PromQL scoping ----------------

const KEYWORDS = new Set(['and', 'or', 'unless', 'bool', 'offset', 'by', 'without', 'on', 'ignoring', 'group_left', 'group_right', 'atan2', 'inf', 'nan']);
const LABEL_LIST = new Set(['by', 'without', 'on', 'ignoring', 'group_left', 'group_right']);
const AGGREGATIONS = new Set(['sum', 'min', 'max', 'avg', 'group', 'stddev', 'stdvar', 'count', 'count_values', 'bottomk', 'topk', 'quantile', 'limitk', 'limit_ratio']);

function readString(s, i) {
  const q = s[i];
  let j = i + 1;
  while (j < s.length && s[j] !== q) j += s[j] === '\\' && q !== '`' ? 2 : 1;
  if (j >= s.length) throw new Error('unterminated string');
  return j + 1;
}

// returns the index just after the bracket that closes the one at i ('{' or '(' or '['), skipping strings
function closeOf(s, i) {
  const open = s[i], close = { '{': '}', '(': ')', '[': ']' }[open];
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '"' || c === "'" || c === '`') { j = readString(s, j) - 1; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return j + 1;
  }
  throw new Error(`unbalanced ${open}`);
}

const skipWs = (s, i) => { while (i < s.length && /\s/.test(s[i])) i++; return i; };

// Adds tenant="<t>" to every vector selector of a PromQL expression.
//   up                      -> up{tenant="t"}
//   rate(x{a="b"}[5m])      -> rate(x{tenant="t",a="b"}[5m])
//   sum by (host) ({__name__=~"node_.*"}) -> sum by (host) ({tenant="t",__name__=~"node_.*"})
// Throws on an expression it cannot read (the query is refused rather than run unscoped).
export function scopePromQL(expr, tenant) {
  if (!TENANT_RE.test(tenant)) throw new Error('bad tenant');
  const m = `tenant="${tenant}"`;
  const s = String(expr);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') { const j = readString(s, i); out += s.slice(i, j); i = j; continue; }
    if (c === '[') { const j = closeOf(s, i); out += s.slice(i, j); i = j; continue; } // range / subquery step
    if (c === '{') { // selector without a metric name
      const j = closeOf(s, i);
      const inner = s.slice(i + 1, j - 1).trim();
      out += `{${m}${inner ? `,${inner}` : ''}}`;
      i = j;
      continue;
    }
    if (/[0-9.]/.test(c) && !/[A-Za-z_:]/.test(s[i - 1] || '')) { // number or duration (5m, 1e3, 0.5)
      let j = i;
      while (j < s.length && /[0-9.eEa-zA-Z_+]/.test(s[j]) && !(s[j] === '+' && !/[eE]/.test(s[j - 1]))) j++;
      out += s.slice(i, j); i = j;
      continue;
    }
    if (/[A-Za-z_:]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_:]/.test(s[j])) j++;
      const word = s.slice(i, j);
      const k = skipWs(s, j);
      const lower = word.toLowerCase();
      if (LABEL_LIST.has(lower)) { // by (a, b) / group_left (x): copy the label list as it is
        out += s.slice(i, k);
        i = k;
        if (s[i] === '(') { const e = closeOf(s, i); out += s.slice(i, e); i = e; }
        continue;
      }
      if (KEYWORDS.has(lower)) { out += word; i = j; continue; }
      if (AGGREGATIONS.has(lower) && /^(by|without)\b/i.test(s.slice(k))) { out += word; i = j; continue; } // sum by (x) (...)
      if (s[k] === '(') { out += s.slice(i, k); i = k; continue; } // function or aggregation: its arguments follow
      if (s[k] === '{') { // metric{...}
        const e = closeOf(s, k);
        const inner = s.slice(k + 1, e - 1).trim();
        out += `${word}{${m}${inner ? `,${inner}` : ''}}`;
        i = e;
        continue;
      }
      out += `${word}{${m}}`; i = j;
      continue;
    }
    out += c; i++;
  }
  return out;
}

// label-value / series lookups take match[] selectors: scope each (or add one when there is none)
export function scopeMatchers(matchers, tenant) {
  const list = (Array.isArray(matchers) ? matchers : matchers ? [matchers] : []).filter(Boolean);
  if (!list.length) return [`{tenant="${tenant}"}`];
  return list.map((x) => scopePromQL(x, tenant));
}
