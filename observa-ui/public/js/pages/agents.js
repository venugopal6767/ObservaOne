// Agents: one section per platform (like Datadog's agent pages) plus an overview and token management.
//   /agents             overview: every agent, every platform
//   /agents/linux       Linux: counts, install, agents        (also /agents/windows, /docker, /kubernetes)
//   /agents/tokens      enrollment tokens (admins)
// Every number comes from /api/agents (the database + Prometheus). Nothing is invented: a value the
// agent has not reported shows "-", an agent that stopped reporting shows "Not reporting".
import { h, api, clear, icon, fmt, ago, pill, tabs, modal, field, toast, confirmBox, select, stateView, timeEl, stateFromError, paginate, dateTime } from '../ui.js';

// support: ready = new Go agent, tested end to end | previous = previous-generation agent (OpenTelemetry Collector)
const PLATFORMS = {
  linux: {
    label: 'Linux', icon: 'infrastructure', support: 'ready',
    desc: 'Servers and VMs with systemd: Ubuntu, Debian, RHEL, Rocky, AlmaLinux, Amazon Linux, SUSE. amd64 and arm64.',
  },
  windows: {
    label: 'Windows', icon: 'windows', support: 'previous',
    desc: 'Windows Server 2016 and newer. Uses the previous-generation agent until the Go agent for Windows is released.',
  },
  docker: {
    label: 'Docker', icon: 'cube', support: 'previous',
    desc: 'A Docker host and every container on it. Uses the previous-generation agent until the Go agent supports containers.',
  },
  kubernetes: {
    label: 'Kubernetes', icon: 'k8s', support: 'previous',
    desc: 'Every node, pod and cluster event; also OpenShift, EKS, AKS, GKE. Uses the previous-generation agent for now.',
  },
};
const SUPPORT = {
  ready: ['Ready', 'green', 'ObservaOne Go agent 1.1: enrollment, heartbeats and host metrics tested end to end.'],
  previous: ['Previous agent', 'orange', 'Works with the previous-generation agent (OpenTelemetry Collector). The Go agent for this platform is planned.'],
  planned: ['Planned', 'muted', 'Not available yet.'],
};
const STATUS = {
  online: ['Online', 'solid-green'],
  attention: ['Needs attention', 'solid-orange'],
  not_reporting: ['Not reporting', 'stale'],
  offline: ['Offline', 'solid-red'],
  pending: ['Waiting for first heartbeat', 'muted'],
  blocked: ['Blocked', 'muted'],
};
const DISTROS = {
  debian: ['Ubuntu / Debian', 'sudo apt-get update && sudo apt-get install -y curl'],
  rhel: ['RHEL / Rocky / AlmaLinux / CentOS Stream', 'sudo dnf install -y curl'],
  amazon: ['Amazon Linux 2 / 2023', 'sudo yum install -y curl'],
  suse: ['SUSE / openSUSE', 'sudo zypper install -y curl'],
};

