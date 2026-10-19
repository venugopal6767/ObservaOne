// Add Target wizard (Infrastructure -> Add target): choose a type, describe it, install the agent, watch it connect,
// then start monitoring. The token is one-use and short-lived by default, typed at a hidden prompt on the server
// (or read from a file for Ansible / cloud-init), and shown here only once.
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, Loader2, Server, Monitor, Boxes, Cloud, Router as RouterIcon, ShieldCheck, Circle } from 'lucide-react';
import { api } from '@/lib/api';
import { useApp } from '@/app/AppContext';
import { Field, InfoBox, PageHead, Pill, Select, Tabs, copyText, toast } from '@/components/ui';

interface Created {
  target: { id: string; name: string; env: string; role: string; labels: Record<string, string>; mode: 'push' | 'pull'; hours: number; uses: number };
  token: string; tokenExpiresAt: string; server: string;
  cert: { available: boolean; selfSigned?: boolean; sha256?: string; spkiPin?: string; issuer?: string };
}
interface Progress {
  steps: { key: string; label: string; done: boolean; hint: string }[];
  done: boolean; series: number;
  token: { uses: number; maxUses: number | null; expiresAt: string; expired: boolean; revoked: boolean };
  agent: { id: string; host: string; os: string; arch: string; kernel: string; version: string; ip: string; status: string; collectors: Record<string, string>; addresses: string[]; mode: string } | null;
}

const TYPES = [
  { key: 'linux', label: 'Linux server', Icon: Server, ready: true, desc: 'Ubuntu, Debian, RHEL, Rocky, Alma, Amazon Linux, SUSE (systemd; amd64 or arm64)' },
  { key: 'windows', label: 'Windows server', Icon: Monitor, ready: false, desc: 'Use Agents → Windows (previous agent) for now' },
  { key: 'kubernetes', label: 'Kubernetes cluster', Icon: Boxes, ready: false, desc: 'Use Agents → Kubernetes (previous agent) for now' },
  { key: 'vmware', label: 'VMware vCenter', Icon: Cloud, ready: false, desc: 'Coming later' },
  { key: 'snmp', label: 'Network device', Icon: RouterIcon, ready: false, desc: 'Coming later' },
];
const shq = (v: string) => `'${String(v).replace(/'/g, "'\\''")}'`;

function commands(c: Created, labels: string[], pullPort: string) {
  const S = c.server;
  const pin = c.cert?.available && c.cert.selfSigned;
  const curlGet = pin ? `curl -fsSLk --pinnedpubkey "${c.cert.spkiPin}"` : 'curl -fsSL';
  const opts = [`--server ${S}`];
  if (pin) opts.push(`--ca-sha256 ${c.cert.sha256}`);
  if (c.target.env) opts.push(`--env ${shq(c.target.env)}`);
  if (c.target.role) opts.push(`--role ${shq(c.target.role)}`);
  for (const l of labels) opts.push(`--label ${shq(l)}`);
  if (c.target.mode === 'pull') { opts.push('--mode pull'); if (pullPort) opts.push(`--pull-port ${shq(pullPort)}`); }
  const download = `${curlGet} ${S}/agent/install.sh -o observaone-install.sh`;
  const interactive = [download, `sudo bash observaone-install.sh \\\n  ${[...opts, `--token ${c.token}`].join(' \\\n  ')}`].join('\n');
  const automated = [
    '# the token goes in a root-only file; the installer deletes it after use',
    `install -m 0600 /dev/null /root/observaone.token && printf '%s' "$OBSERVAONE_TOKEN" > /root/observaone.token`,
    download,
    `sudo bash observaone-install.sh \\\n  ${[...opts, '--token-file /root/observaone.token'].join(' \\\n  ')}`,
  ].join('\n');
  return { interactive, automated };
}

