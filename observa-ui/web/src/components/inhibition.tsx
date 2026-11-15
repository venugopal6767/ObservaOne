// Alerts -> Inhibition: alerts muted while a related, more important alert fires. The rules come from
// alertmanager/alertmanager.yml (inhibit_rules); this page explains each one and shows what it mutes right now.
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, VolumeX } from 'lucide-react';
import { api } from '@/lib/api';
import { ErrorState, InfoBox, Panel, Pill, StateView, TableWrap, Time } from '@/components/ui';
import { SeverityPill } from '@/components/alerts';

interface M { label: string; op: string; value: string }
interface InhRule { id: number; source: M[]; target: M[]; equal: string[]; mutingNow: number }
interface Muted { alertname: string; severity: string; host: string; since: string; by: { alertname: string; severity: string; host: string }[]; rule: number | null }

const OPW: Record<string, string> = { '=': 'is', '!=': 'is not', '=~': 'matches', '!~': 'does not match' };
function words(ms: M[]) {
  if (!ms.length) return <i>any alert</i>;
  return ms.map((m, i) => (
    <span key={i}>{i > 0 && ' and '}<span className="mono">{m.label}</span> {OPW[m.op] || m.op} <b className="mono">{m.op.includes('~') ? m.value.split('|').join(' | ') : m.value}</b></span>
  ));
}

export function Inhibition() {
  const q = useQuery({ queryKey: ['inhibition'], queryFn: () => api<{ rules: InhRule[]; muted: Muted[]; alertmanagerReachable: boolean }>('/notifications/inhibition'), refetchInterval: 30_000 });
  if (q.isPending) return <StateView kind="loading" />;
  if (q.isError) return <ErrorState error={q.error} what="Inhibition" />;
  const d = q.data;
  return (
    <>
      {!d.alertmanagerReachable && <InfoBox tone="error">Alertmanager cannot be reached: the alerts muted right now are not known.</InfoBox>}
      <div className="inh-grid">
        {!d.rules.length && <StateView kind="empty" title="No inhibition rules" text="Every alert notifies, even when a related one is already firing. Add inhibit_rules in alertmanager/alertmanager.yml." />}
        {d.rules.map((r) => (
          <Panel key={r.id} title={`Rule ${r.id}`} right={r.mutingNow ? <Pill tone="orange">muting {r.mutingNow} now</Pill> : <Pill tone="muted">nothing muted now</Pill>}>
            <div className="inh-flow">
              <div className="inh-box src"><div className="dim">While an alert where</div><div>{words(r.source)}</div><div className="dim">is firing</div></div>
              <ArrowRight className="dim" aria-hidden />
              <div className="inh-box tgt"><div className="dim">mute alerts where</div><div>{words(r.target)}</div>
                {r.equal.length > 0 && <div className="dim">with the same {r.equal.map((e, i) => <span key={e}>{i > 0 && (i === r.equal.length - 1 ? ' and ' : ', ')}<span className="mono">{e}</span></span>)}</div>}
              </div>
            </div>
          </Panel>
        ))}
      </div>
      <h3 style={{ margin: '20px 0 8px', fontSize: 15 }}>Muted right now</h3>
      <TableWrap label="Muted alerts">
        <table className="tbl">
          <thead><tr><th>Severity</th><th>Alert</th><th>Host</th><th>Muted by</th><th>Rule</th><th>Since</th></tr></thead>
          <tbody>
            {!d.muted.length && <tr><td colSpan={6} className="dim" style={{ padding: 16 }}>No alert is muted by inhibition right now.</td></tr>}
            {d.muted.map((m, i) => (
              <tr key={i}>
                <td><SeverityPill s={m.severity} /></td>
                <td><VolumeX size={13} className="dim" /> <b>{m.alertname}</b></td>
                <td className="mono">{m.host || '—'}</td>
                <td>{m.by.map((b, j) => <div key={j}><SeverityPill s={b.severity} /> {b.alertname} <span className="dim mono">{b.host}</span></div>)}</td>
                <td>{m.rule ? `Rule ${m.rule}` : '—'}</td>
                <td><Time ms={Date.parse(m.since)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      <p className="muted" style={{ marginTop: 10 }}>Muted alerts still show in Active Alerts (marked <i>Muted</i>); only their notifications are held back. The rules are in <span className="mono">alertmanager/alertmanager.yml</span> (inhibit_rules): edit it and restart observa.</p>
    </>
  );
}
