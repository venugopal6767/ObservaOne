// Global filter bar for the Metrics pages: Environment → Platform → Cluster → Service → Host.
// Choices come from real Prometheus label values and are saved per user, so they follow the user around.
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api } from '@/lib/api';
import type { Filters, Platform } from '@/lib/catalog';
import type { KnownValues } from '@/lib/ask';
import { useApp } from '@/app/AppContext';
import { Select } from './ui';

export function useLabelValues(label: string, match?: string) {
  return useQuery({
    queryKey: ['label-values', label, match || ''],
    queryFn: () => api<string[]>('/prom/label-values', { query: { label, match } }).catch(() => [] as string[]),
    staleTime: 60_000,
  });
}

/** every value the question matcher can recognise */
export function useKnownValues(): KnownValues {
  const hosts = useLabelValues('host');
  const envs = useLabelValues('env');
  const services = useLabelValues('service_name');
  const clusters = useLabelValues('cluster');
  const namespaces = useLabelValues('namespace');
  return { hosts: hosts.data || [], envs: envs.data || [], services: services.data || [], clusters: clusters.data || [], namespaces: namespaces.data || [] };
}

const PLATFORMS: [Platform | '', string][] = [['', 'All platforms'], ['linux', 'Linux'], ['windows', 'Windows'], ['kubernetes', 'Kubernetes']];

export function FilterBar({ show = ['env', 'platform', 'cluster', 'service', 'host'] }: { show?: (keyof Filters)[] }) {
  const { filters, setFilters } = useApp();
  const envs = useLabelValues('env');
  const clusters = useLabelValues('cluster');
  const services = useLabelValues('service_name');
  // hosts narrow to the chosen environment
  const hosts = useLabelValues('host', filters.env ? `up{env="${filters.env.replace(/"/g, '\\"')}"}` : undefined);
  const set = (k: keyof Filters, v: string) => setFilters({ ...filters, [k]: v || undefined });
  const opts = (all: string, vals?: string[], cur?: string) => {
    const list = [...new Set([...(vals || []), ...(cur ? [cur] : [])])].sort();
    return [['', all] as [string, string], ...list.map((v) => [v, v] as [string, string])];
  };
  const active = Object.values(filters).filter(Boolean).length;
  return (
    <div className="filter-bar" role="group" aria-label="Filters">
      {show.includes('env') && <Select className={`select select-sm ${filters.env ? 'on' : ''}`} label="Environment" value={filters.env || ''} onChange={(v) => set('env', v)} options={opts('All environments', envs.data, filters.env)} />}
      {show.includes('platform') && <Select className={`select select-sm ${filters.platform ? 'on' : ''}`} label="Platform" value={filters.platform || ''} onChange={(v) => set('platform', v)} options={PLATFORMS} />}
      {show.includes('cluster') && <Select className={`select select-sm ${filters.cluster ? 'on' : ''}`} label="Cluster" value={filters.cluster || ''} onChange={(v) => set('cluster', v)} options={opts('All clusters', clusters.data, filters.cluster)} />}
      {show.includes('service') && <Select className={`select select-sm ${filters.service ? 'on' : ''}`} label="Service" value={filters.service || ''} onChange={(v) => set('service', v)} options={opts('All services', services.data, filters.service)} />}
      {show.includes('host') && <Select className={`select select-sm ${filters.host ? 'on' : ''}`} label="Host" value={filters.host || ''} onChange={(v) => set('host', v)} options={opts('All hosts', hosts.data, filters.host)} />}
      {active > 0 && <button className="btn btn-sm btn-ghost" onClick={() => setFilters({})}><X size={13} />Clear filters</button>}
    </div>
  );
}
