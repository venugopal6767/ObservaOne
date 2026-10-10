import { h, api, clear, icon, dateTime, toggle, modal, field, select, toast, confirmBox, stateView, stateFromError, timeEl, timeHeader } from '../ui.js';

const SEV = { critical: ['Critical', 'pill-solid-red'], warning: ['Warning', 'pill-solid-orange'], info: ['Info', 'pill-solid-blue'] };

export function alertingPage(main, ctx) {
  let tab = ctx.params.get('tab') || 'active';
  let alerts = null, silences = [], rules = null, rulesEditable = false, notif = null, error = null;
  const tabsEl = h('div', { class: 'chips' });
  const out = h('div', {}, h('div', { class: 'table-wrap' }, stateView('loading', { skeleton: 'table' })));
  main.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Alerting'), h('p', {}, 'Manage alerts and notifications')),
      h('div', { class: 'actions' }, ctx.can('alerts.rules') ? h('button', { class: 'btn btn-primary', onclick: newRule }, icon('plus', 15), 'New Alert Rule') : null)),
    h('div', { class: 'toolbar' }, tabsEl),
    out);

  async function load() {
    error = null;
    try {
      const [a, r] = await Promise.all([api('/alerts'), api('/rules')]);
      alerts = a.alerts; silences = a.silences; rules = r.rules; rulesEditable = r.editable;
    } catch (e) {
      error = e;
    }
    draw();
  }

  function draw() {
    const active = (alerts || []).filter((a) => a.state === 'active');
    // unknown counts show "-": a failed load must not look like "0 alerts"
    const n = (v) => (error ? '-' : v);
    const counts = { active: n(active.length), all: n((alerts || []).length), rules: n((rules || []).length), silences: n((silences || []).filter((s) => s.state === 'active').length) };
    clear(tabsEl).append(...[['active', `Active (${counts.active})`], ['all', `All (${counts.all})`], ['rules', `Rules (${counts.rules})`], ['silences', `Silences (${counts.silences})`], ['notifications', 'Notifications']]
      .map(([k, l]) => h('button', { class: `tab ${tab === k ? 'active' : ''}`, style: { border: '1px solid var(--border-2)', height: '30px' }, onclick: () => { tab = k; history.replaceState({}, '', `/alerting?tab=${k}`); draw(); } }, l)));
    clear(out);
    if (error) return out.append(h('div', { class: 'table-wrap' }, stateFromError(error, 'Alerts')));
    if (tab === 'active' || tab === 'all') return out.append(alertTable(tab === 'active' ? active : alerts));
    if (tab === 'rules') return out.append(ruleTable());
    if (tab === 'silences') return out.append(silenceTable());
    if (tab === 'notifications') return drawNotifications();
  }

  function alertTable(list) {
    if (!list.length) {
      return h('div', { class: 'table-wrap' }, stateView('empty', tab === 'active'
        ? { title: 'No active alerts', text: 'Alertmanager reports nothing firing right now.' }
        : { title: 'No alerts', text: 'Alertmanager has no alerts, firing or silenced.' }));
    }
    const canSilence = ctx.can('alerts.silence');
    return h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['Alert Name', 'Severity', 'Status', 'Server', timeHeader('Started'), 'Message', 'Notify'].map((x) => h('th', {}, x)))),
      h('tbody', {}, list.map((a) => {
        const [sl, sc] = SEV[a.severity] || [a.severity, 'pill-solid-muted'];
        const silenced = a.state === 'suppressed' && a.silencedBy?.length;
        const statusPill = a.state === 'active' ? h('span', { class: 'pill pill-solid-red' }, 'Firing')
          : silenced ? h('span', { class: 'pill pill-solid-muted' }, 'Silenced') : h('span', { class: 'pill pill-solid-muted' }, 'Inhibited');
        return h('tr', {},
          h('td', {}, h('b', { style: { fontWeight: 600 } }, a.name)),
          h('td', {}, h('span', { class: `pill ${sc}` }, sl)),
          h('td', {}, statusPill),
          h('td', {}, a.labels.host || a.labels.instance || '-'),
          h('td', { class: 'mono', style: { whiteSpace: 'nowrap' } }, timeEl(Date.parse(a.startsAt), dateTime(Date.parse(a.startsAt)).slice(0, 16))),
          h('td', { class: 'msg', title: a.description }, a.summary || a.description),
          h('td', {}, toggle(!silenced, async (on, el) => {
            try {
              if (!on) {
                await silenceDialog(a);
              } else {
                for (const id of a.silencedBy || []) await api(`/silences/${id}`, { method: 'DELETE' });
                toast('Notifications turned back on');
              }
            } catch (e) { toast(e.message, 'err'); }
            el.checked = !silenced;
            load();
          }, !canSilence || a.state === 'suppressed' && !silenced, canSilence ? 'Off = silence this alert' : 'Needs the operator role')));
      }))));
  }

  function silenceDialog(a) {
    return new Promise((resolve) => {
      let hours = '2';
      const comment = h('input', { class: 'input', placeholder: 'Why? e.g. planned maintenance CR-1234' });
      const matchers = [{ name: 'alertname', value: a.name }];
      if (a.labels.instance) matchers.push({ name: 'instance', value: a.labels.instance });
      modal(`Silence "${a.name}"`, h('div', {},
        h('p', { class: 'muted', style: { marginTop: 0 } }, 'No notifications will be sent for this alert until the silence ends. The alert still shows here.'),
        h('pre', { class: 'code' }, matchers.map((m) => `${m.name} = "${m.value}"`).join('\n')),
        field('Duration', select([['1', '1 hour'], ['2', '2 hours'], ['4', '4 hours'], ['8', '8 hours'], ['24', '1 day'], ['72', '3 days']], hours, (v) => { hours = v; })),
        field('Comment', comment)), [
        { label: 'Cancel', onclick: () => resolve() },
        { label: 'Silence', primary: true, onclick: async () => {
          await api('/silences', { method: 'POST', body: { matchers, hours: Number(hours), comment: comment.value } });
          toast('Alert silenced');
          resolve();
        } },
      ]);
    });
  }

  function ruleTable() {
    if (!rules.length) return h('div', { class: 'table-wrap' }, stateView('empty', { title: 'No alert rules loaded', text: 'Prometheus has no alerting rules. Add rule files under prometheus/rules, or create one here with "New Alert Rule".' }));
    const stateP = { firing: 'pill-solid-red', pending: 'pill-solid-orange', inactive: 'pill-solid-green' };
    return h('div', {},
      !rulesEditable && ctx.can('alerts.rules') ? h('div', { class: 'info-box' }, 'Rules from files are read-only here. Set UI_RULES_FILE to allow creating rules in this page.') : null,
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['Rule', 'Group', 'Severity', 'State', 'For', 'Query', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, rules.map((r) => {
          const [sl, sc] = SEV[r.severity] || [r.severity, 'pill-solid-muted'];
          return h('tr', {},
            h('td', {}, h('b', { style: { fontWeight: 600 } }, r.name), h('div', { class: 'dim', style: { fontSize: '11.5px' } }, r.summary.replace(/\{\{.*?\}\}/g, '…'))),
            h('td', { class: 'dim' }, r.group),
            h('td', {}, h('span', { class: `pill ${sc}` }, sl)),
            h('td', {}, h('span', { class: `pill ${stateP[r.state] || 'pill-muted'}` }, r.state === 'inactive' ? 'OK' : `${r.state}${r.firing ? ` (${r.firing})` : ''}`), r.health === 'err' ? h('div', { class: 'c-red', style: { fontSize: '11px' } }, r.lastError) : null),
            h('td', { class: 'dim' }, r.duration ? `${Math.round(r.duration / 60)}m` : '0m'),
            h('td', { class: 'mono msg', style: { fontSize: '11.5px', maxWidth: '380px' }, title: r.query }, r.query),
            h('td', {}, r.custom && ctx.can('alerts.rules') ? h('button', { class: 'icon-btn', title: 'Delete rule', onclick: async () => {
              if (!(await confirmBox('Delete rule', `Delete alert rule "${r.name}"?`, 'Delete'))) return;
              try { await api(`/rules/${encodeURIComponent(r.name)}`, { method: 'DELETE' }); toast('Rule deleted'); load(); } catch (e) { toast(e.message, 'err'); }
            } }, icon('trash', 14)) : null));
        })))));
  }

  function silenceTable() {
    if (!silences.length) return h('div', { class: 'table-wrap' }, stateView('empty', { title: 'No silences', text: 'Turn off "Notify" on an alert to silence it.' }));
    return h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['Matchers', 'State', 'Created by', 'Comment', timeHeader('Ends'), ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, silences.map((s) => h('tr', {},
        h('td', { class: 'mono', style: { fontSize: '12px' } }, s.matchers.map((m) => `${m.name}="${m.value}"`).join(', ')),
        h('td', {}, h('span', { class: `pill ${s.state === 'active' ? 'pill-blue' : 'pill-muted'}` }, s.state)),
        h('td', {}, s.createdBy), h('td', { class: 'msg' }, s.comment),
        h('td', { class: 'mono' }, timeEl(Date.parse(s.endsAt), dateTime(Date.parse(s.endsAt)).slice(0, 16))),
        h('td', {}, s.state === 'active' && ctx.can('alerts.silence') ? h('button', { class: 'btn btn-sm', onclick: async () => {
          try { await api(`/silences/${s.id}`, { method: 'DELETE' }); toast('Silence ended'); load(); } catch (e) { toast(e.message, 'err'); }
        } }, 'End now') : null))))));
  }

  async function drawNotifications() {
    out.append(h('div', { class: 'table-wrap' }, stateView('loading', { skeleton: 'table' })));
    try {
      notif = notif || await api('/notifications');
      clear(out);
      const none = notif.receivers.every((r) => !r.channels.length);
      if (none) out.append(h('div', { class: 'info-box' }, icon('alert', 16), h('span', {}, 'No notification channel is set up yet, so alerts are only shown here. Add email/Teams/webhook in alertmanager/alertmanager.yml (see README).')));
      out.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Receiver'), h('th', {}, 'Channel'), h('th', {}, 'Sends to'))),
        h('tbody', {}, notif.receivers.flatMap((r) => (r.channels.length ? r.channels : [{ type: '(none)', targets: [] }]).map((c) => h('tr', {},
          h('td', {}, h('b', { style: { fontWeight: 600 } }, r.name), r.name === notif.route.receiver ? h('span', { class: 'pill pill-blue', style: { marginLeft: '8px' } }, 'default') : null),
          h('td', {}, c.type), h('td', { class: 'mono' }, c.targets.join(', ') || '-'))))))));
      out.append(h('p', { class: 'muted', style: { marginTop: '10px' } }, `Alerts are grouped by ${(notif.route.groupBy || []).join(', ')} and repeated every ${notif.route.repeat || '4h'} while still firing.`));
    } catch (e) {
      clear(out).append(h('div', { class: 'table-wrap' }, stateFromError(e, 'Notifications')));
    }
  }

  function newRule() {
    if (!rulesEditable) return toast('Rule editing is off. Set UI_RULES_FILE (see README).', 'err');
    const name = h('input', { class: 'input', placeholder: 'e.g. HighCpuAppServers' });
    const expr = h('textarea', { class: 'input mono', rows: 3, placeholder: '100 - avg by (host) (rate(windows_cpu_time_total{mode="idle"}[5m])) * 100 > 85' });
    const summary = h('input', { class: 'input', placeholder: 'e.g. CPU high on {{ $labels.host }}' });
    let sev = 'warning', forMin = '5';
    modal('New alert rule', h('div', {},
      field('Name', name, 'Letters, numbers and _ only.'),
      field('Condition (PromQL)', expr, 'The alert fires for every series this query returns.'),
      h('div', { class: 'form-row' },
        field('Severity', select([['critical', 'Critical'], ['warning', 'Warning'], ['info', 'Info']], sev, (v) => { sev = v; })),
        field('Must be true for', select([['0', 'Immediately'], ['1', '1 minute'], ['5', '5 minutes'], ['10', '10 minutes'], ['15', '15 minutes'], ['30', '30 minutes']], forMin, (v) => { forMin = v; }))),
      field('Message', summary)), [
      { label: 'Cancel' },
      { label: 'Create rule', primary: true, onclick: async () => {
        await api('/rules', { method: 'POST', body: { name: name.value.trim(), expr: expr.value.trim(), severity: sev, forMinutes: Number(forMin), summary: summary.value } });
        toast('Rule created and loaded by Prometheus');
        tab = 'rules';
        load();
      } },
    ], { wide: true });
  }

  load();
  return { refresh: load };
}
