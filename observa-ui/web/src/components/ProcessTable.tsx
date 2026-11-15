// Top processes of one server, used by the host view and the Investigation page.
//
// Process CPU is shown the same way as host CPU: as a share of the WHOLE server (100% = every core busy), so a
// process can never look busier than its host. The raw value, CPU cores used (1.0 = one core fully busy), is shown
// next to it: that is what the process collector measures (seconds of CPU per second).
import { useQuery } from '@tanstack/react-query';
import { api, type PromVector } from '@/lib/api';
import { escapeLabel, fmt } from '@/lib/format';
import { toneClass } from '@/lib/theme';
import { ErrorState, StateView, TableWrap } from './ui';

export interface ProcRow { name: string; cores: number; share: number | null; mem?: number }

export function processQueries(host: string, win: boolean, n: number) {
  const h = `host="${escapeLabel(host)}"`;
  return win
    ? {
      cores: `topk(${n}, sum by (process) (rate(windows_process_cpu_time_total{${h}}[5m])))`,
      ncpu: `count(windows_cpu_time_total{mode="idle", core!="", ${h}})`,
      mem: `sum by (process) (windows_process_working_set_private_bytes{${h}})`,
    }
    : {
      cores: `topk(${n}, sum by (groupname) (rate(namedprocess_namegroup_cpu_seconds_total{${h}}[5m])))`,
      ncpu: `count(node_cpu_seconds_total{mode="idle", ${h}})`,
      mem: `sum by (groupname) (namedprocess_namegroup_memory_bytes{memtype="resident", ${h}})`,
    };
}

/** Query errors are thrown (shown as errors), never turned into "no data". */
export async function loadProcesses(host: string, win: boolean, n: number, time?: number): Promise<ProcRow[]> {
  const qs = processQueries(host, win, n);
  const get = (query: string) => api<{ result: PromVector }>('/prom/query', { query: { query, ...(time ? { time } : {}) } }).then((r) => r.result);
  const [cores, ncpu, mem] = await Promise.all([get(qs.cores), get(qs.ncpu), get(qs.mem)]);
  const n0 = ncpu[0] ? Number(ncpu[0].value[1]) : 0;
  const name = (m: Record<string, string>) => m.groupname || m.process || '?';
  const M = new Map(mem.map((x) => [name(x.metric), Number(x.value[1])]));
  return cores
    .map((x) => { const c = Number(x.value[1]); return { name: name(x.metric), cores: c, share: n0 > 0 ? (100 * c) / n0 : null, mem: M.get(name(x.metric)) }; })
    .sort((a, b) => b.cores - a.cores);
}

export function useProcesses(host: string, win: boolean, n: number, time?: number) {
  return useQuery({ queryKey: ['procs', host, win, n, time ?? 'now'], queryFn: () => loadProcesses(host, win, n, time), refetchInterval: time ? false : 30_000 });
}

export function ProcessTable({ q, win, emptyText, compact }: { q: ReturnType<typeof useProcesses>; win: boolean; emptyText?: string; compact?: boolean }) {
  if (q.isPending) return <StateView kind="loading" skeleton="table" />;
  if (q.isError) return <ErrorState error={q.error} what="Processes" />;
  if (!q.data.length) {
    return <StateView kind="empty" title="No process data for this host"
      text={emptyText || (win ? 'Enable the process collector in windows_exporter to see processes.' : 'Turn on the processes collector of the ObservaOne Agent (on by default), or install process-exporter next to node_exporter.')} />;
  }
  return (
    <TableWrap label="Processes">
      <table className="tbl compact">
        <thead><tr>
          <th>Process</th>
          <th className="num" title="Share of the whole server, like host CPU: 100% = every core busy">{compact ? 'CPU' : 'CPU (% of server)'}</th>
          {!compact && <th className="num" title="CPU cores used: 1.0 = one core fully busy">Cores</th>}
          <th className="num">Memory</th>
        </tr></thead>
        <tbody>{q.data.map((r) => (
          <tr key={r.name}>
            <td className="mono">{r.name}</td>
            <td className={`num ${r.share === null ? '' : toneClass(r.share)}`}>{r.share === null ? '-' : `${r.share.toFixed(1)}%`}</td>
            {!compact && <td className="num">{r.cores.toFixed(2)}</td>}
            <td className="num">{r.mem === undefined ? '-' : fmt(r.mem, 'bytes')}</td>
          </tr>
        ))}</tbody>
      </table>
    </TableWrap>
  );
}
