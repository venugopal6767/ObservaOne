// Pure helpers for the Traces page filtering (namespace/env via the Tempo query; service client-side).
export interface TraceFilter { namespace?: string; env?: string; service?: string }

/** Append namespace/env as Tempo tag filters to the base query (server-side filtering). */
export function buildTraceQuery(base: string, f: { namespace?: string; env?: string }): string {
  const parts = [base.trim()].filter(Boolean);
  if (f.namespace) parts.push(`k8s.namespace.name=${f.namespace}`);
  if (f.env) parts.push(`deployment.environment=${f.env}`);
  return parts.join(' ').trim();
}

/** Distinct, sorted root service names present in the result set (for the Service facet). */
export function distinctServices(traces: { rootService?: string | null }[]): string[] {
  return [...new Set(traces.map((t) => t.rootService).filter(Boolean) as string[])].sort();
}

export const FILTER_LABEL: Record<keyof TraceFilter, string> = { namespace: 'Namespace', env: 'Environment', service: 'Service' };

/** Active filters as [key,value] pairs, for removable chips. */
export function activeTraceFilters(f: TraceFilter): [keyof TraceFilter, string][] {
  return (Object.keys(FILTER_LABEL) as (keyof TraceFilter)[])
    .filter((k) => f[k]).map((k) => [k, f[k] as string]);
}
