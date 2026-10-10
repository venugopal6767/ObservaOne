// /views and /views/<persona>/...: the role-based landing dashboards.
import { h, icon, emptyState } from '../ui.js';
import { personaById, landingFor, personaPath, selectorEntries, canOpen } from '../personas/registry.js';
import { personaHead, setCrumbContext } from '../personas/widgets.js';
import { k8sDashboard, k8sNamespace, k8sWorkload, k8sPod, k8sNode } from '../personas/kubernetes.js';
import { itAdminDashboard, itAdminAgent, itAdminComponent, itAdminIngestion } from '../personas/itadmin.js';
import { securityDashboard, securityEvents, securityEvent, securityHost, securityIp } from '../personas/security.js';
import { appOwnerDashboard, appOwnerApp, appOwnerRelease } from '../personas/appowner.js';
import { businessDashboard, businessServicePage, businessIssue, businessReport } from '../personas/business.js';
import { sreDashboard, sreIncidents, sreIncident, srePostmortem, sreSlo } from '../personas/sre.js';
import { developerDashboard, developerService, developerEndpoint, developerError, developerTrace } from '../personas/developer.js';
import { devopsDashboard, devopsDeployments, devopsDeploymentDetail, devopsPipelineDetail, devopsClusterDetail } from '../personas/devops.js';

// sub-routes per persona: [regex on the part after /views/<id>, render]
const ROUTES = {
  kubernetes: [
    [/^$/, k8sDashboard],
    [/^\/namespaces\/[\w.-]+\/[\w.-]+$/, k8sNamespace],
    [/^\/workloads\/[\w.-]+\/[\w.-]+\/[\w.-]+$/, k8sWorkload],
    [/^\/pods\/[\w.-]+\/[\w.-]+\/[\w.-]+$/, k8sPod],
    [/^\/nodes\/[\w.-]+$/, k8sNode],
  ],
  itadmin: [
    [/^$/, itAdminDashboard],
    [/^\/agents\/[\w.-]+$/, itAdminAgent],
    [/^\/components\/[\w-]+$/, itAdminComponent],
    [/^\/ingestion$/, itAdminIngestion],
  ],
  security: [
    [/^$/, securityDashboard],
    [/^\/events$/, securityEvents],
    [/^\/events\/sev-\d+$/, securityEvent],
    [/^\/hosts\/[\w.-]+$/, securityHost],
    [/^\/ips\/[\d.]+$/, securityIp],
  ],
  appowner: [
    [/^$/, appOwnerDashboard],
    [/^\/apps\/[\w-]+$/, appOwnerApp],
    [/^\/releases\/rel-\d+$/, appOwnerRelease],
  ],
  business: [
    [/^$/, businessDashboard],
    [/^\/services\/[\w-]+$/, businessServicePage],
    [/^\/issues\/\d+$/, businessIssue],
    [/^\/report$/, businessReport],
  ],
  sre: [
    [/^$/, sreDashboard],
    [/^\/incidents$/, sreIncidents],
    [/^\/incidents\/\d+$/, sreIncident],
    [/^\/incidents\/\d+\/postmortem$/, srePostmortem],
    [/^\/slos\/slo-\d+$/, sreSlo],
  ],
  developer: [
    [/^$/, developerDashboard],
    [/^\/services\/[\w.-]+$/, developerService],
    [/^\/endpoints\/[\w.-]+~\d+$/, developerEndpoint],
    [/^\/errors\/err-\d+$/, developerError],
    [/^\/traces\/[0-9a-f]{8,32}$/, developerTrace],
  ],
  devops: [
    [/^$/, devopsDashboard],
    [/^\/deployments$/, devopsDeployments],
    [/^\/deployments\/[\w-]+$/, devopsDeploymentDetail],
    [/^\/pipelines\/[\w-]+$/, devopsPipelineDetail],
    [/^\/clusters\/[\w.-]+$/, devopsClusterDetail],
  ],
};

export function viewsPage(main, ctx) {
  const m = location.pathname.match(/^\/views\/?([\w-]*)(\/.*)?$/);
  const id = m?.[1] || '';
  const rest = (m?.[2] || '').replace(/\/$/, '');
  if (!id) {
    // /views = "my dashboard": open the remembered (or default) landing dashboard
    const p = landingFor(ctx.me, ctx.can);
    ctx.navigate(ctx.link(personaPath(p)), true);
    return {};
  }
  const persona = personaById(id);
  if (!persona) return notFound(main, ctx);
  if (!canOpen(persona, ctx.can)) {
    main.append(h('div', { class: 'state-box' }, emptyState('You do not have access to this dashboard',
      `Your role (${ctx.me.user.role}) does not include the ${persona.label} dashboard. An admin can add it in Settings › Roles. Open one of yours:`,
      h('div', { class: 'qa-row' }, selectorEntries(ctx.can).filter((p) => p.ready).map((p) => h('a', { class: 'btn btn-sm', href: ctx.link(personaPath(p)), 'data-link': true }, icon(p.icon, 13), p.short))))));
    return {};
  }
  setCrumbContext(ctx, persona.label);
  const route = (ROUTES[id] || []).find(([re]) => re.test(rest));
  if (route) {
    main.append(sampleBanner(ctx, id));
    // sample pages: the shell must not claim "Updated … ago" for generated data (the page header says when it was drawn)
    return { ...(route[1](main, ctx) || {}), sample: true };
  }
  if (rest) return notFound(main, ctx);
  // planned persona: shell + selector already work, content comes next
  main.append(personaHead(ctx, persona),
    h('div', { class: 'state-box' }, emptyState(`${persona.label} dashboard is coming next`, 'The shell, selector and access rules are ready. Pick another dashboard above for now.')));
  return {};
}

function notFound(main, ctx) {
  main.append(h('div', { class: 'state-box' }, emptyState('Dashboard page not found', '', h('a', { class: 'btn btn-primary', href: ctx.link('/views'), 'data-link': true }, 'My dashboard'))));
  return {};
}

// Every role dashboard says plainly that its numbers are generated examples, not your telemetry.
const LIVE_ALTERNATIVE = {
  kubernetes: ['/dashboards/kubernetes-cluster', 'Kubernetes Cluster dashboard'],
  devops: ['/infrastructure', 'Infrastructure'],
  developer: ['/services', 'Services'],
  sre: ['/incidents', 'Incidents'],
  itadmin: ['/datasources', 'Data Sources'],
};
function sampleBanner(ctx, id) {
  const keepsState = id === 'sre' || id === 'security';
  const alt = LIVE_ALTERNATIVE[id];
  return h('div', { class: 'sample-banner', role: 'note' },
    h('span', { class: 'sample-tag' }, 'Sample data'),
    h('span', {}, 'This role dashboard shows generated example data to demonstrate the layout and workflows. It is not connected to your telemetry yet.',
      keepsState ? ' Changes you make here are kept only in this browser tab.' : '',
      alt ? [' Live data: ', h('a', { href: ctx.link(alt[0]), 'data-link': true }, alt[1]), '.'] : ''));
}
