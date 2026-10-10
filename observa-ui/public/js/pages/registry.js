// Every page in the app: sidebar entries (with the line under each name), routes and the permission each needs.
import { overviewPage } from './overview.js';
import { dashboardsPage, dashboardViewPage } from './dashboards.js';
import { metricsPage } from './metrics.js';
import { logsPage, logDetailPage } from './logs.js';
import { tracesPage, traceDetailPage } from './traces.js';
import { servicesPage, serviceDetailPage } from './services.js';
import { infrastructurePage } from './infrastructure.js';
import { alertingPage } from './alerting.js';
import { datasourcesPage } from './datasources.js';
import { settingsPage } from './settings.js';
import { agentsPage } from './agents.js';
import { incidentsPage, incidentDetailPage } from './incidents.js';
import { insightsPage } from './insights.js';
import { viewsPage } from './views.js';
import { canOpen, personaById } from '../personas/registry.js';

const P = (path, label, icon, render, sub, extra = {}) => ({ path, label, icon, render, sub, ...extra });

// One flat list, in the order of the design. `badge`: 'incidents' = live count, 'ai' = AI tag.
// Menu groups follow the brief (Observe / Investigate / Analyze / Manage) and point at existing pages only.
// `when` hides an item the user cannot use; `activeWhen` marks an item active for a page shared with another item.
export const NAV_SECTIONS = [
  {
    title: null,
    items: [
      P('/views', 'Home', 'home', viewsPage, 'Your role dashboard'),
    ],
  },
  {
    title: 'Observe',
    items: [
      P('/overview', 'Overview', 'overview', overviewPage, 'Live health of everything'),
      P('/services', 'Services', 'services', servicesPage, 'Service health and dependencies'),
      P('/infrastructure', 'Infrastructure', 'infrastructure', infrastructurePage, 'Hosts, containers and Kubernetes nodes'),
      P('/views/kubernetes', 'Kubernetes', 'cube', viewsPage, 'Clusters, namespaces, workloads, pods', { when: (ctx) => canOpen(personaById('kubernetes'), ctx.can) }),
    ],
  },
  {
    title: 'Investigate',
    items: [
      P('/incidents', 'Incidents', 'incident', incidentsPage, 'Alerts grouped into incidents', { badge: 'incidents' }),
      P('/logs', 'Logs', 'logs', logsPage, 'Search and analyze logs'),
      P('/traces', 'Traces', 'traces', tracesPage, 'Request flows and spans'),
    ],
  },
  {
    title: 'Analyze',
    items: [
      P('/metrics', 'Metrics', 'metrics', metricsPage, 'Explore time-series data'),
      P('/dashboards', 'Dashboards', 'dashboards', dashboardsPage, 'Your own, shared and built-in dashboards'),
      P('/insights', 'Insights', 'insights', insightsPage, 'Forecasts and anomalies (statistics)'),
    ],
  },
  {
    title: 'Manage',
    items: [
      P('/datasources', 'Data Sources', 'datasources', datasourcesPage, 'Connections and health'),
      P('/agents', 'Agents', 'agent', agentsPage, 'Install and manage agents'),
      P('/alerting', 'Alert Rules', 'bell', alertingPage, 'Alert rules, silences and notifications'),
      P('/settings?tab=users', 'Users & Roles', 'user', settingsPage, 'Users, roles, teams and dashboards per role',
        { perm: 'users.manage', activeWhen: (path, params) => path === '/settings' && ['users', 'roles', 'teams'].includes(params.get('tab')) }),
      P('/settings', 'Settings', 'settings', settingsPage, 'Profile, security and system',
        { activeWhen: (path, params) => path === '/settings' && !['users', 'roles', 'teams'].includes(params.get('tab')) }),
    ],
  },
];

// Routes that are not menu items (detail pages). navPath = the menu item kept highlighted.
export const EXTRA_ROUTES = [
  { match: /^\/dashboards\/[^/]+$/, render: dashboardViewPage, navPath: '/dashboards' },
  { match: /^\/services\/[^/]+$/, render: serviceDetailPage, navPath: '/services' },
  { match: /^\/incidents\/\d+$/, render: incidentDetailPage, navPath: '/incidents' },
  { match: /^\/logs\/detail$/, render: logDetailPage, navPath: '/logs' },
  { match: /^\/traces\/[0-9a-fA-F]{8,64}$/, render: traceDetailPage, navPath: '/traces' },
];