export function agentsPage(main, ctx) {
  const canManage = ctx.can('integrations.manage');
  const SECTIONS = ['overview', ...Object.keys(PLATFORMS), ...(canManage ? ['tokens'] : [])];
  const fromPath = () => {
    const s = location.pathname.split('/')[2] || ctx.params.get('platform') || 'overview';
    return SECTIONS.includes(s) ? s : 'overview';
  };
  let section = fromPath();
  let view = ctx.params.get('tab') === 'install' ? 'install' : 'agents'; // inside a platform section
  let data = null, info = null, loadError = null;
  let filter = '', statusFilter = 'all', page = 0, installDrawn = false;
  const wiz = { distro: 'debian', env: '', role: '', labels: '', logs: '', cluster: '', token: '', securityLog: false };

  const nav = h('div', { class: 'agent-sections', role: 'tablist', 'aria-label': 'Agent platforms' });
  const head = h('div');
  const body = h('div', {}, stateView('loading', { skeleton: 'table' }));
  main.append(
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Agents'), h('p', {}, 'One ObservaOne Agent per server sends its metrics to this platform')),
      canManage ? h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', onclick: () => go(section in PLATFORMS ? section : 'linux', 'install') }, icon('plus', 15), 'Install agent')) : null),
    h('div', { class: 'agents-layout' }, nav, h('div', { class: 'agents-main' }, head, body)));

  function go(s, v = 'agents') {
    section = s;
    view = v;
    page = 0;
    const url = s === 'overview' ? '/agents' : `/agents/${s}${v === 'install' ? '?tab=install' : ''}`;
    history.pushState({}, '', url);
    draw();
  }
  window.addEventListener('popstate', function onPop() {
    if (!main.isConnected) return window.removeEventListener('popstate', onPop);
    section = fromPath();
    draw();
  });

  // ---------------------------------------------------------------- data
  async function load() {
    try {
      [data, info] = await Promise.all([api('/agents'), info ? Promise.resolve(info) : api('/agents/install-info')]);
      loadError = null;
    } catch (e) {
      loadError = e;
    }
    // never redraw the install form while someone types in it
    if (section in PLATFORMS && view === 'install' && installDrawn) drawNav();
    else draw();
  }
  const agentsFor = (p) => (data ? data.agents.filter((a) => !p || a.platform === p) : []);
  const counts = (list) => ({
    total: list.length,
    online: list.filter((a) => a.status === 'online' || a.status === 'attention').length,
    attention: list.filter((a) => a.status === 'attention' || a.status === 'blocked' || a.outdated).length,
    notReporting: list.filter((a) => a.status === 'not_reporting').length,
    offline: list.filter((a) => a.status === 'offline').length,
    pending: list.filter((a) => a.status === 'pending').length,
  });

  // ---------------------------------------------------------------- left navigation
  function drawNav() {
    const item = (key, label, ic, extra) => h('button', {
      class: `agent-section ${section === key ? 'active' : ''}`, role: 'tab', 'aria-selected': section === key ? 'true' : 'false',
      onclick: () => go(key),
    }, icon(ic, 16), h('span', { class: 'grow' }, label), extra);
    const n = (p) => (data ? h('span', { class: 'count' }, String(agentsFor(p).length)) : null);
    clear(nav).append(
      item('overview', 'Overview', 'overview', n()),
      h('div', { class: 'agent-section-title' }, 'Platforms'),
      ...Object.entries(PLATFORMS).map(([k, p]) => item(k, p.label, p.icon, h('span', { class: 'sec-meta' }, n(k), supportDot(p.support)))),
      ...(canManage ? [h('div', { class: 'agent-section-title' }, 'Access'), item('tokens', 'Enrollment tokens', 'key')] : []));
  }
  const supportDot = (s) => h('span', { class: `support-dot support-${s}`, title: SUPPORT[s][2], 'aria-label': SUPPORT[s][0] });

  // ---------------------------------------------------------------- page body
  function draw() {
    installDrawn = false;
    drawNav();
    clear(head);
    if (section === 'tokens') return drawTokens();
    if (loadError) return clear(body).append(h('div', { class: 'table-wrap' }, stateFromError(loadError, 'Agents')));
    if (!data) return clear(body).append(h('div', { class: 'table-wrap' }, stateView('loading', { skeleton: 'table' })));
    if (section === 'overview') return drawOverview();
    return drawPlatform(section);
  }

  function statCards(list, sub) {
    const c = counts(list);
    const card = (label, value, text, tone, onclick) => h(onclick ? 'button' : 'div', { class: `stat-card ${onclick ? 'clickable' : ''}`, onclick },
      h('div', { class: 'label' }, label), h('div', { class: 'row' }, h('div', { class: `value ${value ? tone || '' : ''}` }, String(value))),
      h('div', { class: 'dim', style: { fontSize: '12px', marginTop: '4px' } }, text));
    const t = data.thresholds || {};
    const setF = (f) => () => { statusFilter = f; page = 0; drawTable(); };
    return h('div', { class: 'grid cards-5', style: { marginBottom: '16px' } },
      card('Agents', c.total, sub || (c.pending ? `${c.pending} waiting for first heartbeat` : 'enrolled'), '', setF('all')),
      card('Online', c.online, `heartbeat in the last ${secs(t.onlineSeconds)}`, 'c-green', setF('online')),
      card('Not reporting', c.notReporting, c.notReporting ? 'silent; the host may still be up' : 'none', 'c-orange', setF('not_reporting')),
      card('Offline', c.offline, `silent for more than ${secs(t.offlineSeconds)}`, 'c-red', setF('offline')),
      card('Needs attention', c.attention, 'problems, outdated or blocked', 'c-orange', setF('attention')));
  }
  const secs = (s) => (!s ? '-' : s < 120 ? `${s} s` : `${Math.round(s / 60)} min`);

  // overview: all platforms
  function drawOverview() {
    const all = agentsFor();
    head.append(h('div', { class: 'section-head' }, h('div', {}, h('h2', {}, 'All agents'),
      h('p', { class: 'muted' }, 'Every enrolled agent on every platform. Pick a platform on the left for its install steps.'))));
    const platformCards = h('div', { class: 'grid cards-4', style: { marginBottom: '16px' } }, Object.entries(PLATFORMS).map(([k, p]) => {
      const c = counts(agentsFor(k));
      return h('button', { class: 'panel platform-card', onclick: () => go(k) },
        h('div', { class: 'platform-card-head' }, icon(p.icon, 18), h('b', {}, p.label), h('span', { class: 'grow' }), pill(SUPPORT[p.support][0], SUPPORT[p.support][1])),
        c.total
          ? h('div', { class: 'platform-card-counts' }, h('span', { class: 'c-green' }, `${c.online} online`),
            c.notReporting ? h('span', { class: 'c-orange' }, `${c.notReporting} not reporting`) : null,
            c.offline ? h('span', { class: 'c-red' }, `${c.offline} offline`) : null,
            h('span', { class: 'dim' }, `of ${c.total}`))
          : h('div', { class: 'dim' }, canManage ? 'No agents yet. Install one.' : 'No agents yet.'));
    }));
    clear(body).append(statCards(all), platformCards, tableBox(all, true));
    drawTable();
  }

  // one platform
  function drawPlatform(p) {
    const meta = PLATFORMS[p];
    const list = agentsFor(p);
    head.append(h('div', { class: 'section-head' },
      h('div', {}, h('h2', {}, meta.label, ' ', pill(SUPPORT[meta.support][0], SUPPORT[meta.support][1])), h('p', { class: 'muted' }, meta.desc)),
      h('div', { class: 'section-tabs' }, tabs([['agents', `Agents (${list.length})`], ['install', 'Install']], view, (v) => go(p, v)))));
    if (view === 'install') return drawInstall(p);
    clear(body).append(statCards(list, list.length ? null : 'none enrolled yet'), tableBox(list, false));
    drawTable();
  }

  // ---------------------------------------------------------------- agents table (shared)
  let tableHost = null, tableList = [], tableShowPlatform = false;
  function tableBox(list, showPlatform) {
    tableList = list;
    tableShowPlatform = showPlatform;
    tableHost = h('div');
    return tableHost;
  }
  function drawTable() {
    if (!tableHost) return;
    const list = tableList;
    if (!list.length) {
      const p = section in PLATFORMS ? section : 'linux';
      return clear(tableHost).append(h('div', { class: 'table-wrap' }, stateView('empty', {
        title: section in PLATFORMS ? `No ${PLATFORMS[section].label} agents enrolled` : 'No agents enrolled',
        text: canManage ? 'Install the agent on a server and it shows up here within a minute.' : 'No agent has enrolled yet. An administrator can install agents from this page.',
        action: canManage ? h('button', { class: 'btn btn-primary', onclick: () => go(p, 'install') }, 'Install an agent') : null,
      })));
    }
    const q = filter.toLowerCase();
    const matchStatus = (a) => statusFilter === 'all' || a.status === statusFilter
      || (statusFilter === 'online' && a.status === 'attention')
      || (statusFilter === 'attention' && (a.status === 'blocked' || a.outdated));
    const shown = list.filter((a) => matchStatus(a)
      && (!q || [a.host, a.os, a.env, a.role, a.ip, a.cluster, a.version, a.id, ...Object.entries(a.labels || {}).map(([k, v]) => `${k}=${v}`)].join(' ').toLowerCase().includes(q)));
    const pg = paginate(shown, { page, pageSize: 50, noun: 'agents', onPage: (n) => { page = n; drawTable(); } });
    const tone = (v, hi = true) => (v === null ? 'dim' : hi ? (v >= 90 ? 'c-red' : v >= 80 ? 'c-orange' : '') : (v < 10 ? 'c-red' : v < 20 ? 'c-orange' : ''));
    const statusOpts = [['all', 'All statuses'], ['online', 'Online'], ['attention', 'Needs attention'], ['not_reporting', 'Not reporting'], ['offline', 'Offline'], ['pending', 'Waiting'], ['blocked', 'Blocked']];
    const toolbar = h('div', { class: 'toolbar', style: { marginBottom: '12px' } },
      h('input', { class: 'input', type: 'search', placeholder: 'Filter: host, env, label, version, IP...', value: filter, style: { width: '300px', maxWidth: '100%' }, 'aria-label': 'Filter agents',
        oninput: (e) => { filter = e.target.value; page = 0; const pos = e.target.selectionStart; drawTable(); const i = tableHost.querySelector('input'); i.focus(); i.setSelectionRange(pos, pos); } }),
      select(statusOpts, statusFilter, (v) => { statusFilter = v; page = 0; drawTable(); }, { style: { width: '170px' }, 'aria-label': 'Filter by status' }),
      h('div', { class: 'grow' }),
      h('span', { class: 'dim', style: { fontSize: '12px' } }, `Latest agent: ${data.latest}`));
    const labelsOf = (a) => {
      const l = Object.entries(a.labels || {}).map(([k, v]) => `${k}=${v}`);
      return [a.env && `env=${a.env}`, a.role && `role=${a.role}`, ...l].filter(Boolean);
    };
    const cols = ['Host', ...(tableShowPlatform ? ['Platform'] : []), 'Status', 'Labels', 'Version', 'CPU', 'Memory', 'Disk free', 'Last heartbeat', ''];
    const rows = pg.rows.map((a) => h('tr', { class: 'clickable', tabindex: 0, onclick: (e) => { if (!e.target.closest('button')) detail(a); }, onkeydown: (e) => { if (e.key === 'Enter') detail(a); } },
      h('td', {}, h('b', { style: { fontWeight: 600 } }, a.host),
        h('div', { class: 'dim', style: { fontSize: '11px' } }, [a.os, a.arch].filter(Boolean).join(' · ') || a.id)),
      tableShowPlatform ? h('td', {}, PLATFORMS[a.platform]?.label || a.platform) : null,
      h('td', {}, statusPill(a), a.problems?.length && a.status !== 'not_reporting' && a.status !== 'offline'
        ? h('div', { class: 'c-orange', style: { fontSize: '11px', marginTop: '3px', maxWidth: '260px' } }, a.problems[0]) : null),
      h('td', {}, labelsOf(a).length ? h('div', { class: 'label-chips' }, labelsOf(a).slice(0, 4).map((l) => h('span', { class: 'chip' }, l))) : h('span', { class: 'dim' }, '-')),
      h('td', {}, a.version ? (a.outdated ? h('span', { class: 'pill pill-orange', title: `Latest is ${data.latest}. Run the installer again to update.` }, `${a.version} ↑`) : a.version) : '-'),
      h('td', { class: `num ${tone(a.cpu)}` }, fmt(a.cpu, 'percent')),
      h('td', { class: `num ${tone(a.mem)}` }, fmt(a.mem, 'percent')),
      h('td', { class: `num ${tone(a.diskFree, false)}` }, fmt(a.diskFree, 'percent')),
      h('td', { class: 'dim' }, a.lastSeen ? timeEl(Date.parse(a.lastSeen), ago(a.lastSeen)) : 'never'),
      h('td', { class: 'num', style: { whiteSpace: 'nowrap' } }, canManage ? rowActions(a) : null)));
    clear(tableHost).append(toolbar, h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, cols.map((x) => h('th', { class: ['CPU', 'Memory', 'Disk free'].includes(x) ? 'num' : '' }, x)))),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: cols.length, class: 'dim' }, 'No agent matches the filter.')))), pg.foot));
  }
  function statusPill(a) {
    const [label, tone] = STATUS[a.status] || [a.status, 'muted'];
    return h('span', { class: `pill pill-${tone}`, title: a.statusReason || label }, label);
  }
  function rowActions(a) {
    return [
      a.status === 'blocked'
        ? h('button', { class: 'btn btn-sm', onclick: () => act(`/agents/${encodeURIComponent(a.id)}/unblock`, 'POST', `${a.host} can send data again`) }, 'Allow')
        : h('button', { class: 'btn btn-sm', title: 'Refuse everything this agent sends', onclick: async () => {
          if (await confirmBox(`Block ${a.host}?`, 'The agent keeps running but ObservaOne refuses its heartbeats and data until you allow it again.', 'Block')) act(`/agents/${encodeURIComponent(a.id)}/block`, 'POST', `${a.host} blocked`);
        } }, 'Block'),
      !['online', 'attention'].includes(a.status) ? h('button', { class: 'icon-btn', title: 'Remove this agent (after you uninstalled it)', 'aria-label': `Remove ${a.host}`, style: { marginLeft: '4px' }, onclick: async () => {
        if (await confirmBox(`Remove ${a.host}?`, a.enrolled ? 'Removes it and its credential. If the agent is still installed it can no longer send anything; install it again with a new token to bring it back.' : 'Removes it from this list. A previous-generation agent that still has a valid token comes back when it next sends data.', 'Remove')) act(`/agents/${encodeURIComponent(a.id)}`, 'DELETE', `${a.host} removed`);
      } }, icon('trash', 15)) : null,
    ];
  }
  async function act(path, method, msg) {
    try { await api(path, { method }); toast(msg); load(); } catch (e) { toast(e.message, 'err'); }
  }

  // ---------------------------------------------------------------- agent detail
  async function detail(a) {
    const box = h('div', {}, stateView('loading', { skeleton: 'cards' }));
    modal(`${a.host}`, box, [{ label: 'Close' }], { wide: true });
    let d;
    try { d = (await api(`/agents/${encodeURIComponent(a.id)}`)).agent; } catch (e) { return clear(box).append(stateFromError(e, 'Agent')); }
    const row = (k, v) => h('tr', {}, h('th', {}, k), h('td', {}, v ?? h('span', { class: 'dim' }, '-')));
    const when = (x) => (x ? h('span', {}, timeEl(Date.parse(x)), h('span', { class: 'dim' }, ` (${ago(x)})`)) : null);
    const coll = d.diag?.collectors || {};
    const errs = d.diag?.collectorErrors || {};
    const collTone = { ok: 'green', running: 'green', unavailable: 'muted', disabled: 'muted', error: 'red', failed: 'red', stopped: 'red' };
    clear(box).append(
      h('div', { class: 'detail-status' }, statusPill(d), h('span', { class: 'muted' }, d.statusReason || 'Everything is reporting normally.')),
      d.problems?.length ? h('ul', { class: 'problem-list' }, d.problems.map((p) => h('li', {}, icon('alert', 14), p))) : null,
      h('div', { class: 'grid cols-2' },
        h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, 'Identity')),
          h('table', { class: 'kv' }, h('tbody', {},
            row('Agent ID', h('code', {}, d.id)), row('Platform', PLATFORMS[d.platform]?.label || d.platform), row('OS', d.os), row('Kernel', d.kernel),
            row('Architecture', d.arch), row('Version', d.version), row('Address', d.ip),
            row('Labels', [d.env && `env=${d.env}`, d.role && `role=${d.role}`, ...Object.entries(d.labels || {}).map(([k, v]) => `${k}=${v}`)].filter(Boolean).join(', ') || null),
            row('Enrolled', when(d.enrolledAt)), row('Token', d.token), row('Credential', d.enrolled ? 'Own credential (enrolled)' : 'Shared token (previous agent)')))),
        h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, 'Reporting')),
          h('table', { class: 'kv' }, h('tbody', {},
            row('Last heartbeat', when(d.lastHeartbeat)), row('Last data', when(d.lastData)), row('Host booted', when(d.bootTime)),
            row('CPU', fmt(d.cpu, 'percent')), row('Memory', fmt(d.mem, 'percent')), row('Lowest disk free', fmt(d.diskFree, 'percent')),
            row('Upload failures', d.diag?.uploadFailures != null ? String(d.diag.uploadFailures) : null),
            row('Agent error', d.diag?.lastError || null))))),
      Object.keys(coll).length ? h('div', { class: 'panel', style: { marginTop: '14px' } }, h('div', { class: 'panel-head' }, h('h3', {}, 'Collectors')),
        h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Collector'), h('th', {}, 'State'), h('th', {}, 'Detail'))),
          h('tbody', {}, Object.keys(coll).sort().map((k) => h('tr', {}, h('td', {}, k), h('td', {}, pill(coll[k], collTone[coll[k]] || 'muted')), h('td', { class: 'dim' }, errs[k] || '')))))) : null,
      ctx.canOpen('/dashboards/linux-servers') && d.platform === 'linux'
        ? h('p', { style: { marginTop: '12px' } }, h('a', { href: `/dashboards/linux-servers?host=${encodeURIComponent(d.host)}` }, 'Open the Linux Servers dashboard for this host →')) : null);
  }

  // ---------------------------------------------------------------- install
  function drawInstall(p) {
    if (!info) return clear(body).append(h('div', { class: 'table-wrap' }, stateView('loading', { skeleton: 'table' })));
    if (!canManage) {
      return clear(body).append(h('div', { class: 'table-wrap' }, stateView('empty', { title: 'Installing agents needs the "integrations.manage" permission', text: 'Ask an administrator to install the agent or to give you that permission.' })));
    }
    const S = info.server;
    const c = info.cert || {};
    const pin = c.available && c.selfSigned;
    const cmdBox = h('pre', { class: 'code', tabindex: 0, 'aria-label': 'Install command', style: { whiteSpace: 'pre', overflowX: 'auto', fontSize: '12.5px', lineHeight: '1.55', margin: 0 } });
    const input = (key, ph) => h('input', { class: 'input', placeholder: ph, value: wiz[key], oninput: (e) => { wiz[key] = e.target.value; refresh(); } });
    const shq = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
    const curlGet = pin ? `curl -fsSLk --pinnedpubkey "${c.spkiPin}"` : 'curl -fsSL';
    const certNote = !c.available
      ? h('div', { class: 'dim' }, 'Agents trust the server certificate through the normal system certificate store.')
      : pin
        ? h('div', { class: 'ok-box' }, icon('shield', 15), h('span', {}, 'Self-signed server certificate: the commands pin its fingerprint, so agents only ever talk to this server: ', h('code', {}, `${c.sha256.slice(0, 16)}…`)))
        : h('div', { class: 'dim' }, `Certificate issued by ${c.issuer}. Agents verify it through their system certificate store.`);

    function command() {
      if (p === 'linux') {
        const opts = [`--server ${S}`];
        if (pin) opts.push(`--ca-sha256 ${c.sha256}`);
        if (wiz.env) opts.push(`--env ${shq(wiz.env)}`);
        if (wiz.role) opts.push(`--role ${shq(wiz.role)}`);
        for (const l of wiz.labels.split(',').map((x) => x.trim()).filter(Boolean)) opts.push(`--label ${shq(l)}`);
        return [
          `${curlGet} ${S}/agent/install.sh -o observaone-install.sh`,
          `sudo bash observaone-install.sh \\\n  ${opts.join(' \\\n  ')}`,
        ].join('\n');
      }
      // previous-generation installers (token in the command)
      const t = wiz.token || '<TOKEN>';
      if (p === 'docker') {
        const opts = ['--docker', `--server ${S}`, `--token ${t}`];
        if (pin) opts.push(`--ca-sha256 ${c.sha256}`);
        if (wiz.env) opts.push(`--env ${shq(wiz.env)}`);
        if (wiz.role) opts.push(`--role ${shq(wiz.role)}`);
        return `${curlGet} ${S}/agent/install-legacy.sh | sudo bash -s -- \\\n  ${opts.join(' \\\n  ')}`;
      }
      if (p === 'windows') {
        const ps = (v) => `'${String(v).replace(/'/g, "''")}'`;
        // no -Token: the installer asks for it (hidden), so it stays out of PowerShell history
        const args = [`-Server ${S}`];
        if (pin) args.push(`-CaSha256 ${c.sha256}`);
        if (wiz.env) args.push(`-Env ${ps(wiz.env)}`);
        if (wiz.role) args.push(`-Role ${ps(wiz.role)}`);
        if (wiz.logs.trim()) args.push(`-Logs ${ps(wiz.logs.trim())}`);
        if (wiz.securityLog) args.push('-SecurityLog');
        const lines = ["[Net.ServicePointManager]::SecurityProtocol = 'Tls12'"];
        if (pin) {
          // compiled fingerprint check, for this server only (other sites keep the normal check);
          // a script-block callback fails in Windows PowerShell 5.1
          lines.push('Add-Type @"');
          lines.push('using System; using System.Net; using System.Net.Security; using System.Security.Cryptography; using System.Security.Cryptography.X509Certificates;');
          lines.push('public static class ObservaOneCertPin { static string fp; static string host;');
          lines.push('  static bool Check(object s, X509Certificate c, X509Chain ch, SslPolicyErrors e) { var r = s as HttpWebRequest; if (r == null || !string.Equals(r.RequestUri.Host, host, StringComparison.OrdinalIgnoreCase)) return e == SslPolicyErrors.None; if (c == null) return false; using (var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(c.GetRawCertData())).Replace("-", "").ToLower() == fp; }');
          lines.push('  public static void Enable(string f, string hst) { fp = f; host = hst; ServicePointManager.ServerCertificateValidationCallback = Check; } }');
          lines.push('"@');
          lines.push(`[ObservaOneCertPin]::Enable('${c.sha256}', '${new URL(S).hostname}')`);
        }
        lines.push(`& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing ${S}/agent/install.ps1).Content)) ${args.join(' ')}`);
        return lines.join('\n');
      }
      const cluster = wiz.cluster || '<CLUSTER-NAME>';
      const lines = ['kubectl create namespace observaone'];
      let caArgs = '';
      if (pin) {
        lines.push(`${curlGet} -o observaone-ca.crt ${S}/agent/server.crt`);
        caArgs = ' \\\n  --from-file=ca.crt=observaone-ca.crt --from-literal=caFile=/etc/observaone-agent/ca.crt';
      }
      lines.push(`kubectl -n observaone create secret generic observaone-agent \\\n  --from-literal=server=${S} \\\n  --from-literal=token=${t} \\\n  --from-literal=cluster=${shq(cluster)}${wiz.env ? ` \\\n  --from-literal=env=${shq(wiz.env)}` : ''}${caArgs}`);
      lines.push(`${curlGet} ${S}/agent/kubernetes.yaml | kubectl apply -f -`);
      return lines.join('\n');
    }
    function refresh() { clear(cmdBox).append(command()); }

    const steps = [];
    const hostPort = S.replace(/^https?:\/\//, '');
    if (!/^https:\/\//.test(S)) {
      steps.push(h('div', { class: 'state-banner state-banner-partial', role: 'status' }, icon('alert', 15),
        h('span', {}, `This page was opened at ${S}. Agents need the HTTPS address of this server as they reach it (never localhost): set PUBLIC_URL=https://your-server in .env, or open ObservaOne through its https:// address.`)));
    }
    // 1. requirements
    const req = {
      linux: ['systemd; amd64 or arm64; about 15 MB of disk', 'root (sudo) to install; the agent itself runs as the unprivileged user observaone-agent',
        `outbound HTTPS (443) from the server to ${hostPort}; no inbound port is opened`, 'curl and sha256sum (preinstalled on most distributions)'],
      windows: ['Windows Server 2016 or newer, PowerShell 5.1+', 'an Administrator PowerShell', `outbound HTTPS (443) to ${hostPort}`],
      docker: ['Docker Engine with the compose plugin', 'root (sudo)', `outbound HTTPS (443) to ${hostPort}`, 'images from Docker Hub and ghcr.io (or your mirror)'],
      kubernetes: ['kubectl with cluster-admin', `outbound HTTPS (443) from the nodes to ${hostPort}`, 'images from Docker Hub, quay.io and registry.k8s.io (or your mirror)'],
    }[p];
    steps.push(h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, '1. Requirements')),
      h('ul', { class: 'agent-notes', style: { marginTop: 0 } }, req.map((r) => h('li', {}, r))),
      p === 'linux' ? h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
        h('span', { class: 'muted' }, 'Distribution'),
        select(Object.entries(DISTROS).map(([k, [l]]) => [k, l]), wiz.distro, (v) => { wiz.distro = v; drawInstall(p); }, { style: { width: '300px' }, 'aria-label': 'Linux distribution' }),
        h('span', { class: 'dim' }, 'curl missing? '), h('code', {}, DISTROS[wiz.distro][1])) : null,
      certNote));
    // 2. token
    const tokenInput = h('input', { class: 'input mono', placeholder: 'oat_...', value: wiz.token, oninput: (e) => { wiz.token = e.target.value.trim(); refresh(); } });
    steps.push(h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, '2. Enrollment token')),
      p === 'linux'
        ? h('p', { class: 'muted', style: { marginTop: 0 } }, 'The installer asks for the token and hides what you type, so it never ends up in shell history or the process list. Each server swaps it for its own credential; revoking the token later only stops new enrollments. For automation use ', h('code', {}, '--token-file FILE'), '.')
        : p === 'windows'
          ? h('p', { class: 'muted', style: { marginTop: 0 } }, 'The installer asks for the token and hides what you type, so it stays out of PowerShell history. The previous-generation Windows agent keeps it on the server (readable by SYSTEM and Administrators only) and sends it with every upload: revoking the token stops every agent that uses it.')
          : h('p', { class: 'muted', style: { marginTop: 0 } }, 'The previous-generation agent keeps the token on the server and sends it with every upload. Revoking the token stops every agent that uses it.'),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        p === 'linux' || p === 'windows' ? null : tokenInput,
        h('button', { class: 'btn', style: { whiteSpace: 'nowrap' }, onclick: () => newToken((tok) => { if (p !== 'linux' && p !== 'windows') { wiz.token = tok; drawInstall(p); } }, p) }, icon('plus', 14), 'Create a token'),
        h('button', { class: 'btn btn-ghost', onclick: () => go('tokens') }, 'Manage tokens'))));
    // 3. options
    const opts = [field('Environment (optional)', input('env', 'prod, uat, dev'))];
    if (p !== 'kubernetes') opts.push(field('Role (optional)', input('role', p === 'windows' ? 'sql, iis, app' : 'web, database, app')));
    if (p === 'linux') opts.push(field('Labels (optional)', input('labels', 'team=payments, tier=1'), 'key=value, comma separated; lower-case keys. Up to 10.'));
    if (p === 'kubernetes') opts.push(field('Cluster name', input('cluster', 'prod-cluster'), 'Added to every metric as cluster=...'));
    if (p === 'windows' || p === 'docker') opts.push(field('Extra log files (optional)', input('logs', p === 'windows' ? 'C:\\inetpub\\logs\\LogFiles\\*\\*.log' : '/var/log/nginx/*.log')));
    if (p === 'windows') opts.push(h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: wiz.securityLog, onchange: (e) => { wiz.securityLog = e.target.checked; refresh(); } }), h('span', {}, 'Also send the Security event log (large)')));
    steps.push(h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, '3. Options')), h('div', { class: 'grid cols-2' }, ...opts)));
    // 4. command
    const where = { linux: 'Run on the server (the first line downloads the installer, the second runs it and asks for the token):', windows: 'Paste into Windows PowerShell opened with "Run as administrator" (it asks for the token at the end):', docker: 'Run on the Docker host as root (or with sudo):', kubernetes: 'Run where kubectl points at the cluster:' }[p];
    const after = {
      linux: [h('span', {}, 'Check it: ', h('code', {}, 'sudo observaone-agent status')), h('span', {}, 'Logs: ', h('code', {}, 'journalctl -u observaone-agent -f')),
        h('span', {}, 'Settings: ', h('code', {}, '/etc/observaone-agent/agent.conf'), ' and ', h('code', {}, 'conf.d/*.conf'), ', then ', h('code', {}, 'sudo systemctl reload observaone-agent')),
        h('span', {}, 'Upgrade: run the same two lines again (identity and your settings are kept; a failed upgrade rolls back).'),
        h('span', {}, 'Remove: ', h('code', {}, 'sudo bash observaone-install.sh --uninstall'))],
      windows: ['Remove: run the same command with -Uninstall.'],
      docker: ['Runs the agent, node-exporter and cAdvisor containers in /opt/observaone-agent.', 'Remove: run the same command with --uninstall.'],
      kubernetes: ['Creates a DaemonSet (one agent per node), a cluster agent and kube-state-metrics in the observaone namespace.', 'OpenShift: also run  oc adm policy add-scc-to-user privileged -z observaone-agent -n observaone', 'Remove: kubectl delete -f kubernetes.yaml'],
    }[p];
    steps.push(h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', {}, '4. Run'),
        h('button', { class: 'btn btn-sm right', onclick: () => navigator.clipboard?.writeText(command()).then(() => toast('Command copied')) }, 'Copy')),
      h('div', { class: 'muted', style: { marginBottom: '8px' } }, where), cmdBox,
      p !== 'linux' && p !== 'windows' && !wiz.token ? h('div', { class: 'c-orange', style: { marginTop: '8px', fontSize: '12.5px' } }, 'Create a token in step 2: the command still shows <TOKEN>.') : null,
      h('ul', { class: 'agent-notes' }, after.map((n) => h('li', {}, n))),
      h('div', { class: 'dim', style: { fontSize: '12px' } }, p === 'linux'
        ? `ObservaOne Go agent ${data?.latest || ''}, about 7 MB, checksum-verified on download. The host appears under Agents and Infrastructure within a minute.`
        : `Previous-generation agent: OpenTelemetry Collector ${info.versions.otelcol}. Every download is checked against a fixed SHA-256.`)));
    clear(body).append(h('div', { class: 'agent-wizard' }, ...steps));
    installDrawn = true;
    refresh();
  }

  // ---------------------------------------------------------------- tokens
  function newToken(onCreated, platform) {
    const name = h('input', { class: 'input', maxlength: 60, placeholder: platform ? `e.g. ${PLATFORMS[platform]?.label || ''} servers, prod` : 'e.g. Production Linux servers' });
    const days = select([[1, '1 day'], [7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'Never']], 7, () => {});
    const uses = select([[1, 'Once (one server)'], [10, '10 servers'], [100, '100 servers'], [0, 'Unlimited']], platform === 'linux' ? 1 : 0, () => {});
    modal('New enrollment token', h('div', {},
      field('Name', name, 'Where will you use it? Shown next to each agent that enrolled with it.'),
      h('div', { class: 'grid cols-2' },
        field('Valid for', days, 'After this, new enrollments are refused. Enrolled agents keep working.'),
        field('Can enroll', uses, 'Limits how many servers can enroll with it.'))), [
      { label: 'Cancel' },
      { label: 'Create', primary: true, onclick: async () => {
        const r = await api('/agent-tokens', { method: 'POST', body: { name: name.value, expiresDays: Number(days.value), maxUses: Number(uses.value) || null } });
        showToken(r.token, onCreated);
      } },
    ]);
  }
  function showToken(token, onCreated) {
    modal('Copy the token now', h('div', {},
      h('p', {}, 'This is the only time the token is shown. ObservaOne keeps only a fingerprint of it.'),
      h('pre', { class: 'code', style: { wordBreak: 'break-all', whiteSpace: 'pre-wrap' } }, token),
      h('button', { class: 'btn', onclick: () => navigator.clipboard?.writeText(token).then(() => toast('Copied')) }, 'Copy')), [
      { label: 'Done', primary: true, onclick: () => onCreated?.(token) },
    ]);
    if (section === 'tokens') drawTokens();
  }
  async function drawTokens() {
    head.append(h('div', { class: 'section-head' }, h('div', {}, h('h2', {}, 'Enrollment tokens'),
      h('p', { class: 'muted' }, 'A token lets servers enroll. Use one per group (environment, team) and limit how many servers and how long. Linux agents swap the token for their own credential, so revoking a token only stops new enrollments.')),
    h('div', {}, h('button', { class: 'btn btn-primary', onclick: () => newToken() }, icon('plus', 15), 'New token'))));
    clear(body).append(h('div', { class: 'table-wrap' }, stateView('loading', { skeleton: 'table' })));
    try {
      const { tokens } = await api('/agent-tokens');
      const status = (t) => (t.revoked ? pill('Revoked', 'muted') : t.expired ? pill('Expired', 'orange') : t.usedUp ? pill('Used up', 'muted') : pill('Active', 'green'));
      clear(body).append(h('div', { class: 'table-wrap' }, tokens.length ? h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['Name', 'Token', 'Used', 'Agents', 'Created', 'Last used', 'Expires', 'Status', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, tokens.map((t) => h('tr', {},
          h('td', {}, h('b', { style: { fontWeight: 600 } }, t.name)),
          h('td', { class: 'mono dim' }, `oat_${t.prefix}_…`),
          h('td', {}, t.maxUses ? `${t.uses} of ${t.maxUses}` : `${t.uses} (no limit)`),
          h('td', {}, String(t.agents)),
          h('td', { class: 'dim' }, `${ago(t.createdAt)} by ${t.createdBy || '?'}`),
          h('td', { class: 'dim' }, t.lastUsed ? ago(t.lastUsed) : 'never'),
          h('td', { class: 'dim' }, t.expiresAt ? dateTime(Date.parse(t.expiresAt)) : 'never'),
          h('td', {}, status(t)),
          h('td', { class: 'num' }, t.revoked ? null : h('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
            if (!await confirmBox(`Revoke "${t.name}"?`, 'New enrollments with this token are refused at once. Enrolled Linux agents keep their own credentials; previous-generation agents using this token stop sending within a minute.', 'Revoke')) return;
            try { await api(`/agent-tokens/${t.id}`, { method: 'DELETE' }); toast('Token revoked'); drawTokens(); load(); } catch (e) { toast(e.message, 'err'); }
          } }, 'Revoke')))))) : stateView('empty', { title: 'No tokens yet', text: 'Create a token, then use it when you install an agent.' })));
    } catch (e) {
      clear(body).append(h('div', { class: 'table-wrap' }, stateFromError(e, 'Tokens')));
    }
  }

  draw();
  load();
  // top-bar refresh / auto-refresh: reload the data, never the install form someone is filling in
  return { refresh: () => load() };
}
