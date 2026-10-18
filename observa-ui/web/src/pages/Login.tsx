// Sign-in: password (local or LDAP), then the authenticator code when MFA is on, plus SSO buttons.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { User, Lock, Eye, EyeOff, KeyRound, Shield, LineChart, FileText, Waypoints, LogIn } from 'lucide-react';
import { api } from '@/lib/api';
import { Logo } from '@/components/Logo';
import { InfoBox, toast } from '@/components/ui';

function splitBrand(b: string): [string, string] {
  const m = /^(.*?)([A-Z][a-z]+)$/.exec(b);
  return m && m[1] ? [m[1], m[2]] : [b, ''];
}

type Provider = { id: string; label: string; icon: string };

export function LoginPage({ onSuccess }: { onSuccess: () => Promise<void> | void }) {
  const [brand, setBrand] = useState('ObservaOne');
  const [providers, setProviders] = useState<Provider[]>([]);
  const [ldap, setLdap] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState(() => new URLSearchParams(location.search).get('sso_error') || '');
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const pwRef = useRef<HTMLInputElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    api<{ brand: string }>('/brand').then((b) => b?.brand && setBrand(b.brand)).catch(() => {});
    api<{ providers?: Provider[]; ldap?: boolean }>('/auth/providers').then((p) => { setProviders(p.providers || []); setLdap(!!p.ldap); }).catch(() => {});
  }, []);
  useEffect(() => { document.title = `Sign in - ${brand}`; }, [brand]);
  useEffect(() => (canvas.current ? animateWaves(canvas.current) : undefined), []);
  useEffect(() => { if (challenge) codeRef.current?.focus(); }, [challenge, useRecovery]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (!challenge) {
        if (!username.trim() || !password) throw new Error('Enter username and password.');
        const r = await api<{ user?: unknown; mfaRequired?: boolean; challenge?: string }>('/login', { method: 'POST', body: { username: username.trim(), password, remember } });
        setPassword('');
        if (r.mfaRequired) { setChallenge(r.challenge!); return; }
      } else {
        const v = code.trim();
        if (!v) throw new Error('Enter the code.');
        await api('/login/mfa', { method: 'POST', body: useRecovery ? { challenge, recoveryCode: v } : { challenge, code: v } });
      }
      toast(`Welcome, ${username.trim()}`);
      await onSuccess();
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      if (challenge) {
        codeRef.current?.select();
        if (/took too long|start again/i.test(msg)) { setChallenge(null); setCode(''); }
      } else pwRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  const [first, second] = splitBrand(brand);
  const back = sessionStorage.getItem('oo.after-login') || '/overview';
  const ProviderIcon = ({ name }: { name: string }) => (name === 'github' || name === 'google' ? <LogIn size={15} /> : <Shield size={15} />);

  return (
    <div className="login">
      <canvas ref={canvas} className="waves" aria-hidden="true" />
      <div className="login-brand">
        <div className="name"><Logo size={54} /><span>{first}<b>{second}</b></span></div>
        <div className="tag">Unified Observability Platform</div>
        <Feature icon={<LineChart size={19} />} title="Metrics" text="Monitor infrastructure and applications" />
        <Feature icon={<FileText size={19} />} title="Logs" text="Search and analyze logs in real-time" />
        <Feature icon={<Waypoints size={19} />} title="Traces" text="Trace requests end-to-end" />
        <div className="all">All in One Platform</div>
      </div>
      <form className="login-card" noValidate onSubmit={submit}>
        <h2>Welcome Back</h2>
        <div className="sub">{ldap ? 'Sign in with your company (directory) account' : `Sign in to your ${brand} account`}</div>
        {error && <div className="login-error"><InfoBox tone="error">{error}</InfoBox></div>}
        {!challenge ? (
          <div>
            <label className="field"><span className="field-label">Username</span>
              <div className="input-icon"><User size={16} className="dim" /><input type="text" name="username" autoComplete="username" placeholder="Enter username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} /></div>
            </label>
            <label className="field"><span className="field-label">Password</span>
              <div className="input-icon"><Lock size={16} className="dim" />
                <input ref={pwRef} type={showPw ? 'text' : 'password'} name="password" autoComplete="current-password" placeholder="Enter password" value={password} onChange={(e) => setPassword(e.target.value)} />
                <button type="button" aria-label={showPw ? 'Hide password' : 'Show password'} onClick={() => setShowPw(!showPw)}>{showPw ? <EyeOff size={16} /> : <Eye size={16} />}</button>
              </div>
            </label>
            <div className="login-row">
              <label><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />Remember me</label>
              <a href="#" onClick={(e) => { e.preventDefault(); toast('Ask your administrator to reset your password (Settings > Users).'); }}>Forgot password?</a>
            </div>
            <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Signing in...' : 'Sign In'}</button>
            {providers.length > 0 && (
              <>
                <div className="or">Or continue with</div>
                <div className="sso-row" style={{ gridTemplateColumns: `repeat(${Math.min(3, providers.length)}, 1fr)` }}>
                  {providers.map((p) => <a key={p.id} className="btn" href={`/api/auth/${p.id}/login?return=${encodeURIComponent(back)}`}><ProviderIcon name={p.icon} />{p.label}</a>)}
                </div>
              </>
            )}
          </div>
        ) : (
          <div>
            <InfoBox>Two-factor sign-in is on for this account.</InfoBox>
            <label className="field"><span className="field-label">{useRecovery ? 'One of your recovery codes' : 'Code from your authenticator app'}</span>
              <div className="input-icon"><KeyRound size={16} className="dim" />
                <input ref={codeRef} className="mfa-input" type="text" inputMode={useRecovery ? 'text' : 'numeric'} autoComplete="one-time-code" maxLength={useRecovery ? 11 : 6}
                  placeholder={useRecovery ? 'abcde-12345' : '123456'} aria-label="Code" value={code} onChange={(e) => setCode(e.target.value)} />
              </div>
            </label>
            <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Checking...' : 'Verify'}</button>
            <div className="login-row" style={{ marginTop: 12 }}>
              <a href="#" onClick={(e) => { e.preventDefault(); setUseRecovery(!useRecovery); setCode(''); }}>{useRecovery ? 'Use the authenticator app instead' : 'Use a recovery code instead'}</a>
              <a href="#" onClick={(e) => { e.preventDefault(); setChallenge(null); setCode(''); setError(''); }}>Back</a>
            </div>
          </div>
        )}
        <div className="login-foot">Authorised users only. All sign-ins are logged.</div>
      </form>
    </div>
  );
}

