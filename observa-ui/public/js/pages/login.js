import { h, api, icon, logo, errorBox, toast } from '../ui.js';

export function renderLogin(root, onSuccess) {
  let brand = 'ObservaOne';
  const [first, second] = splitBrand(brand);
  const nameEl = h('div', { class: 'name' }, logo(54), h('span', {}, first, h('b', {}, second)));
  api('/brand').then((b) => {
    if (b?.brand && b.brand !== brand) {
      brand = b.brand;
      const [f, s] = splitBrand(brand);
      nameEl.lastChild.replaceWith(h('span', {}, f, h('b', {}, s)));
      document.title = `Sign in - ${brand}`;
    }
  }).catch(() => {});
  document.title = `Sign in - ${brand}`;

  const user = h('input', { type: 'text', name: 'username', autocomplete: 'username', placeholder: 'Enter username', required: true, autofocus: true, 'aria-label': 'Username' });
  const pass = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', placeholder: 'Enter password', required: true, 'aria-label': 'Password' });
  const eye = h('button', { type: 'button', title: 'Show password', 'aria-label': 'Show password', onclick: () => {
    const show = pass.type === 'password';
    pass.type = show ? 'text' : 'password';
    eye.replaceChildren(icon(show ? 'eyeOff' : 'eye', 16));
  } }, icon('eye', 16));
  const remember = h('input', { type: 'checkbox', name: 'remember' });
  const errSlot = h('div');
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Sign In');
  const hint = h('div', { class: 'sub' }, `Sign in to your ${brand} account`);
  const ssoBox = h('div');

  // error sent back by an SSO provider redirect
  const ssoErr = new URLSearchParams(location.search).get('sso_error');
  if (ssoErr) errSlot.append(h('div', { class: 'login-error' }, errorBox(ssoErr)));

  api('/auth/providers').then((p) => {
    if (p.ldap) hint.textContent = 'Sign in with your company (directory) account';
    if (!p.providers?.length) return;
    const back = sessionStorage.getItem('oo.after-login') || '/overview';
    ssoBox.append(
      h('div', { class: 'or' }, 'Or continue with'),
      h('div', { class: 'sso-row', style: { gridTemplateColumns: `repeat(${Math.min(3, p.providers.length)}, 1fr)` } },
        p.providers.map((x) => h('a', { class: 'btn', href: `/api/auth/${x.id}/login?return=${encodeURIComponent(back)}` }, icon(x.icon, 15), x.label))));
  }).catch(() => {});

  const passwordStep = h('div', {},
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Username'), h('div', { class: 'input-icon' }, icon('user', 16), user)),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Password'), h('div', { class: 'input-icon' }, icon('lock', 16), pass, eye)),
    h('div', { class: 'login-row' },
      h('label', {}, remember, 'Remember me'),
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); toast('Ask your administrator to reset your password (Settings > Users).'); } }, 'Forgot password?')),
    submit,
    ssoBox);

  // second step: code from the authenticator app (or a recovery code)
  let challenge = null, useRecovery = false;
  const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '123456', 'aria-label': 'Code', class: 'mfa-input' });
  const codeLabel = h('span', { class: 'field-label' }, 'Code from your authenticator app');
  const switchLink = h('a', { href: '#', onclick: (e) => {
    e.preventDefault();
    useRecovery = !useRecovery;
    code.value = '';
    code.maxLength = useRecovery ? 11 : 6;
    code.placeholder = useRecovery ? 'abcde-12345' : '123456';
    code.inputMode = useRecovery ? 'text' : 'numeric';
    codeLabel.textContent = useRecovery ? 'One of your recovery codes' : 'Code from your authenticator app';
    switchLink.textContent = useRecovery ? 'Use the authenticator app instead' : 'Use a recovery code instead';
    code.focus();
  } }, 'Use a recovery code instead');
  const mfaStep = h('div', { class: 'hidden' },
    h('div', { class: 'info-box' }, icon('shield', 16), h('span', {}, 'Two-factor sign-in is on for this account.')),
    h('label', { class: 'field' }, codeLabel, h('div', { class: 'input-icon' }, icon('key', 16), code)),
    h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Verify'),
    h('div', { class: 'login-row', style: { marginTop: '12px' } }, switchLink,
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); challenge = null; mfaStep.classList.add('hidden'); passwordStep.classList.remove('hidden'); errSlot.replaceChildren(); } }, 'Back')));

  const form = h('form', { class: 'login-card', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    errSlot.replaceChildren();
    const btn = (challenge ? mfaStep : passwordStep).querySelector('button[type=submit]');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = challenge ? 'Checking...' : 'Signing in...';
    try {
      let r;
      if (!challenge) {
        if (!user.value.trim() || !pass.value) throw new Error('Enter username and password.');
        r = await api('/login', { method: 'POST', body: { username: user.value.trim(), password: pass.value, remember: remember.checked } });
        pass.value = '';
        if (r.mfaRequired) {
          challenge = r.challenge;
          passwordStep.classList.add('hidden');
          mfaStep.classList.remove('hidden');
          code.focus();
          return;
        }
      } else {
        const v = code.value.trim();
        if (!v) throw new Error('Enter the code.');
        r = await api('/login/mfa', { method: 'POST', body: useRecovery ? { challenge, recoveryCode: v } : { challenge, code: v } });
      }
      stop();
      await onSuccess(r.user);
    } catch (err) {
      errSlot.append(h('div', { class: 'login-error' }, errorBox(err.message)));
      if (challenge) {
        code.select();
        if (/took too long|start again/i.test(err.message)) { challenge = null; mfaStep.classList.add('hidden'); passwordStep.classList.remove('hidden'); }
      } else pass.focus();
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  } },
    h('h2', {}, 'Welcome Back'),
    hint,
    errSlot,
    passwordStep,
    mfaStep,
    h('div', { class: 'login-foot' }, 'Authorised users only. All sign-ins are logged.'));

  const canvas = h('canvas', { class: 'waves', 'aria-hidden': 'true' });
  const page = h('div', { class: 'login' },
    canvas,
    h('div', { class: 'login-brand' },
      nameEl,
      h('div', { class: 'tag' }, 'Unified Observability Platform'),
      feature('metrics', 'Metrics', 'Monitor infrastructure and applications'),
      feature('logs', 'Logs', 'Search and analyze logs in real-time'),
      feature('traces', 'Traces', 'Trace requests end-to-end'),
      h('div', { class: 'all' }, 'All in One Platform')),
    form);
  root.append(page);
  const stop = animateWaves(canvas);
}

function splitBrand(b) {
  const m = /^(.*?)([A-Z][a-z]+)$/.exec(b);
  return m && m[1] ? [m[1], m[2]] : [b, ''];
}

function feature(ic, title, text) {
  return h('div', { class: 'feature' }, h('div', { class: 'fi' }, icon(ic, 19)), h('div', {}, h('b', {}, title), h('span', {}, text)));
}

// Flowing particle wave in the background (stops when the page is left).
function animateWaves(canvas) {
  const ctx = canvas.getContext('2d');
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
