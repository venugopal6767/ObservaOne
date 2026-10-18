// Two-factor sign-in (authenticator app) setup: in Settings, and full-page when an admin requires it.
import { useEffect, useRef, useState } from 'react';
import { Download, Copy } from 'lucide-react';
import { api } from '@/lib/api';
import { Logo } from '@/components/Logo';
import { InfoBox, copyText } from '@/components/ui';

export function MfaSetup({ onDone, compact = false }: { onDone: () => void; compact?: boolean }) {
  const [setup, setSetup] = useState<{ qr: string; secret: string } | null>(null);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<{ qr: string; secret: string }>('/me/mfa/setup', { method: 'POST' }).then(setSetup).catch((e) => setError(e.message));
  }, []);
  useEffect(() => { if (setup) setTimeout(() => input.current?.focus(), 50); }, [setup]);

  async function submit() {
    setError('');
    setBusy(true);
    try {
      const r = await api<{ recoveryCodes: string[] }>('/me/mfa/enable', { method: 'POST', body: { code: code.trim() } });
      setCodes(r.recoveryCodes);
    } catch (e) {
      setError((e as Error).message);
      input.current?.select();
    } finally { setBusy(false); }
  }

  if (codes) return <RecoveryCodes codes={codes} onDone={onDone} compact={compact} />;
  if (!setup) return error ? <InfoBox tone="error">{error}</InfoBox> : <div className="muted">Preparing...</div>;
  return (
    <div>
      <ol className="steps">
        <li>Install an authenticator app on your phone (Microsoft Authenticator, Google Authenticator, 1Password, ...).</li>
        <li>Scan this QR code with the app:
          <div className="qr-row">
            <img src={setup.qr} alt="QR code for the authenticator app" width={180} height={180} className="qr" />
            <div className="muted" style={{ fontSize: 12 }}>Can't scan it? Type this key into the app:
              <div className="mono secret-key">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</div>
            </div>
          </div>
        </li>
        <li>Type the 6-digit code the app shows:
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input ref={input} className="input mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" value={code}
              style={{ width: 140, fontSize: 18, letterSpacing: 3 }} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} aria-label="Code" />
            <button className="btn btn-primary" disabled={busy} onClick={submit}>Turn on</button>
          </div>
        </li>
      </ol>
      {error && <div style={{ marginTop: 10 }}><InfoBox tone="error">{error}</InfoBox></div>}
    </div>
  );
}

export function RecoveryCodes({ codes, onDone, compact }: { codes: string[]; onDone: () => void; compact?: boolean }) {
  const [saved, setSaved] = useState(false);
  const text = `${document.title} recovery codes\n${new Date().toISOString().slice(0, 10)}\n\n${codes.join('\n')}\n\nEach code works once.`;
  return (
    <div>
      <InfoBox tone="ok">Two-factor sign-in is on.</InfoBox>
      <p>Save these recovery codes somewhere safe (a password manager). If you lose your phone, each code lets you sign in once.</p>
      <div className="recovery-grid mono">{codes.map((c) => <span key={c}>{c}</span>)}</div>
      <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
        <button className="btn btn-sm" onClick={() => copyText(text)}><Copy size={13} />Copy</button>
        <button className="btn btn-sm" onClick={() => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
          a.download = 'recovery-codes.txt';
          a.click();
        }}><Download size={13} />Download</button>
      </div>
      <label className="check-row"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I have saved my recovery codes</label>
      <div style={{ marginTop: 12 }}><button className="btn btn-primary" disabled={!saved} onClick={onDone}>{compact ? 'Done' : 'Continue'}</button></div>
    </div>
  );
}

export function ForcedMfa({ onDone, onLogout }: { onDone: () => void; onLogout: () => void }) {
  return (
    <div className="login single">
      <div className="login-card wide">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}><Logo size={30} /><h2>Set up two-factor sign-in</h2></div>
        <div className="sub">Your administrator requires a second step when you sign in. It takes about a minute.</div>
        <MfaSetup onDone={onDone} />
        <div className="login-foot"><a href="#" onClick={(e) => { e.preventDefault(); onLogout(); }}>Sign out</a></div>
      </div>
    </div>
  );
}
