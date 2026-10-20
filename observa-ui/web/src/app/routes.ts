// Every page: sidebar section, path, the permission it needs and the module it belongs to.
// A page with a module is shown only when that module is enabled for the deployment (Settings > Modules)
// AND the user has the permission. Pages without a module (Overview, Data Sources, Settings) are shared.
// Kept free of React imports so permission checks (canOpen) can use it anywhere.

export type IconName =
  | 'overview' | 'dashboards' | 'metrics' | 'logs' | 'traces' | 'services' | 'infrastructure'
  | 'alerting' | 'agents' | 'datasources' | 'settings';

export interface SubItem { path: string; label: string; perm?: string; keywords?: string }
export interface NavItem { path: string; label: string; icon: IconName; perm?: string; module?: string; keywords?: string; children?: SubItem[] }
export interface NavSection { title: string | null; items: NavItem[] }

/** Alerts sub-pages (one page component, Alerting.tsx, shows the right one) */
export const ALERT_PAGES: SubItem[] = [
  { path: '/alerting', label: 'Overview', keywords: 'alerts summary' },
  { path: '/alerting/active', label: 'Active Alerts', keywords: 'firing pending resolved' },
  { path: '/alerting/rules', label: 'Alert Rules', keywords: 'rules create alert' },
  { path: '/alerting/policies', label: 'Notification Policies', keywords: 'routing who gets what' },
  { path: '/alerting/channels', label: 'Notification Channels', keywords: 'slack teams email webhook pagerduty' },
  { path: '/alerting/silences', label: 'Silences', keywords: 'mute maintenance' },
  { path: '/alerting/inhibition', label: 'Inhibition', keywords: 'suppress muted' },
];

export const NAV_SECTIONS: NavSection[] = [
  { title: null, items: [{ path: '/overview', label: 'Overview', icon: 'overview', keywords: 'home summary' }] },
  {
    title: 'Observe',
    items: [
      { path: '/dashboards', label: 'Dashboards', icon: 'dashboards', module: 'dashboards' },
      { path: '/metrics', label: 'Metrics', icon: 'metrics', module: 'metrics', keywords: 'promql prometheus explorer' },
      { path: '/logs', label: 'Logs', icon: 'logs', module: 'logs', keywords: 'loki logql search' },
      { path: '/traces', label: 'Traces', icon: 'traces', module: 'traces', keywords: 'tempo spans apm' },
    ],
  },
  { title: 'Applications', items: [{ path: '/services', label: 'Services', icon: 'services', module: 'services', keywords: 'apm red latency errors' }] },
  { title: 'Infrastructure', items: [{ path: '/infrastructure', label: 'Infrastructure', icon: 'infrastructure', module: 'infrastructure', keywords: 'hosts servers nodes' }] },
  { title: 'Respond', items: [{ path: '/alerting', label: 'Alerts', icon: 'alerting', module: 'alerting', keywords: 'alerting alerts rules silences notifications', children: ALERT_PAGES }] },
  {
    title: 'Platform',
    items: [
      { path: '/agents', label: 'Agents', icon: 'agents', module: 'agents', keywords: 'install fleet tokens' },
      { path: '/datasources', label: 'Data Sources', icon: 'datasources', keywords: 'prometheus loki tempo alertmanager' },
      { path: '/settings', label: 'Settings', icon: 'settings', keywords: 'users roles teams api keys audit modules profile' },
    ],
  },
];

/** Routes that are not menu items (detail pages): they belong to a menu item */
const DETAIL_ROUTES: { match: RegExp; navPath: string }[] = [
  { match: /^\/dashboards\/[^/]+$/, navPath: '/dashboards' },
  { match: /^\/metrics\/(explore|kubernetes|investigate|host\/[^/]+)$/, navPath: '/metrics' },
  { match: /^\/infrastructure\/add$/, navPath: '/infrastructure' },
  { match: /^\/alerting\/alert\/[0-9]+$/, navPath: '/alerting' },
  { match: /^\/alerting\/(active|rules|policies|channels|silences|inhibition)$/, navPath: '/alerting' },
  { match: /^\/alerting\/open$/, navPath: '/alerting' },
];

export function findRoute(path: string): (NavItem & { navPath: string }) | null {
  for (const d of DETAIL_ROUTES) {
    if (d.match.test(path)) {
      const parent = findRoute(d.navPath);
      return parent ? { ...parent, navPath: d.navPath } : null;
    }
  }
  for (const s of NAV_SECTIONS) {
    for (const i of s.items) {
      if (path === i.path) return { ...i, navPath: i.path };
    }
  }
  return null;
}
