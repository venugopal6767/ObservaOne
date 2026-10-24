// The one status vocabulary for servers and agents. Infrastructure, Agents, Overview, Metrics and the host page
// all use these five words, in this order (the server decides the status: src/health.js).
//   Up · Down · Not reporting · Offline · Disabled
// "Needs attention" is a flag shown next to the status (problems, outdated agent), never a status of its own.
import type { Tone } from '@/components/ui';

export type HostStatus = 'up' | 'down' | 'not_reporting' | 'offline' | 'disabled';
export const HOST_STATUSES: HostStatus[] = ['up', 'down', 'not_reporting', 'offline', 'disabled'];

export const STATUS_META: Record<HostStatus, { label: string; tone: Tone; hint: string; color: string }> = {
  up: { label: 'Up', tone: 'solid-green', hint: 'Reporting normally', color: 'var(--ok)' },
  down: { label: 'Down', tone: 'solid-red', hint: 'Not answering: the host or its exporter is down, or it cannot be scraped', color: 'var(--crit)' },
  not_reporting: { label: 'Not reporting', tone: 'stale', hint: 'No data recently. The host may be fine; the agent or network may have stopped.', color: 'var(--unknown)' },
  offline: { label: 'Offline', tone: 'red', hint: 'Silent for longer than the offline threshold', color: 'var(--unknown)' },
  disabled: { label: 'Disabled', tone: 'muted', hint: 'Blocked by an administrator: its data is refused', color: 'var(--unknown)' },
};

/** anything outside the vocabulary (old API, Prometheus "unknown") is "Not reporting", never green or red */
export const asStatus = (s: string | null | undefined): HostStatus => (HOST_STATUSES.includes(s as HostStatus) ? (s as HostStatus) : 'not_reporting');

/** live values (CPU, memory, disk) are shown only for a host that is up; anything else shows "—" + last seen */
export const showsLive = (s: string | null | undefined) => asStatus(s) === 'up';

export interface StatusCounts { total: number; up: number; down: number; notReporting: number; offline: number; disabled: number }
export function countStatuses(rows: { health?: string; hostStatus?: string }[]): StatusCounts {
  const c: StatusCounts = { total: rows.length, up: 0, down: 0, notReporting: 0, offline: 0, disabled: 0 };
  for (const r of rows) {
    const s = asStatus(r.hostStatus ?? r.health);
    c[s === 'not_reporting' ? 'notReporting' : s]++;
  }
  return c;
}

/** "3 up · 1 down · 2 not reporting": only the non-zero parts after "up" */
export function statusParts(c: StatusCounts): [HostStatus, number][] {
  return ([['up', c.up], ['down', c.down], ['not_reporting', c.notReporting], ['offline', c.offline], ['disabled', c.disabled]] as [HostStatus, number][])
    .filter(([k, n]) => k === 'up' || n > 0);
}

/** sort order: problems first */
export const STATUS_RANK: Record<HostStatus, number> = { down: 0, offline: 1, not_reporting: 2, disabled: 3, up: 4 };
