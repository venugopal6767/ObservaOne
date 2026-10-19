// Host labels typed as "key=value, key=value": the same rules as the installer and the server.
const KEY = /^[a-z][a-z0-9_]{0,30}$/;
const VAL = /^[A-Za-z0-9._-]{1,64}$/;
const RESERVED = new Set(['host', 'job', 'instance', 'agent', 'agent_id', 'platform', 'os', 'env', 'role', 'tenant', '__name__']);

export function parseLabels(text: string): { labels: string[]; map: Record<string, string>; errors: string[] } {
  const labels: string[] = [], errors: string[] = [], map: Record<string, string> = {};
  const items = text.split(',').map((x) => x.trim()).filter(Boolean);
  for (const item of items) {
    const i = item.indexOf('=');
    if (i < 0) { errors.push(`"${item}" needs a name: write it as name=value, e.g. team=${item}`); continue; }
    const k = item.slice(0, i).trim(), v = item.slice(i + 1).trim();
    if (!KEY.test(k)) errors.push(`"${k}": label names are lower case a-z, 0-9 and _, starting with a letter`);
    else if (RESERVED.has(k)) errors.push(`"${k}" is set by ObservaOne itself${k === 'env' || k === 'role' ? ` (use the ${k === 'env' ? 'Environment' : 'Role'} field)` : ''}`);
    else if (!VAL.test(v)) errors.push(`${k}: the value is letters, digits, . _ - (1-64 characters)`);
    else if (k in map) errors.push(`${k} is given twice`);
    else { map[k] = v; labels.push(`${k}=${v}`); }
  }
  if (labels.length > 10) errors.push('At most 10 labels.');
  return { labels, map, errors };
}
