// Every page in the app: sidebar sections, routes, the permission each one needs and the module it belongs to.
// A page with a module is shown only when that module is enabled for the deployment (Settings > Modules)
// AND the user has the permission. Pages without a module (Overview, Data Sources, Settings) are shared.
import { overviewPage } from './overview.js';
import { dashboardsPage, dashboardViewPage } from './dashboards.js';
import { metricsPage } from './metrics.js';
import { logsPage } from './logs.js';
import { tracesPage } from './traces.js';
import { servicesPage } from './services.js';
import { infrastructurePage } from './infrastructure.js';
import { alertingPage } from './alerting.js';
import { datasourcesPage } from './datasources.js';
import { settingsPage } from './settings.js';
import { agentsPage } from './agents.js';

const P = (path, label, icon, render, perm, module) => ({ path, label, icon, render, perm, module });

export const NAV_SECTIONS = [
  { title: null, items: [P('/overview', 'Overview', 'overview', overviewPage)] },
  {
    title: 'Observe',
    items: [
      P('/dashboards', 'Dashboards', 'dashboards', dashboardsPage, null, 'dashboards'),
      P('/metrics', 'Metrics', 'metrics', metricsPage, null, 'metrics'),
      P('/logs', 'Logs', 'logs', logsPage, null, 'logs'),
      P('/traces', 'Traces', 'traces', tracesPage, null, 'traces'),
    ],
  },
  { title: 'Applications', items: [P('/services', 'Services', 'services', servicesPage, null, 'services')] },
  { title: 'Infrastructure', items: [P('/infrastructure', 'Infrastructure', 'infrastructure', infrastructurePage, null, 'infrastructure')] },
  { title: 'Respond', items: [P('/alerting', 'Alerting', 'alerting', alertingPage, null, 'alerting')] },
  {
    title: 'Platform',
    items: [
      P('/agents', 'Agents', 'agent', agentsPage, null, 'agents'),
      P('/datasources', 'Data Sources', 'datasources', datasourcesPage),
      P('/settings', 'Settings', 'settings', settingsPage),
    ],
  },
];

// Routes that are not menu items (detail pages)
export const EXTRA_ROUTES = [
  { match: /^\/dashboards\/[^/]+$/, render: dashboardViewPage, navPath: '/dashboards', module: 'dashboards' },
];
