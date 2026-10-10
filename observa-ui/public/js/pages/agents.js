// Agents: the fleet of ObservaOne Agents, an install wizard for each platform, and enrollment tokens.
import { h, api, clear, icon, fmt, ago, pill, emptyState, tabs, modal, field, toast, confirmBox, select } from '../ui.js';
import { errorState, staleNotice } from '../personas/widgets.js';

const skel = (height) => h('div', { class: 'table-wrap skeleton', style: { height } });

const PLATFORM = {
  linux: { label: 'Linux', hint: 'Ubuntu, RHEL, Debian, SUSE, Amazon Linux (systemd)' },
  windows: { label: 'Windows', hint: 'Windows Server 2016 and newer' },
  docker: { label: 'Docker host', hint: 'Host + every container (cAdvisor) + container logs' },
  kubernetes: { label: 'Kubernetes', hint: 'Every node, pods, events, kube-state-metrics (also OpenShift)' },
};
const STATUS_TONE = { online: 'solid-green', offline: 'solid-red', blocked: 'muted' };

export function agentsPage(main, ctx) {
  const canManage = ctx.can('integrations.manage');
  let tab = ctx.params.get('tab') || 'fleet';
  let data = null, info = null, filter = ctx.params.get('q') || '', platformFilter = ctx.params.get('platformFilter') || 'all', okAt = 0;
  const wiz = { platform: ctx.params.get('platform') || 'linux', token: '', env: '', role: '', logs: '', cluster: '', securityLog: false };

  const stats = h('div', { class: 'grid cards-4', style: { marginBottom: '16px' } });
  const tabsEl = h('div', { style: { marginBottom: '14px' } });
  const out = h('div', {}, skel('320px'));
  const stale = h('div');
  main.append(
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Agents'), h('p', {}, 'One agent per server sends metrics, logs and traces to ObservaOne')),
      canManage ? h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', onclick: () => go('install') }, icon('plus', 15), 'Install agent')) : null),
    stale, stats, tabsEl, out);

  // tab and fleet filters live in the URL (with env and range)
  function syncUrl() {
    history.replaceState({}, '', ctx.link('/agents', { tab: tab === 'fleet' ? '' : tab, q: tab === 'fleet' ? filter : '', platformFilter: tab === 'fleet' && platformFilter !== 'all' ? platformFilter : '', platform: tab === 'install' ? wiz.platform : '' }));
  }
  function go(t) {
    tab = t;
    syncUrl();
    drawTabs();
    draw();
  }
  function drawTabs() {
    const items = [['fleet', `Fleet${data ? ` (${data.summary.total})` : ''}`], ['install', 'Install']];
    if (canManage) items.push(['tokens', 'Tokens']);
    clear(tabsEl).append(tabs(items, tab, go));
  }

  function drawStats() {
    if (!data) return;
    const s = data.summary;
    const failing = data.agents.filter((a) => a.sendFailures > 0).length;
    const attention = s.blocked + s.outdated + failing;
    const by = Object.entries(s.byPlatform).filter(([, n]) => n).map(([p, n]) => `${n} ${PLATFORM[p].label}`).join(' · ') || 'none yet';
    const card = (label, value, sub, tone) => h('div', { class: 'stat-card' },
      h('div', { class: 'label' }, label), h('div', { class: 'row' }, h('div', { class: `value ${tone || ''}` }, String(value))),
      h('div', { class: 'dim', style: { fontSize: '12px', marginTop: '4px' } }, sub));
    clear(stats).append(
      card('Agents', s.total, by),
      card('Online', s.online, 'sent data in the last 2½ minutes', s.online ? 'c-green' : ''),
      card('Offline', s.offline, s.offline ? 'not heard from - check these servers' : 'all agents reporting', s.offline ? 'c-red' : ''),
      card('Need attention', attention, `${s.outdated} outdated · ${s.blocked} blocked · ${failing} with upload errors`, attention ? 'c-orange' : ''));
  }

  async function load() {
    try {
      const firstLoad = !info;
      [data, info] = await Promise.all([api('/agents'), info ? Promise.resolve(info) : api('/agents/install-info')]);
      okAt = Date.now(); clear(stale);
      drawStats();
      drawTabs();
      if (tab === 'fleet' || (tab === 'install' && firstLoad)) draw();
    } catch (e) {
      if (data) clear(stale).append(staleNotice({ okAt, message: e.message, retry: () => ctx.refreshNow() }));
      else clear(out).append(errorState(e.message, () => ctx.refreshNow(), 'Agents could not load'));
      throw e;
    }
  }

  function draw() {
    if (tab === 'install') return drawInstall();
    if (tab === 'tokens') return drawTokens();
    return drawFleet();
  }

  // ------------------------------------------------------------ fleet
  function drawFleet() {
    if (!data) return clear(out).append(skel('320px'));
    if (!data.agents.length) {
      return clear(out).append(h('div', { class: 'table-wrap' }, emptyState('No agents yet',
        'Install the agent on a server and it shows up here within a minute.',
        canManage ? h('button', { class: 'btn btn-primary', style: { marginTop: '12px' }, onclick: () => go('install') }, 'Install your first agent') : null)));
    }
    const q = filter.toLowerCase();
    const list = data.agents.filter((a) => (platformFilter === 'all' || a.platform === platformFilter)
      && (!q || [a.host, a.os, a.env, a.role, a.ip, a.cluster, a.token].join(' ').toLowerCase().includes(q)));
    const tone = (v, hi = true) => (v === null ? 'dim' : hi ? (v >= 90 ? 'c-red' : v >= 80 ? 'c-orange' : '') : (v < 10 ? 'c-red' : v < 20 ? 'c-orange' : 'c-green'));
    const toolbar = h('div', { class: 'toolbar', style: { marginBottom: '12px' } },
      h('input', { class: 'input', type: 'search', 'aria-label': 'Filter agents', placeholder: 'Filter by host, OS, env, role, IP...', value: filter, style: { width: '280px' },
        oninput: (e) => { filter = e.target.value; const pos = e.target.selectionStart; syncUrl(); drawFleet(); const i = out.querySelector('input'); i.focus(); i.setSelectionRange(pos, pos); } }),
      select([['all', 'All platforms'], ...Object.entries(PLATFORM).map(([k, v]) => [k, v.label])], platformFilter, (v) => { platformFilter = v; syncUrl(); drawFleet(); }, { style: { width: '170px' }, 'aria-label': 'Platform' }),
      h('div', { class: 'grow' }),
      h('span', { class: 'dim', style: { fontSize: '12px' } }, `Latest agent version: ${data.latest}`));
    const rows = list.map((a) => h('tr', {},
      h('td', {}, h('b', { style: { fontWeight: 600 } }, a.host),
        h('div', { class: 'dim', style: { fontSize: '11px' } }, [a.ip, a.cluster && `cluster ${a.cluster}`].filter(Boolean).join(' · ') || a.id)),
      h('td', { class: 'col-phone-hide' }, PLATFORM[a.platform]?.label || a.platform, h('div', { class: 'dim', style: { fontSize: '11px' } }, [a.os, a.arch].filter(Boolean).join(' · '))),
      h('td', { class: 'col-phone-hide' }, [a.env, a.role].filter(Boolean).join(' / ') || h('span', { class: 'dim' }, '—')),
      h('td', { class: 'col-phone-hide' }, a.version ? (a.outdated ? h('span', { class: 'pill pill-orange', title: `Latest is ${data.latest}. Run the install command again to update.` }, `${a.version} ↑`) : a.version) : '—'),
      h('td', {}, pill(a.status === 'online' ? 'Online' : a.status === 'offline' ? 'Offline' : 'Blocked', STATUS_TONE[a.status])),
      h('td', { class: `num col-phone-hide ${tone(a.cpu)}` }, a.cpu === null ? '—' : fmt(a.cpu, 'percent')),
      h('td', { class: `num col-phone-hide ${tone(a.mem)}` }, a.mem === null ? '—' : fmt(a.mem, 'percent')),
      h('td', { class: `num col-phone-hide ${tone(a.diskFree, false)}` }, a.diskFree === null ? '—' : fmt(a.diskFree, 'percent')),
      h('td', { class: 'col-phone-hide' }, a.sendFailures > 0
        ? h('span', { class: 'c-red', title: 'Items that failed to upload in the last 15 minutes' }, `${fmt(a.sendFailures, 'short')} failed`)
        : a.queue > 0 ? h('span', { class: 'c-orange', title: 'Items waiting to be sent' }, `${fmt(a.queue, 'short')} queued`) : h('span', { class: 'c-green' }, 'OK')),
      h('td', { class: 'dim col-phone-hide', title: new Date(a.lastSeen).toLocaleString() }, ago(a.lastSeen)),
      h('td', { class: 'num', style: { whiteSpace: 'nowrap' } }, canManage ? [
        a.status === 'blocked'
          ? h('button', { class: 'btn btn-sm', onclick: () => act(`/agents/${encodeURIComponent(a.id)}/unblock`, 'POST', `${a.host} can send data again`) }, 'Allow')
          : h('button', { class: 'btn btn-sm', title: 'Refuse all data from this agent', onclick: async () => {
            if (await confirmBox(`Block ${a.host}?`, 'The agent keeps running but ObservaOne refuses everything it sends until you allow it again.', 'Block')) act(`/agents/${encodeURIComponent(a.id)}/block`, 'POST', `${a.host} blocked`);
          } }, 'Block'),
        a.status !== 'online' ? h('button', { class: 'icon-btn', title: 'Forget this agent (after you uninstalled it)', 'aria-label': `Forget ${a.host}`, style: { marginLeft: '4px' }, onclick: async () => {
          if (await confirmBox(`Forget ${a.host}?`, 'Removes it from this list. If the agent is still installed and its token is valid, it comes back the next time it sends data.', 'Forget')) act(`/agents/${encodeURIComponent(a.id)}`, 'DELETE', `${a.host} removed`);
        } }, icon('trash', 15)) : null,
      ] : null)));
    clear(out).append(toolbar, h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['Host', 'Platform', 'Env / role', 'Version', 'Status', 'CPU', 'Memory', 'Disk free', 'Uploads', 'Last seen', h('span', { class: 'sr-only' }, 'Actions')].map((x, i) => h('th', { class: `${i >= 5 && i <= 7 ? 'num' : ''} ${[1, 2, 3, 5, 6, 7, 8, 9].includes(i) ? 'col-phone-hide' : ''}` }, x)))),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: 11, class: 'dim' }, 'No agent matches the filter. ', h('button', { class: 'linkish', onclick: () => { filter = ''; platformFilter = 'all'; syncUrl(); drawFleet(); } }, 'Clear filter')))))));
  }

  async function act(path, method, msg) {
    try { await api(path, { method }); toast(msg); load().catch(() => {}); } catch (e) { toast(e.message, 'err'); }
  }

  // ------------------------------------------------------------ install wizard
  function commandFor() {
    const S = info.server;
    const c = info.cert || {};
    const pin = c.available && c.selfSigned;
    const t = wiz.token || '<TOKEN>';
    const shq = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
    const curlGet = pin ? `curl -fsSLk --pinnedpubkey "${c.spkiPin}"` : 'curl -fsSL';
    const opts = [];
    if (pin) opts.push(`--ca-sha256 ${c.sha256}`);
    if (wiz.env) opts.push(`--env ${shq(wiz.env)}`);
    if (wiz.role) opts.push(`--role ${shq(wiz.role)}`);
    if (wiz.logs.trim()) opts.push(`--logs ${shq(wiz.logs.trim())}`);
    if (wiz.platform === 'linux' || wiz.platform === 'docker') {
      if (wiz.platform === 'docker') opts.unshift('--docker');
      return { lang: 'bash', where: 'Run on the server as root (or with sudo):',
        text: `${curlGet} ${S}/agent/install.sh | sudo bash -s -- \\\n  --server ${S} \\\n  --token ${t}${opts.length ? ` \\\n  ${opts.join(' \\\n  ')}` : ''}` };
    }
    if (wiz.platform === 'windows') {
      const ps = (v) => `'${String(v).replace(/'/g, "''")}'`;
      const args = [`-Server ${S}`, `-Token ${t}`];
      if (pin) args.push(`-CaSha256 ${c.sha256}`);
      if (wiz.env) args.push(`-Env ${ps(wiz.env)}`);
      if (wiz.role) args.push(`-Role ${ps(wiz.role)}`);
      if (wiz.logs.trim()) args.push(`-Logs ${ps(wiz.logs.trim())}`);
      if (wiz.securityLog) args.push('-SecurityLog');
      const lines = ["[Net.ServicePointManager]::SecurityProtocol = 'Tls12'"];
      if (pin) {
        lines.push(`$fp = '${c.sha256}'`);
        lines.push("[Net.ServicePointManager]::ServerCertificateValidationCallback = { param($s, $c) ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($c.GetRawCertData())) -replace '-', '').ToLower() -eq $fp }");
      }
      lines.push(`& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing ${S}/agent/install.ps1).Content)) ${args.join(' ')}`);
      return { lang: 'powershell', where: 'Paste into Windows PowerShell opened with "Run as administrator":', text: lines.join('\n') };
    }
    // kubernetes
    const cluster = wiz.cluster || '<CLUSTER-NAME>';
    const lines = ['kubectl create namespace observaone'];
    let caArgs = '';
    if (pin) {
      lines.push(`${curlGet} -o observaone-ca.crt ${S}/agent/server.crt`);
      caArgs = ' \\\n  --from-file=ca.crt=observaone-ca.crt --from-literal=caFile=/etc/observaone-agent/ca.crt';
    }
    lines.push(`kubectl -n observaone create secret generic observaone-agent \\\n  --from-literal=server=${S} \\\n  --from-literal=token=${t} \\\n  --from-literal=cluster=${shq(cluster)}${wiz.env ? ` \\\n  --from-literal=env=${shq(wiz.env)}` : ''}${caArgs}`);
    lines.push(`${curlGet} ${S}/agent/kubernetes.yaml | kubectl apply -f -`);
    return { lang: 'bash', where: 'Run where kubectl points at the cluster (cluster-admin). OpenShift: use oc, and see the note below.', text: lines.join('\n') };
  }

  function drawInstall() {
    if (!info) return clear(out).append(skel('320px'));
    const cmdBox = h('pre', { class: 'code', style: { whiteSpace: 'pre', overflowX: 'auto', fontSize: '12.5px', lineHeight: '1.55', margin: 0 } });
    const whereEl = h('div', { class: 'muted', style: { marginBottom: '8px' } });
    const refresh = () => { const c = commandFor(); clear(cmdBox).append(c.text); whereEl.textContent = c.where; };

    const platformCards = h('div', { class: 'agent-platforms' }, Object.entries(PLATFORM).map(([k, p]) =>
      h('button', { class: `agent-platform ${wiz.platform === k ? 'active' : ''}`, onclick: () => { if (wiz.platform !== k) { wiz.platform = k; wiz.logs = ''; wiz.role = ''; } drawInstall(); } },
        h('b', {}, p.label), h('span', {}, p.hint))));

    const tokenInput = h('input', { class: 'input mono', placeholder: 'oat_...', value: wiz.token, oninput: (e) => { wiz.token = e.target.value.trim(); refresh(); } });
    const input = (key, ph) => h('input', { class: 'input', placeholder: ph, value: wiz[key], oninput: (e) => { wiz[key] = e.target.value; refresh(); } });
    const c = info.cert || {};
    const certNote = !c.available
      ? h('div', { class: 'dim' }, 'Agents trust the server certificate through the normal system certificate store.')
      : c.selfSigned
        ? h('div', { class: 'ok-box' }, icon('shield', 15), h('span', {}, 'Your server uses a self-signed certificate. The command pins its fingerprint, so agents only ever talk to this server: ', h('code', {}, `${c.sha256.slice(0, 16)}…`)))
        : h('div', { class: 'dim' }, `Certificate issued by ${c.issuer}. Agents trust it through the system certificate store (install your company CA on the servers if needed).`);

    const extra = [];
    if (wiz.platform !== 'kubernetes') {
      extra.push(field('Extra log files (optional)', input('logs', wiz.platform === 'windows' ? 'C:\\inetpub\\logs\\LogFiles\\*\\*.log' : '/var/log/nginx/*.log, /opt/app/logs/*.log'),
        wiz.platform === 'windows' ? 'Application and System event logs are always sent.' : 'System logs (syslog/messages/auth or the journal) are always sent.'));
      extra.push(field('Role (optional)', input('role', wiz.platform === 'windows' ? 'sql, iis, app' : 'web, database, app')));
    } else {
      extra.push(field('Cluster name', input('cluster', 'prod-cluster'), 'Shown on the Agents page and added to every metric as cluster=...'));
    }
    if (wiz.platform === 'windows') {
      extra.push(h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: wiz.securityLog, onchange: (e) => { wiz.securityLog = e.target.checked; refresh(); } }),
        h('span', {}, 'Also send the Security event log (sign-ins, account changes - large)')));
    }

    const notes = {
      linux: ['Installs node_exporter (127.0.0.1:9101) and the agent as systemd services under /opt/observaone-agent, running as the user observaone-agent.',
        'Uses no inbound ports. Only outbound HTTPS to this server.',
        'Apps on the server can send OpenTelemetry traces to 127.0.0.1:4317 (gRPC) or :4318 (HTTP).',
        'Already scraping this server from Prometheus (targets file)? Remove it there to avoid counting it twice.'],
      windows: ['Installs windows_exporter (127.0.0.1:9182, no firewall opening) and the ObservaOne Agent Windows service. An existing windows_exporter is reused.',
        'Uses no inbound ports. Only outbound HTTPS to this server.',
        'Apps can send OpenTelemetry traces to 127.0.0.1:4317 (gRPC) or :4318 (HTTP).',
        'Already scraping this server from Prometheus (targets file)? Remove it there to avoid counting it twice.'],
      docker: ['Runs 3 containers (agent, node-exporter, cAdvisor) with Docker Compose in /opt/observaone-agent.',
        'Same machine as ObservaOne (lab, Docker Desktop, WSL)? Skip this command: put the token in .env as AGENT_TOKEN and run  docker compose --profile agent up -d  in the monitoring-stack folder.',
        'Container logs are named after the container ID. Set the Docker log option tag to {{.Name}} to use container names instead.',
        'Images come from Docker Hub and ghcr.io. Without internet, copy them to your own registry first.'],
      kubernetes: ['Creates the observaone namespace: a DaemonSet (one agent per node), a cluster agent for events, and kube-state-metrics.',
        'Pods send traces to the node IP: set an env var NODE_IP from status.hostIP and OTEL_EXPORTER_OTLP_ENDPOINT=http://$(NODE_IP):4318.',
        'OpenShift: also run  oc adm policy add-scc-to-user privileged -z observaone-agent -n observaone',
        'Images come from Docker Hub, quay.io and registry.k8s.io. Without internet, mirror them and edit the image names.'],
    }[wiz.platform];

    clear(out).append(h('div', { class: 'agent-wizard' },
      h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, '1. Where will it run?')), platformCards),
      h('div', { class: 'grid cols-2' },
        h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, '2. Agent token')),
          h('p', { class: 'muted', style: { marginTop: 0 } }, 'One token can be used on many servers. Revoke it to cut them all off at once.'),
          h('div', { style: { display: 'flex', gap: '8px' } }, tokenInput,
            canManage ? h('button', { class: 'btn', style: { whiteSpace: 'nowrap' }, onclick: () => newToken((tok) => { wiz.token = tok; drawInstall(); }) }, icon('plus', 14), 'New token') : null),
          h('div', { style: { marginTop: '12px' } }, certNote)),
        h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, '3. Options')),
          field('Environment (optional)', input('env', 'prod, uat, dev')), ...extra)),
      h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h3', {}, '4. Run this command'),
          h('button', { class: 'btn btn-sm right', onclick: () => navigator.clipboard?.writeText(commandFor().text).then(() => toast('Command copied')) }, 'Copy')),
        whereEl, cmdBox,
        !wiz.token ? h('div', { class: 'c-orange', style: { marginTop: '8px', fontSize: '12.5px' } }, 'Add a token in step 2 - the command still shows <TOKEN>.') : null,
        h('ul', { class: 'agent-notes' }, notes.map((n) => h('li', {}, n))),
        h('div', { class: 'dim', style: { fontSize: '12px', marginTop: '6px' } },
          `Bundles OpenTelemetry Collector ${info.versions.otelcol}, node_exporter ${info.versions.nodeExporter}, windows_exporter ${info.versions.windowsExporter}, cAdvisor ${info.versions.cadvisor}, kube-state-metrics ${info.versions.kubeStateMetrics}. Every download is checked against a fixed SHA-256. `,
          'Remove: run the same install command with ', h('code', {}, wiz.platform === 'windows' ? '-Uninstall' : wiz.platform === 'kubernetes' ? 'kubectl delete -f kubernetes.yaml' : '--uninstall'), '.'))));
    refresh();
  }

  // ------------------------------------------------------------ tokens
  function newToken(onCreated) {
    const name = h('input', { class: 'input', maxlength: 60, placeholder: 'e.g. Production Linux servers' });
    const days = select([[0, 'Never'], [30, '30 days'], [90, '90 days'], [365, '1 year']], 0, () => {});
    modal('New agent token', h('div', {},
      field('Name', name, 'Where will you use it? Shown on the Agents page next to each agent.'),
      field('Expires', days, 'Agents using an expired token stop sending. Existing installs keep the token they have.')), [
      { label: 'Cancel' },
      { label: 'Create', primary: true, onclick: async () => {
        const r = await api('/agent-tokens', { method: 'POST', body: { name: name.value, expiresDays: Number(days.value) } });
        showToken(r.token, onCreated);
      } },
    ]);
  }

  function showToken(token, onCreated) {
    modal('Copy the token now', h('div', {},
      h('p', {}, 'This is the only time the token is shown. It goes into the install command; the agent stores it on the server.'),
      h('pre', { class: 'code', style: { wordBreak: 'break-all' } }, token),
      h('button', { class: 'btn', onclick: () => (navigator.clipboard ? navigator.clipboard.writeText(token).then(() => toast('Copied'), () => toast('Copy is blocked by the browser here. Select the token and copy it instead.', 'err')) : toast('Copy is blocked by the browser here. Select the token and copy it instead.', 'err')) }, 'Copy')), [
      onCreated ? { label: 'Use in the install command', primary: true, onclick: () => onCreated(token) } : { label: 'Done', primary: true },
    ]);
    if (tab === 'tokens') drawTokens();
  }

  async function drawTokens() {
    clear(out).append(skel('240px'));
    try {
      const { tokens } = await api('/agent-tokens');
      const status = (t) => (t.revoked ? pill('Revoked', 'muted') : t.expired ? pill('Expired', 'orange') : pill('Active', 'green'));
      clear(out).append(
        h('div', { class: 'toolbar', style: { marginBottom: '12px' } },
          h('p', { class: 'muted', style: { margin: 0 } }, 'Tokens let agents send data. Use one per group of servers (e.g. per environment) so you can revoke a group at once.'),
          h('div', { class: 'grow' }),
          h('button', { class: 'btn btn-primary', onclick: () => newToken() }, icon('plus', 15), 'New token')),
        h('div', { class: 'table-wrap' }, tokens.length ? h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, ['Name', 'Token', 'Agents', 'Created', 'Last used', 'Expires', 'Status', ''].map((x) => h('th', {}, x)))),
          h('tbody', {}, tokens.map((t) => h('tr', { style: { opacity: t.revoked ? 0.55 : 1 } },
            h('td', {}, h('b', { style: { fontWeight: 600 } }, t.name)),
            h('td', { class: 'mono dim' }, `oat_${t.prefix}_…`),
            h('td', {}, String(t.agents)),
            h('td', { class: 'dim' }, `${ago(t.createdAt)} by ${t.createdBy || '?'}`),
            h('td', { class: 'dim' }, t.lastUsed ? ago(t.lastUsed) : 'never'),
            h('td', { class: 'dim' }, t.expiresAt ? new Date(t.expiresAt).toLocaleDateString() : 'never'),
            h('td', {}, status(t)),
            h('td', { class: 'num' }, t.revoked ? null : h('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
              if (!await confirmBox(`Revoke "${t.name}"?`, `${t.agents} agent(s) use this token. They stop sending data within a minute. This cannot be undone - you would install them again with a new token.`, 'Revoke')) return;
              try { await api(`/agent-tokens/${t.id}`, { method: 'DELETE' }); toast('Token revoked'); drawTokens(); load().catch(() => {}); } catch (e) { toast(e.message, 'err'); }
            } }, 'Revoke')))))) : emptyState('No tokens yet', 'Create a token, then use it in the install command.')));
    } catch (e) {
      clear(out).append(errorState(e.message, () => drawTokens(), 'Tokens could not load'));
    }
  }

  drawTabs();
  draw();
  const ready = load();
  ready.catch(() => {});
  // top-bar refresh and auto-refresh: only reload while looking at the fleet (keeps the wizard inputs)
  return { refresh: () => (tab === 'fleet' ? load() : null), ready };
}