function Feature({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return <div className="feature"><div className="fi">{icon}</div><div><b>{title}</b><span>{text}</span></div></div>;
}

/** Flowing particle wave in the background. Static when the user prefers reduced motion. */
function animateWaves(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')!;
  let w = 0, hgt = 0, raf = 0, t = 0;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function size() {
    w = canvas.clientWidth; hgt = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = hgt * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function frame() {
    ctx.clearRect(0, 0, w, hgt);
    const rows = 26, cols = Math.ceil(w / 14);
    for (let r = 0; r < rows; r++) {
      const depth = r / rows;
      const baseY = hgt * (0.58 + depth * 0.5);
      const amp = 28 + depth * 70;
      for (let c = 0; c <= cols; c++) {
        const x = (c / cols) * w;
        const y = baseY + Math.sin(c * 0.09 + t * 0.9 + r * 0.35) * amp * 0.5 + Math.sin(c * 0.035 - t * 0.6 + r * 0.2) * amp * 0.6 - depth * 140;
        const alpha = 0.12 + 0.55 * (1 - depth) * (0.6 + 0.4 * Math.sin(c * 0.2 + t + r));
        ctx.fillStyle = `rgba(${70 + r * 3}, ${140 + r * 2}, 255, ${Math.max(0.05, alpha * 0.7)})`;
        ctx.fillRect(x, y, 1.6 + (1 - depth) * 0.8, 1.6 + (1 - depth) * 0.8);
      }
    }
    t += 0.012;
    if (!reduce) raf = requestAnimationFrame(frame);
  }
  size();
  window.addEventListener('resize', size);
  frame();
  return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', size); };
}
