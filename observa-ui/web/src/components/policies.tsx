// Alerts -> Notification Policies: which alerts go to which channels, grouped and repeated how.
// Checked top to bottom: the first policy whose conditions all match sends the alert (unless it says "continue");
// the Default policy takes everything else. A rule can also name its policy in Create alert.
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ArrowUp, ArrowDown, Pencil, Trash2, X, Mail, MessageSquare, Hash, Webhook, Siren, CornerDownRight } from 'lucide-react';
import { api } from '@/lib/api';
import { useApp } from '@/app/AppContext';
import { ErrorState, Field, InfoBox, Modal, Pill, RowMenu, Select, StateView, TableWrap, Toggle, toast, useDialogs } from '@/components/ui';

export interface Matcher { label: string; op: '=' | '!=' | '=~' | '!~'; value: string }
export interface Policy {
  id: number; name: string; description: string; matchers: Matcher[]; channels: number[];
  groupBy: string[] | null; groupWait: string | null; groupInterval: string | null; repeatInterval: string | null;
  continue: boolean; enabled: boolean; isDefault: boolean; position: number;
  channelNames: { id: number; name: string; type: string; enabled: boolean }[]; activeAlerts: number | null;
}
interface PoliciesData { editable: boolean; policies: Policy[]; alertmanagerReachable: boolean; activeAlerts: number | null; suggestions: Record<string, string[]>; apply: { ok: boolean | null; error: string | null } }
interface Chan { id: number; name: string; type: string; typeName: string; display: string; enabled: boolean }

export const CH_ICON: Record<string, typeof Mail> = { email: Mail, teams: MessageSquare, slack: Hash, webhook: Webhook, pagerduty: Siren };
const OPS: [Matcher['op'], string][] = [['=', 'equals'], ['!=', 'not equals'], ['=~', 'matches (regex)'], ['!~', 'does not match']];
const LABELS: [string, string][] = [['severity', 'Severity'], ['env', 'Environment'], ['team', 'Team'], ['service', 'Service'], ['host', 'Host'], ['alertname', 'Alert name'], ['role', 'Role']];
const LABEL_NAME = Object.fromEntries(LABELS);
const opWord = (op: string) => OPS.find(([o]) => o === op)?.[1] || op;

export function MatcherChips({ ms }: { ms: Matcher[] }) {
  if (!ms.length) return <span className="dim">every alert</span>;
  return <span className="cond-chips">{ms.map((m, i) => <span key={i} className="cond-chip"><b>{LABEL_NAME[m.label] || m.label}</b> {m.op === '=' ? '=' : m.op === '!=' ? '≠' : opWord(m.op)} <span className="mono">{m.value}</span></span>)}</span>;
}
function ChannelChips({ p }: { p: Policy }) {
  if (!p.channelNames.length) return <span className="c-orange">no channel: not sent</span>;
  return <span className="cond-chips">{p.channelNames.map((c) => { const I = CH_ICON[c.type] || Webhook; return <span key={c.id} className={`ch-chip ${c.enabled ? '' : 'off'}`} title={c.enabled ? c.name : `${c.name} (disabled)`}><I size={12} /> {c.name}</span>; })}</span>;
}

