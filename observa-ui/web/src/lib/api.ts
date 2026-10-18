// API client for the observa-ui Express backend (/api). Same contract as the old UI:
// - GET needs nothing special; every other method sends X-Requested-With: observa (CSRF guard on the server)
// - a 401 anywhere (except the login call) fires "oo:unauthorized" so the app can show the sign-in page
// - errors keep the server's "state" (unavailable / not_configured / module_disabled) so pages can show the right state

export type DataState = 'unavailable' | 'not_configured' | 'module_disabled' | null;

export class ApiError extends Error {
  status: number;
  state: DataState;
  source: string | null;
  constructor(message: string, opts: { status?: number; state?: DataState; source?: string | null } = {}) {
    super(message);
    this.status = opts.status ?? 0;
    this.state = opts.state ?? null;
    this.source = opts.source ?? null;
  }
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export function buildUrl(path: string, query?: Query): string {
  let url = `/api${path}`;
  if (query) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    const s = q.toString();
    if (s) url += `?${s}`;
  }
  return url;
}

export async function api<T = unknown>(path: string, { method = 'GET', body, query, signal }: { method?: string; body?: unknown; query?: Query; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(buildUrl(path, query), {
    method,
    credentials: 'same-origin',
    signal,
    headers: { 'X-Requested-With': 'observa', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && path !== '/login' && path !== '/login/mfa') {
    window.dispatchEvent(new CustomEvent('oo:unauthorized', { detail: data?.error }));
  }
  if (!res.ok) throw new ApiError(data?.error || `HTTP ${res.status}`, { status: res.status, state: data?.state ?? null, source: data?.source ?? null });
  return data as T;
}

// ---- shapes returned by the backend (only the fields the UI reads) ----
export interface User {
  username: string; displayName?: string; email?: string; phone?: string; role: string;
  permissions: string[]; authSource: string; mfaEnabled?: boolean; lastLogin?: string; restricted?: string;
}
export interface Me {
  user: User; brand: string; sessionIdleMinutes: number; rulesEditable: boolean; demoData?: boolean;
  modules: string[]; prefs: Record<string, any>;
}
export type PromVector = { metric: Record<string, string>; value: [number, string] }[];
export type PromMatrix = { metric: Record<string, string>; values: [number, string][] }[];
export interface PromResult<R = PromMatrix> { resultType: string; result: R }
