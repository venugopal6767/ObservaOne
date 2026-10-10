import { errorState, staleNotice } from '../personas/widgets.js';
import { h, api, clear, icon, emptyState, dateTime, toggle, modal, field, select, toast, confirmBox, ago } from '../ui.js';

const SEV = { critical: ['Critical', 'pill-solid-red'], warning: ['Warning', 'pill-solid-orange'], info: ['Info', 'pill-solid-blue'] };

export function alertingPage(main, ctx) {
  let tab = ctx.params.get('tab') || 'active';
  let alerts = null, silences = [], rules = null, rulesEditable = false, notif = null, error = null, okAt = 0;
  const tabsEl = h('div', { class: 'chips' });
  const stale = h('div');
  const out = h('div', {}, h('div', { class: 'table-wrap skeleton', style: { height: '320px' } }));
  const actions = h('div', { class: 'actions' });
  // same name as the menu item
  main.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Alert Rules'), h('p', {}, 'Firing alerts, alert rules, silences and notifications')), actions),
    h('div', { class: 'toolbar' }, tabsEl),
    stale, out);

  // "New Alert Rule" works only when the server allows rule editing; otherwise it is locked and says why
  function drawActions() {
    if (!ctx.can('alerts.rules')) return clear(actions);
    clear(actions).append(rulesEditable
      ? h('button', { class: 'btn btn-primary', onclick: newRule }, icon('plus', 15), 'New Alert Rule')
      : h('button', { class: 'btn btn-unavail', 'aria-disabled': 'true', title: 'Rule editing is off on this server. Set UI_RULES_FILE (see README) to create rules here.',
        onclick: () => toast('Rule editing is off on this server. Set UI_RULES_FILE (see README). Nothing was changed.', 'err') }, icon('lock', 13), 'New Alert Rule'));
  }

  async function load() {
    try {
      const [a, r] = await Promise.all([api('/alerts'), api('/rules')]);
      alerts = a.alerts; silences = a.silences; rules = r.rules; rulesEditable = r.editable;
      error = null; okAt = Date.now(); clear(stale);
    } catch (e) {
      if (alerts) { clear(stale).append(staleNotice({ okAt, message: e.message, retry: () => ctx.refreshNow() })); throw e; }
      error = e.message;
      draw();
      throw e;
    }
    drawActions();
    draw();
  }
  const reloadQuiet = () => load().catch(() => {});

  function draw() {
    const active = (alerts || []).filter((a) => a.state === 'active');
    const counts = { active: active.length, all: (alerts || []).length, rules: (rules || []).length, silences: silences.filter((s) => s.state === 'active').length };
    clear(tabsEl).append(...[['active', `Active (${counts.active})`], ['all', `All (${counts.all})`], ['rules', `Rules (${counts.rules})`], ['silences', `Silences (${counts.silences})`], ['notifications', 'Notifications']]
      .map(([k, l]) => h('button', { class: `tab ${tab === k ? 'active' : ''}`, 'aria-pressed': String(tab === k), style: { border: '1px solid var(--border-2)', height: '30px' }, onclick: () => { tab = k; history.replaceState({}, '', ctx.link('/alerting', { tab: k === 'active' ? '' : k })); draw(); } }, l)));
    clear(out);
    if (error) return out.append(errorState(error, () => ctx.refreshNow(), 'Alerts could not load'));
    if (tab === 'active' || tab === 'all') return out.append(alertTable(tab === 'active' ? active : alerts));
    if (tab === 'rules') return out.append(ruleTable());
    if (tab === 'silences') return out.append(silenceTable());
    if (tab === 'notifications') return drawNotifications();
  }

  function alertTable(list) {
    if (!list.length) return h('div', { class: 'table-wrap' }, emptyState('No alerts', tab === 'active' ? 'Everything is quiet right now.' : ''));
    const canSilence = ctx.can('alerts.silence');
    return h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['Alert Name', 'Severity', 'Status', 'Server', 'Started', 'Message', 'Notify'].map((x, i) => h('th', { class: [2, 3, 4, 5].includes(i) ? 'col-phone-hide' : '' }, x)))),
      h('tbody', {}, list.map((a) => {
        const [sl, sc] = SEV[a.severity] || [a.severity, 'pill-solid-muted'];
        const silenced = a.state === 'suppressed' && a.silencedBy?.length;
        const statusPill = a.state === 'active' ? h('span', { class: 'pill pill-solid-red' }, 'Firing')
          : silenced ? h('span', { class: 'pill pill-solid-muted' }, 'Silenced') : h('span', { class: 'pill pill-solid-muted' }, 'Inhibited');
        return h('tr', {},
          h('td', {}, h('b', { style: { fontWeight: 600 } }, a.name)),
          h('td', {}, h('span', { class: `pill ${sc}` }, sl)),
          h('td', { class: 'col-phone-hide' }, statusPill),
          h('td', { class: 'col-phone-hide' }, a.labels.host || a.labels.instance || h('span', { class: 'dim' }, '—')),
          h('td', { class: 'mono col-phone-hide', style: { whiteSpace: 'nowrap' }, title: ago(a.startsAt) }, dateTime(Date.parse(a.startsAt)).slice(0, 16)),
          h('td', { class: 'msg col-phone-hide', title: a.description }, a.summary || a.description),
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
            reloadQuiet();
          }, !canSilence || a.state === 'suppressed' && !silenced, canSilence ? `Notifications for ${a.name}: off = silence this alert` : 'Needs the operator role')));
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
    if (!rules.length) return h('div', { class: 'table-wrap' }, emptyState('No alert rules loaded'));
    const stateP = { firing: 'pill-solid-red', pending: 'pill-solid-orange', inactive: 'pill-solid-green' };
    return h('div', {},
      !rulesEditable && ctx.can('alerts.rules') ? h('div', { class: 'info-box' }, 'Rules from files are read-only here. Set UI_RULES_FILE to allow creating rules in this page.') : null,
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['Rule', 'Group', 'Severity', 'State', 'For', 'Query', h('span', { class: 'sr-only' }, 'Actions')].map((x, i) => h('th', { class: [1, 4, 5].includes(i) ? 'col-phone-hide' : '' }, x)))),
        h('tbody', {}, rules.map((r) => {
          const [sl, sc] = SEV[r.severity] || [r.severity, 'pill-solid-muted'];
          return h('tr', {},
            h('td', {}, h('b', { style: { fontWeight: 600 } }, r.name), h('div', { class: 'dim', style: { fontSize: '11.5px' } }, r.summary.replace(/\{\{.*?\}\}/g, '…'))),
            h('td', { class: 'dim col-phone-hide' }, r.group),
            h('td', {}, h('span', { class: `pill ${sc}` }, sl)),
            h('td', {}, h('span', { class: `pill ${stateP[r.state] || 'pill-muted'}` }, r.state === 'inactive' ? 'OK' : `${r.state}${r.firing ? ` (${r.firing})` : ''}`), r.health === 'err' ? h('div', { class: 'c-red', style: { fontSize: '11px' } }, r.lastError) : null),
            h('td', { class: 'dim col-phone-hide' }, r.duration ? `${Math.round(r.duration / 60)}m` : '0m'),
            h('td', { class: 'mono msg col-phone-hide', style: { fontSize: '11.5px', maxWidth: '380px' }, title: r.query }, r.query),
            h('td', {}, r.custom && ctx.can('alerts.rules') ? h('button', { class: 'icon-btn', title: `Delete rule ${r.name}`, 'aria-label': `Delete rule ${r.name}`, onclick: async () => {
              if (!(await confirmBox('Delete rule', `Delete alert rule "${r.name}"?`, 'Delete'))) return;
              try { await api(`/rules/${encodeURIComponent(r.name)}`, { method: 'DELETE' }); toast('Rule deleted'); reloadQuiet(); } catch (e) { toast(e.message, 'err'); }
            } }, icon('trash', 14)) : null));
        })))));
  }

  function silenceTable() {
    if (!silences.length) return h('div', { class: 'table-wrap' }, emptyState('No silences', 'Turn off "Notify" on an alert to silence it.'));
    return h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['Matchers', 'State', 'Created by', 'Comment', 'Ends', h('span', { class: 'sr-only' }, 'Actions')].map((x, i) => h('th', { class: [2, 3].includes(i) ? 'col-phone-hide' : '' }, x)))),
      h('tbody', {}, silences.map((s) => h('tr', {},
        h('td', { class: 'mono', style: { fontSize: '12px' } }, s.matchers.map((m) => `${m.name}="${m.value}"`).join(', ')),
        h('td', {}, h('span', { class: `pill ${s.state === 'active' ? 'pill-blue' : 'pill-muted'}` }, s.state)),
        h('td', { class: 'col-phone-hide' }, s.createdBy), h('td', { class: 'msg col-phone-hide' }, s.comment),
        h('td', { class: 'mono' }, dateTime(Date.parse(s.endsAt)).slice(0, 16)),
        h('td', {}, s.state === 'active' && ctx.can('alerts.silence') ? h('button', { class: 'btn btn-sm', onclick: async () => {
          try { await api(`/silences/${s.id}`, { method: 'DELETE' }); toast('Silence ended'); reloadQuiet(); } catch (e) { toast(e.message, 'err'); }
        } }, 'End now') : null))))));
  }

  async function drawNotifications() {
    out.append(h('div', { class: 'table-wrap skeleton', style: { height: '200px' } }));
    try {
      notif = notif || await api('/notifications');
      clear(out);
      const none = notif.receivers.every((r) => !r.channels.length);
      if (none) out.append(h('div', { class: 'info-box' }, icon('alert', 16), h('span', {}, 'No notification channel is set up yet, so alerts are only shown here. Add email/Teams/webhook in alertmanager/alertmanager.yml (see README).')));
      out.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Receiver'), h('th', {}, 'Channel'), h('th', {}, 'Sends to'))),
        h('tbody', {}, notif.receivers.flatMap((r) => (r.channels.length ? r.channels : [{ type: '(none)', targets: [] }]).map((c) => h('tr', {},
          h('td', {}, h('b', { style: { fontWeight: 600 } }, r.name), r.name === notif.route.receiver ? h('span', { class: 'pill pill-blue', style: { marginLeft: '8px' } }, 'default') : null),
          h('td', {}, c.type), h('td', { class: 'mono' }, c.targets.join(', ') || '—'))))))));
      out.append(h('p', { class: 'muted', style: { marginTop: '10px' } }, `Alerts are grouped by ${(notif.route.groupBy || []).join(', ')} and repeated every ${notif.route.repeat || '4h'} while still firing.`));
    } catch (e) {
      clear(out).append(errorState(e.message, () => { clear(out); drawNotifications(); }, 'Notification settings could not load'));
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
        reloadQuiet();
      } },
    ], { wide: true });
  }

  const ready = load();
  ready.catch(() => {});
  return { refresh: load, ready };
}