export function Policies() {
  const { can } = useApp();
  const { open, confirm } = useDialogs();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['policies'], queryFn: () => api<PoliciesData>('/notifications/policies'), refetchInterval: 30_000 });
  const chq = useQuery({ queryKey: ['notifications'], queryFn: () => api<{ channels: Chan[] }>('/notifications') });
  if (q.isPending) return <TableWrap label="Policies"><StateView kind="loading" skeleton="table" /></TableWrap>;
  if (q.isError) return <TableWrap label="Policies"><ErrorState error={q.error} what="Policies" /></TableWrap>;
  const d = q.data;
  if (!d.editable && !d.policies.length) return <InfoBox>Notification policies need ObservaOne to manage Alertmanager's configuration (AM_CONFIG_FILE). Routing is in alertmanager/alertmanager.yml here.</InfoBox>;
  const manage = d.editable && can('notifications.manage');
  const refresh = () => { qc.invalidateQueries({ queryKey: ['policies'] }); qc.invalidateQueries({ queryKey: ['notifications'] }); };
  const after = (r?: { apply?: { ok: boolean | null; error: string | null } }) => { refresh(); if (r?.apply?.ok === false) toast(r.apply.error || 'Alertmanager did not take the change', 'err'); };
  const ordered = d.policies.filter((p) => !p.isDefault).sort((a, b) => a.position - b.position);
  const def = d.policies.find((p) => p.isDefault);
  const channels = chq.data?.channels || [];
  const edit = (p?: Policy) => open((close) => <PolicyDialog policy={p} channels={channels} suggestions={d.suggestions} defaults={def} onClose={close} onDone={after} />);
  async function move(i: number, dir: -1 | 1) {
    const ids = ordered.map((p) => p.id);
    const j = i + dir; if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { after(await api('/notifications/policies-order', { method: 'PUT', body: { ids } })); } catch (e) { toast((e as Error).message, 'err'); }
  }
  async function toggle(p: Policy, enabled: boolean) {
    try { after(await api(`/notifications/policies/${p.id}`, { method: 'PUT', body: { ...p, enabled } })); toast(`${p.name} ${enabled ? 'enabled' : 'disabled'}`); } catch (e) { toast((e as Error).message, 'err'); }
  }
  const timing = (p: Policy) => {
    const t = [p.groupWait && `wait ${p.groupWait}`, p.repeatInterval && `repeat ${p.repeatInterval}`, p.groupBy?.length && `by ${p.groupBy.join(', ')}`].filter(Boolean);
    return t.length ? t.join(' · ') : <span className="dim">as Default</span>;
  };
  return (
    <>
      {d.apply?.ok === false && <InfoBox tone="error">{d.apply.error}</InfoBox>}
      <div className="notify-head">
        <p className="muted" style={{ margin: 0 }}>An alert is checked against the policies <b>top to bottom</b>; the first whose conditions all match sends it (to all its channels). <b>Default</b> takes every alert nothing above matched.{d.activeAlerts !== null && <> {d.activeAlerts} alert{d.activeAlerts === 1 ? ' is' : 's are'} active now.</>}</p>
        {manage && <button className="btn btn-primary" onClick={() => edit()}><Plus size={15} /> New policy</button>}
      </div>
      <TableWrap label="Notification policies">
        <table className="tbl policies-tbl">
          <thead><tr><th style={{ width: 1 }}>#</th><th>Policy</th><th>When the alert has</th><th>Send to</th><th>Grouping & timing</th><th className="num">Active now</th><th>On</th>{manage && <th style={{ width: 1 }} />}</tr></thead>
          <tbody>
            {ordered.map((p, i) => (
              <tr key={p.id} className={p.enabled ? '' : 'row-disabled'}>
                <td><div className="order-btns">
                  <span className="dim num">{i + 1}</span>
                  {manage && <><button className="icon-btn" disabled={i === 0} aria-label={`Move ${p.name} up`} title="Move up" onClick={() => move(i, -1)}><ArrowUp size={13} /></button>
                    <button className="icon-btn" disabled={i === ordered.length - 1} aria-label={`Move ${p.name} down`} title="Move down" onClick={() => move(i, 1)}><ArrowDown size={13} /></button></>}
                </div></td>
                <td><b>{p.name}</b>{p.continue && <span style={{ marginLeft: 6 }} title="Also checks the policies below"><Pill tone="muted"><CornerDownRight size={11} /> continue</Pill></span>}{p.description && <div className="dim" style={{ fontSize: 12 }}>{p.description}</div>}</td>
                <td><MatcherChips ms={p.matchers} /></td>
                <td><ChannelChips p={p} /></td>
                <td style={{ fontSize: 12.5 }}>{timing(p)}</td>
                <td className="num">{p.activeAlerts ?? '-'}</td>
                <td>{manage ? <Toggle checked={p.enabled} onChange={(v) => toggle(p, v)} label={`${p.name} enabled`} /> : (p.enabled ? 'Yes' : 'No')}</td>
                {manage && <td><div className="row-actions">
                  <button className="icon-btn" aria-label={`Edit ${p.name}`} title="Edit" onClick={() => edit(p)}><Pencil size={15} /></button>
                  <RowMenu label={`More actions for ${p.name}`} items={[{ label: 'Delete', danger: true, icon: <Trash2 size={14} />, onClick: async () => {
                    if (!(await confirm('Delete policy', <>Alerts matching <b>{p.name}</b> will go to the next matching policy, or Default.</>, 'Delete'))) return;
                    try { after(await api(`/notifications/policies/${p.id}`, { method: 'DELETE' })); toast('Policy deleted'); } catch (e) { toast((e as Error).message, 'err'); }
                  } }]} />
                </div></td>}
              </tr>
            ))}
            {def && (
              <tr className="row-default">
                <td><span className="dim">∞</span></td>
                <td><b>Default</b><div className="dim" style={{ fontSize: 12 }}>Every alert no policy above matched</div></td>
                <td><span className="dim">everything else</span></td>
                <td><ChannelChips p={def} /></td>
                <td style={{ fontSize: 12.5 }}>{[def.groupBy?.length && `by ${def.groupBy.join(', ')}`, `wait ${def.groupWait || '30s'}`, `repeat ${def.repeatInterval || '4h'}`].filter(Boolean).join(' · ')}</td>
                <td className="num">{def.activeAlerts ?? '-'}</td>
                <td>Always</td>
                {manage && <td><button className="icon-btn" aria-label="Edit the Default policy" title="Edit" onClick={() => edit(def)}><Pencil size={15} /></button></td>}
              </tr>
            )}
          </tbody>
        </table>
      </TableWrap>
      <PreviewRouting />
    </>
  );
}