export default function AddTarget() {
  const { can } = useApp();
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [kind, setKind] = useState('linux');
  const [form, setForm] = useState({ name: '', env: '', role: '', labels: '', mode: 'push' as 'push' | 'pull', hours: 24, uses: 1, pullPort: '' });
  const [created, setCreated] = useState<Created | null>(null);
  const [busy, setBusy] = useState(false);
  const [how, setHow] = useState<'interactive' | 'automated'>('interactive');
  const [shown, setShown] = useState(false);
  const labels = form.labels.split(',').map((x) => x.trim()).filter(Boolean);

  const progress = useQuery({
    queryKey: ['target-progress', created?.target.id], enabled: !!created && step >= 3,
    queryFn: () => api<Progress>(`/targets/${created!.target.id}/progress`), refetchInterval: (q) => (q.state.data?.done ? false : 3000),
  });
  useEffect(() => { if (progress.data?.steps.some((s) => s.done) && step === 3) setStep(4); }, [progress.data, step]);
  useEffect(() => { if (progress.data?.done && step === 4) setStep(5); }, [progress.data, step]);

  if (!can('integrations.manage')) {
    return <><PageHead title="Add target" /><InfoBox tone="error">You need the "Data sources, monitored servers" permission to add targets.</InfoBox></>;
  }

  const create = async () => {
    const lab: Record<string, string> = {};
    for (const l of labels) { const [k, ...v] = l.split('='); lab[k.trim()] = v.join('=').trim(); }
    setBusy(true);
    try {
      const r = await api<Created>('/targets', { method: 'POST', body: { kind, name: form.name.trim(), env: form.env.trim(), role: form.role.trim(), labels: lab, mode: form.mode, validHours: Number(form.hours), maxUses: Number(form.uses) } });
      setCreated(r); setStep(3); setShown(false);
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  const cmd = created ? commands(created, labels, form.pullPort) : null;
  const host = created?.server.replace(/^https?:\/\//, '') || '';
  const steps = ['Type', 'Describe', 'Install', 'Waiting for agent', 'Discovered'];

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><Link to="/infrastructure">Infrastructure</Link> › <span>Add target</span></nav>
      <PageHead title="Add target" sub="Monitor a new server: describe it, run two commands on it, and watch it connect" />
      <ol className="wizard-steps" aria-label="Steps">
        {steps.map((s, i) => <li key={s} className={step === i + 1 ? 'current' : step > i + 1 ? 'done' : ''}><span className="n">{step > i + 1 ? <Check size={12} /> : i + 1}</span>{s}</li>)}
      </ol>

      {step === 1 && (
        <section className="panel">
          <div className="panel-head"><h3>What do you want to monitor?</h3></div>
          <div className="type-grid">
            {TYPES.map((t) => (
              <button key={t.key} type="button" className={`type-card ${kind === t.key ? 'on' : ''}`} disabled={!t.ready} aria-pressed={kind === t.key} onClick={() => setKind(t.key)}>
                <t.Icon size={22} /><b>{t.label}</b><span className="dim">{t.desc}</span>{!t.ready && <Pill tone="muted">not yet</Pill>}
              </button>
            ))}
          </div>
          <div className="toolbar" style={{ marginTop: 14 }}><div className="grow" /><button className="btn btn-primary" onClick={() => setStep(2)}>Next</button></div>
        </section>
      )}

      {step === 2 && (
        <section className="panel">
          <div className="panel-head"><h3>Describe the server</h3></div>
          <div className="grid cols-2">
            <Field label="Name" hint="How you call it; the agent reports the host's own name too."><input className="input" placeholder="payments-db-01" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Environment"><input className="input" placeholder="prod, uat, dev" value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} /></Field>
            <Field label="Role"><input className="input" placeholder="web, database, app" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} /></Field>
            <Field label="Labels" hint="key=value, comma separated; lower-case keys; up to 10."><input className="input" placeholder="team=payments, tier=1" value={form.labels} onChange={(e) => setForm({ ...form, labels: e.target.value })} /></Field>
            <Field label="How metrics travel" hint={form.mode === 'push' ? `Firewall: outbound HTTPS 443 from the server to ${window.location.host} only. Works behind NAT.` : 'Firewall: outbound 443 for heartbeats, plus inbound TCP 9110 from the ObservaOne server for Prometheus (mutual TLS).'}>
              <Select className="select" label="Transport" value={form.mode} onChange={(v) => setForm({ ...form, mode: v as 'push' | 'pull' })} options={[['push', 'Push (recommended)'], ['pull', 'Pull (Prometheus scrapes the agent)']]} />
            </Field>
            {form.mode === 'pull' && <Field label="Pull port (optional)" hint="Default 9110."><input className="input" placeholder="9110" value={form.pullPort} onChange={(e) => setForm({ ...form, pullPort: e.target.value })} /></Field>}
            <Field label="Token valid for"><Select className="select" label="Token validity" value={form.hours} onChange={(v) => setForm({ ...form, hours: v })} options={[[1, '1 hour'], [24, '24 hours'], [168, '7 days'], [720, '30 days']]} /></Field>
            <Field label="Servers that may use the token" hint="One for a single server; more for a group installed with Ansible."><Select className="select" label="Max uses" value={form.uses} onChange={(v) => setForm({ ...form, uses: v })} options={[[1, 'One server'], [10, 'Up to 10'], [100, 'Up to 100']]} /></Field>
          </div>
          <div className="toolbar" style={{ marginTop: 14 }}>
            <button className="btn" onClick={() => setStep(1)}>Back</button><div className="grow" />
            <button className="btn btn-primary" disabled={busy || !form.name.trim()} onClick={create}>{busy ? 'Creating…' : 'Create target and token'}</button>
          </div>
        </section>
      )}

      {step >= 3 && created && cmd && (
        <>
          <section className="panel">
            <div className="panel-head"><h3>Install on {created.target.name}</h3><Pill tone="muted">{created.target.mode === 'pull' ? 'pull' : 'push'}</Pill></div>
            <div className="token-box">
              <div><b>Enrollment token</b> <span className="dim">· valid until {new Date(created.tokenExpiresAt).toLocaleString()} · {created.target.uses === 1 ? 'one server' : `up to ${created.target.uses} servers`} · shown only here</span></div>
              <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                <code className="mono token-val">{shown ? created.token : '•'.repeat(24)}</code>
                <button className="btn btn-sm" onClick={() => setShown((x) => !x)}>{shown ? 'Hide' : 'Show'}</button>
                <button className="btn btn-sm" onClick={() => copyText(created.token, 'Token copied')}><Copy size={13} />Copy token</button>
              </div>
            </div>
            <Tabs items={[['interactive', 'On the server'], ['automated', 'Ansible / cloud-init']]} active={how} onChange={setHow} label="How to install" />
            <div className="muted" style={{ margin: '8px 0' }}>{how === 'interactive' ? 'Run these two lines on the server. The token is already in the command: it works once and expires.' : 'Put the token in OBSERVAONE_TOKEN from your secrets store (never in plain user-data), then run:'}</div>
            <div style={{ position: 'relative' }}>
              <pre className="code cmd" tabIndex={0} aria-label="Install command">{cmd[how]}</pre>
              <button className="btn btn-sm" style={{ position: 'absolute', top: 6, right: 6 }} onClick={() => copyText(cmd[how], 'Commands copied')}><Copy size={13} />Copy</button>
            </div>
            <ul className="agent-notes">
              <li>Network: outbound HTTPS (443) from the server to <code>{host}</code>{created.target.mode === 'pull' ? <>; inbound TCP {form.pullPort || '9110'} from the ObservaOne server</> : '; nothing inbound'}.</li>
              {created.cert?.selfSigned && <li><ShieldCheck size={13} style={{ verticalAlign: -2 }} /> The command pins this server's certificate fingerprint, so the agent only ever talks to this server.</li>}
              <li>Needs systemd, root (sudo) to install, curl and sha256sum. The agent runs as the unprivileged user observaone-agent.</li>
            </ul>
          </section>
          <section className="panel" style={{ marginTop: 14 }}>
            <div className="panel-head"><h3>Waiting for the agent</h3>{progress.isFetching && !progress.data?.done && <Loader2 size={14} className="spin" />}</div>
            <ol className="checklist">
              {(progress.data?.steps || [{ key: 'enrolled', label: 'Agent enrolled', done: false, hint: 'Run the commands above.' }]).map((s, i, all) => {
                const current = !s.done && all.slice(0, i).every((x) => x.done);
                return (
                  <li key={s.key} className={s.done ? 'done' : current ? 'current' : ''}>
                    {s.done ? <Check size={15} /> : current ? <Loader2 size={15} className="spin" /> : <Circle size={15} />}
                    <div><b>{s.label}</b>{current && s.hint && <div className="dim" style={{ fontSize: 12.5 }}>{s.hint}</div>}</div>
                  </li>
                );
              })}
            </ol>
          </section>
        </>
      )}

      {step === 5 && progress.data?.agent && (
        <section className="panel" style={{ marginTop: 14 }}>
          <div className="panel-head"><h3>Discovered: {progress.data.agent.host}</h3><Pill tone="green">Connected</Pill></div>
          <dl className="kv">
            <dt>Operating system</dt><dd>{progress.data.agent.os || '-'} · {progress.data.agent.arch}</dd>
            <dt>Kernel</dt><dd>{progress.data.agent.kernel || '-'}</dd>
            <dt>Addresses</dt><dd>{progress.data.agent.addresses.join(', ') || progress.data.agent.ip || '-'}</dd>
            <dt>Agent</dt><dd>{progress.data.agent.version} · {progress.data.agent.mode === 'pull' ? 'pull' : 'push'}</dd>
            <dt>Collectors on</dt><dd>{Object.entries(progress.data.agent.collectors).filter(([, v]) => v === 'ok').map(([k]) => k).join(', ') || '-'}</dd>
            <dt>Series in Prometheus</dt><dd>{progress.data.series}</dd>
          </dl>
          <div className="toolbar" style={{ marginTop: 14 }}>
            <Link className="btn" to="/infrastructure/add" onClick={() => { setCreated(null); setStep(1); }} reloadDocument>Add another</Link><div className="grow" />
            <button className="btn btn-primary" onClick={() => navigate(`/metrics/host/${encodeURIComponent(progress.data!.agent!.host)}`)}>Start monitoring</button>
          </div>
        </section>
      )}
    </>
  );
}
