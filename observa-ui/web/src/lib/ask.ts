// Built-in plain-English questions -> a builder state (no AI, runs in the browser, instant).
// "Which servers are using most CPU?", "memory of windows servers", "disk space less than 20%",
// "top 10 processes by cpu", "error rate of checkout", "pods restarting in payments".
// Names of hosts, environments, services, clusters and namespaces are matched against the real label
// values from Prometheus, so "cpu of db-01" filters on host="db-01".
import { METRICS, metricById, type Combine, type Filters } from './catalog';

export interface AskResult {
  metric: string; filters: Filters; by?: string; fn?: Combine; topk?: number; op?: '>' | '<'; value?: number;
  /** what was understood, word for word, so the user can check it */
  understood: string[];
}
export interface KnownValues { hosts: string[]; envs: string[]; services: string[]; clusters: string[]; namespaces: string[] }

const has = (t: string, w: string) => new RegExp(`(^|[^a-z0-9_-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9_-])`, 'i').test(t);

export function understand(question: string, known: KnownValues): AskResult | null {
  const t = ` ${question.toLowerCase().replace(/[?!,]/g, ' ').replace(/\s+/g, ' ')} `;
  const understood: string[] = [];

  // 1. which metric: longest keyword that appears wins ("pod memory" beats "memory")
  let best: { id: string; len: number } | null = null;
  for (const m of METRICS) for (const k of m.keywords) if (has(t, k) && (!best || k.length > best.len)) best = { id: m.id, len: k.length };
  // "restart" in a kubernetes sense; "space" means disk
  if (!best) return null;
  let metric = best.id;
  const kube = /\b(pod|pods|namespace|container|kubernetes|k8s|cluster)\b/.test(t);
  if (kube && metric === 'cpu') metric = 'pod_cpu';
  if (kube && metric === 'memory') metric = 'pod_memory';
  const d = metricById(metric)!;
  understood.push(`metric: ${d.name}`);

  // 2. filters from real label values
  const filters: Filters = {};
  const pick = (vals: string[], key: keyof Filters, label: string) => {
    const v = [...vals].sort((a, b) => b.length - a.length).find((x) => x && has(t, x.toLowerCase()));
    if (v) { (filters as Record<string, string>)[key] = v; understood.push(`${label}: ${v}`); }
  };
  pick(known.hosts, 'host', 'host');
  pick(known.envs, 'env', 'environment');
  pick(known.services, 'service', 'service');
  pick(known.clusters, 'cluster', 'cluster');
  pick(known.namespaces, 'namespace', 'namespace');
  if (!filters.env) for (const [w, v] of [['production', 'prod'], ['prod', 'prod'], ['uat', 'uat'], ['staging', 'staging'], ['dev', 'dev']] as const) {
    if (has(t, w) && known.envs.includes(v)) { filters.env = v; understood.push(`environment: ${v}`); break; }
  }
  if (/\bwindows\b/.test(t)) { filters.platform = 'windows'; understood.push('platform: Windows'); }
  else if (/\blinux\b/.test(t)) { filters.platform = 'linux'; understood.push('platform: Linux'); }

  // 3. ranking: "top 5", "most", "highest", "slowest", "lowest", "least"
  let topk: number | undefined;
  const tm = /\btop\s+(\d{1,3})\b/.exec(t);
  if (tm) topk = Math.min(50, Number(tm[1]));
  else if (/\b(top|most|highest|slowest|busiest|biggest|worst)\b/.test(t)) topk = 5;
  let fn: Combine | undefined;
  if (/\b(lowest|least|minimum|min)\b/.test(t)) { fn = 'min'; topk = topk ?? 5; }
  else if (/\b(max|maximum|peak|highest)\b/.test(t)) fn = 'max';
  else if (/\b(total|sum|all together)\b/.test(t)) fn = 'sum';
  if (topk) understood.push(`top ${topk}`);

  // 4. comparison: "above 80", "more than 90%", "less than 20%", "below 10"
  let op: '>' | '<' | undefined, value: number | undefined;
  const cm = /\b(above|over|more than|greater than|higher than|exceeds?|>)\s*(\d+(?:\.\d+)?)\s*%?/.exec(t)
    || /\b(below|under|less than|lower than|<)\s*(\d+(?:\.\d+)?)\s*%?/.exec(t);
  if (cm) {
    op = /below|under|less|lower|</.test(cm[1]) ? '<' : '>';
    value = Number(cm[2]);
    // "disk space less than 20%" means FREE space below 20%: as used space, that is above 80%
    if (metric === 'disk' && /\b(free|space left|available|space)\b/.test(t) && op === '<') { op = '>'; value = 100 - value; understood.push(`free space below ${cm[2]}% (used above ${value}%)`); }
    else understood.push(`${op === '>' ? 'above' : 'below'} ${value}${d.unit === 'percent' ? '%' : ''}`);
  }

  // 5. split: "per pod", "by namespace", "per process", "per service"
  let by: string | undefined;
  for (const o of d.byOptions) {
    const word = o === 'service_name' ? 'service' : o === 'groupname' ? 'process' : o;
    if (new RegExp(`\\b(per|by|each)\\s+${word}`).test(t)) { by = o; understood.push(`one line per ${word}`); }
  }
  // a filter on one host but nothing else: one line for that host is enough
  return { metric, filters, by, fn, topk, op, value, understood };
}

/** Quick questions offered as chips */
export const QUICK_QUESTIONS = [
  'Which servers are using most CPU?',
  'Show memory usage of windows servers',
  'Disk space less than 20%',
  'Network traffic in the last hour',
  'Top 10 processes by CPU',
  'Error rate per service',
  'Slowest services',
  'Pods restarting',
];