/** "Where would this alert go?" from a few labels. */
function PreviewRouting() {
  const [labels, setLabels] = useState({ severity: 'critical', env: 'prod', team: '', service: '' });
  const body = Object.fromEntries(Object.entries(labels).filter(([, v]) => v.trim()));
  const q = useQuery({ queryKey: ['policy-preview', body], queryFn: () => api<{ policies: { id: number; name: string; isDefault: boolean; channels: { name: string; type: string }[] }[] }>('/notifications/policies/preview', { method: 'POST', body: { labels: body } }) });
  return (
    <div className="route-try">
      <h3>Where would an alert go?</h3>
      <div className="route-try-row">
        {(['severity', 'env', 'team', 'service'] as const).map((k) => (
          <label key={k} className="route-try-f"><span className="dim">{LABEL_NAME[k]}</span>
            <input className="input input-sm" value={labels[k]} placeholder="—" onChange={(e) => setLabels({ ...labels, [k]: e.target.value })} aria-label={`Test label ${k}`} />
          </label>
        ))}
        <span className="dim">→</span>
        <span>{q.isPending ? '…' : q.data?.policies.map((p) => (
          <span key={p.id} className="route-try-res"><b>{p.isDefault ? 'Default' : p.name}</b>: {p.channels.length ? p.channels.map((c) => c.name).join(', ') : <span className="c-orange">no channel (not sent)</span>}</span>
        ))}</span>
      </div>
    </div>
  );
}

