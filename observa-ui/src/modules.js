// Product modules: which parts of ObservaOne this deployment uses.
//
// One source of truth, used by the API (to refuse disabled routes) and sent to the browser
// (to build the menu, search, Overview and links). A user reaches a module only when it is
// enabled here AND their role has the permission for it. Enabled does not mean working:
// a module can be on while its data source is down, and its pages then say so.
//
// Stored in the existing "settings" table under the key "modules": { "enabled": ["metrics", ...] }.
// No saved value (upgrades, first start) = every module on, so nothing that worked before disappears.
import { getSetting, setSetting } from './settings.js';
import { httpError } from './auth.js';

export const MODULES = [
  { id: 'metrics', name: 'Metrics', source: 'Prometheus', description: 'Metrics Explorer: query and chart any Prometheus metric.' },
  { id: 'infrastructure', name: 'Infrastructure', source: 'Prometheus', description: 'Servers and hosts: status, CPU, memory, disk. Feeds the CPU and memory parts of Overview.' },
  { id: 'dashboards', name: 'Dashboards', source: 'Prometheus', description: 'Built-in and custom dashboards made of Prometheus panels.' },
  { id: 'logs', name: 'Logs', source: 'Loki', description: 'Logs Explorer: search logs with LogQL.' },
  { id: 'traces', name: 'Traces', source: 'Tempo', description: 'Traces Explorer: search traces and see their spans.' },
  { id: 'services', name: 'Services', source: 'Prometheus (application metrics)', description: 'Request rate, latency and errors per application. Feeds the service parts of Overview.' },
  { id: 'alerting', name: 'Alerting', source: 'Alertmanager + Prometheus', description: 'Alerts, rules, silences and the alert bell.' },
  { id: 'agents', name: 'Agents', source: 'ObservaOne Agent', description: 'Install, list and manage ObservaOne Agents. Turning it off hides the page only; installed agents keep sending.' },
];
export const MODULE_IDS = MODULES.map((m) => m.id);

export async function enabledModules() {
  const s = await getSetting('modules');
  if (!s || !Array.isArray(s.enabled)) return [...MODULE_IDS];
  return MODULE_IDS.filter((id) => s.enabled.includes(id)); // drop unknown ids, keep catalog order
}

export async function moduleSettings() {
  const s = await getSetting('modules');
  return { configured: !!(s && Array.isArray(s.enabled)), enabled: await enabledModules() };
}

export async function setEnabledModules(list, by) {
  if (!Array.isArray(list)) throw httpError(400, '"enabled" must be a list of module ids.');
  const unknown = list.filter((id) => !MODULE_IDS.includes(id));
  if (unknown.length) throw httpError(400, `Unknown module: ${unknown.join(', ')}`);
  const enabled = MODULE_IDS.filter((id) => list.includes(id));
  await setSetting('modules', { enabled }, by);
  return enabled;
}

// Route guard. Pass several ids when a route serves several modules (e.g. Prometheus queries
// are used by Metrics, Infrastructure and Dashboards): it passes if ANY of them is on.
// A disabled module answers 404, the same as a page that does not exist.
export function requireModule(...ids) {
  return async (req, res, next) => {
    try {
      const on = await enabledModules();
      if (ids.some((id) => on.includes(id))) return next();
      next(httpError(404, 'This module is not enabled for this deployment.', { state: 'module_disabled' }));
    } catch (e) {
      next(e);
    }
  };
}