function PolicyDialog({ policy, channels, suggestions, defaults, onClose, onDone }: {
  policy?: Policy; channels: Chan[]; suggestions: Record<string, string[]>; defaults?: Policy; onClose: () => void; onDone: (r?: { apply?: { ok: boolean | null; error: string | null } }) => void;
}) {
  const isDefault = !!policy?.isDefault;
  const [name, setName] = useState(policy?.name || '');
  const [description, setDescription] = useState(policy?.description || '');
  const [matchers, setMatchers] = useState<Matcher[]>(policy?.matchers?.length ? policy.matchers : isDefault ? [] : [{ label: 'severity', op: '=', value: 'critical' }]);
  const [chs, setChs] = useState<number[]>(policy?.channels || []);
  const [groupBy, setGroupBy] = useState<string>((policy?.groupBy || []).join(', '));
  const [groupWait, setGroupWait] = useState(policy?.groupWait || '');
  const [groupInterval, setGroupInterval] = useState(policy?.groupInterval || '');
  const [repeat, setRepeat] = useState(policy?.repeatInterval || '');
  const [cont, setCont] = useState(!!policy?.continue);
  const am = useQuery({ queryKey: ['am-alerts-labels'], queryFn: () => api<{ alerts: { labels: Record<string, string> }[] }>('/alerts') });
  const matching = useMemo(() => {
    if (isDefault) return null;
    const ok = (m: Matcher, v: string) => {
      if (m.op === '=') return v === m.value;
      if (m.op === '!=') return v !== m.value;
      try { const re = new RegExp(`^(?:${m.value})$`); return m.op === '=~' ? re.test(v) : !re.test(v); } catch { return false; }
    };
    const list = (am.data?.alerts || []).filter((a) => matchers.every((m) => ok(m, a.labels[m.label] ?? '')));
    return { n: list.length, examples: [...new Set(list.map((a) => `${a.labels.alertname}${a.labels.host ? ` on ${a.labels.host}` : ''}`))].slice(0, 4) };
  }, [am.data, matchers, isDefault]);
  const dur = /^(\d+(ms|s|m|h|d|w))*$/;
  const timingOk = [groupWait, groupInterval, repeat].every((v) => dur.test(v.trim()));
  const ready = !!name.trim() && timingOk && matchers.every((m) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(m.label));
  const setM = (i: number, p: Partial<Matcher>) => setMatchers(matchers.map((m, j) => (j === i ? { ...m, ...p } : m)));
  const save = async () => {
    const body = {
      name: name.trim(), description, matchers, channels: chs, enabled: policy?.enabled ?? true, continue: cont,
      groupBy: groupBy.trim() ? groupBy.split(/[,\s]+/).filter(Boolean) : null,
      groupWait: groupWait.trim() || null, groupInterval: groupInterval.trim() || null, repeatInterval: repeat.trim() || null,
    };
    const r = await api<{ apply: { ok: boolean | null; error: string | null } }>(policy ? `/notifications/policies/${policy.id}` : '/notifications/policies', { method: policy ? 'PUT' : 'POST', body });
    toast(policy ? 'Policy saved' : 'Policy created');
    onDone(r);
  };
  const dflt = (k: 'groupWait' | 'groupInterval' | 'repeatInterval', fb: string) => (isDefault ? fb : `${defaults?.[k] || fb} (Default)`);
  return (
    <Modal title={isDefault ? 'Default policy' : policy ? `Edit policy: ${policy.name}` : 'New notification policy'} wide onClose={onClose} actions={[{ label: 'Cancel' }, { label: policy ? 'Save policy' : 'Create policy', primary: true, disabled: !ready, onClick: save }]}>
      <div className="policy-form">
        <h4>Policy details</h4>
        <div className="form-row">
          <Field label="Policy name"><input className="input" placeholder="Platform critical alerts" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Description"><input className="input" placeholder="Critical alerts in production to Slack and PagerDuty" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        </div>

        {!isDefault && <>
          <h4>Matching conditions</h4>
          <p className="muted" style={{ margin: '0 0 8px' }}>Send notifications when alerts match <b>all</b> of these conditions. No condition = every alert reaching this policy.</p>
          {matchers.map((m, i) => {
            const known = LABELS.some(([l]) => l === m.label);
            const sug = suggestions?.[m.label] || [];
            return (
              <div key={i} className="cond-row">
                <Select className="select" label={`Condition ${i + 1} label`} value={known ? m.label : '__custom'} onChange={(v) => setM(i, { label: v === '__custom' ? '' : v })} options={[...LABELS, ['__custom', 'Other label…']]} />
                {!known && <input className="input mono" placeholder="label_name" value={m.label} onChange={(e) => setM(i, { label: e.target.value })} aria-label={`Condition ${i + 1} custom label`} style={{ maxWidth: 160 }} />}
                <Select className="select" label={`Condition ${i + 1} comparison`} value={m.op} onChange={(v) => setM(i, { op: v })} options={OPS} />
                <input className="input" list={`sug-${i}`} placeholder={m.op.includes('~') ? 'critical|warning' : 'value'} value={m.value} onChange={(e) => setM(i, { value: e.target.value })} aria-label={`Condition ${i + 1} value`} />
                <datalist id={`sug-${i}`}>{sug.map((s) => <option key={s} value={s} />)}</datalist>
                <button className="icon-btn" aria-label={`Remove condition ${i + 1}`} onClick={() => setMatchers(matchers.filter((_, j) => j !== i))}><X size={15} /></button>
              </div>
            );
          })}
          <button className="btn btn-sm" onClick={() => setMatchers([...matchers, { label: 'env', op: '=', value: '' }])}><Plus size={13} /> Add condition</button>
          {matching && <p className="dim" style={{ fontSize: 12.5, margin: '8px 0 0' }}>{am.isPending ? 'Checking active alerts…' : <>Matches <b>{matching.n}</b> active alert{matching.n === 1 ? '' : 's'} now{matching.examples.length ? `: ${matching.examples.join(', ')}${matching.n > matching.examples.length ? '…' : ''}` : ''} (a policy above may take them first).</>}</p>}
        </>}

        <h4>Notification channels</h4>
        <p className="muted" style={{ margin: '0 0 8px' }}>Send to the following channels.</p>
        {!channels.length ? <InfoBox>No channel yet: add one under Notification Channels.</InfoBox> : (
          <div className="ch-checks">
            {channels.map((c) => { const I = CH_ICON[c.type] || Webhook; return (
              <label key={c.id} className={`check-row ch-check ${c.enabled ? '' : 'off'}`}>
                <input type="checkbox" checked={chs.includes(c.id)} onChange={(e) => setChs(e.target.checked ? [...chs, c.id] : chs.filter((x) => x !== c.id))} />
                <span className={`ch-ic sm ch-${c.type}`}><I size={13} /></span><span>{c.name}</span><span className="dim" style={{ fontSize: 12 }}>{c.typeName}{c.enabled ? '' : ' · disabled'}</span>
              </label>
            ); })}
          </div>
        )}
        {!chs.length && <p className="c-orange" style={{ fontSize: 12.5 }}>No channel chosen: alerts this policy takes are not sent anywhere.</p>}

        <h4>Grouping & timing</h4>
        <div className="form-row timing-row">
          <Field label="Group by" hint="One notification per combination of these labels. Empty = as Default."><input className="input mono" placeholder={isDefault ? 'alertname, severity, env' : (defaults?.groupBy || ['alertname', 'severity', 'env']).join(', ')} value={groupBy} onChange={(e) => setGroupBy(e.target.value)} /></Field>
          <Field label="Group wait" hint="Wait to batch alerts that start together"><input className="input mono" placeholder={dflt('groupWait', '30s')} value={groupWait} onChange={(e) => setGroupWait(e.target.value)} aria-invalid={!dur.test(groupWait.trim())} /></Field>
          <Field label="Group interval" hint="Before sending new alerts of a group"><input className="input mono" placeholder={dflt('groupInterval', '5m')} value={groupInterval} onChange={(e) => setGroupInterval(e.target.value)} aria-invalid={!dur.test(groupInterval.trim())} /></Field>
          <Field label="Repeat interval" hint="Re-send while still firing"><input className="input mono" placeholder={dflt('repeatInterval', '4h')} value={repeat} onChange={(e) => setRepeat(e.target.value)} aria-invalid={!dur.test(repeat.trim())} /></Field>
        </div>
        {!isDefault && <label className="check-row" style={{ marginTop: 6 }}><input type="checkbox" checked={cont} onChange={(e) => setCont(e.target.checked)} /> Continue: also check the policies below (an alert can then go to several policies)</label>}
      </div>
    </Modal>
  );
}
