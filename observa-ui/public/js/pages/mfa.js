// Two-factor sign-in (authenticator app) setup, used in Settings and when an admin makes MFA compulsory.
import { h, api, clear, icon, logo, errorBox, toast } from '../ui.js';

// Renders the setup steps into `box`. Calls onDone() after the user has saved the recovery codes.
export async function mfaSetupFlow(box, { onDone, compact = false } = {}) {
  clear(box).append(h('div', { class: 'muted' }, 'Preparing...'));
  let setup;
  try {
    setup = await api('/me/mfa/setup', { method: 'POST' });
  } catch (e) {
    clear(box).append(errorBox(e.message));
    return;
  }
  const code = h('input', { class: 'input mono', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '123456', style: { width: '140px', fontSize: '18px', letterSpacing: '3px' } });
  const err = h('div');
  const confirm = h('button', { class: 'btn btn-primary', onclick: submit }, 'Turn on');
  code.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  clear(box).append(
    h('ol', { class: 'steps' },
      h('li', {}, 'Install an authenticator app on your phone (Microsoft Authenticator, Google Authenticator, 1Password, ...).'),
      h('li', {}, 'Scan this QR code with the app:',
        h('div', { class: 'qr-row' },
          h('img', { src: setup.qr, alt: 'QR code for the authenticator app', width: 180, height: 180, class: 'qr' }),
          h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Can\'t scan it? Type this key into the app:',
            h('div', { class: 'mono secret-key' }, setup.secret.replace(/(.{4})/g, '$1 ').trim())))),
      h('li', {}, 'Type the 6-digit code the app shows:', h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } }, code, confirm))),
    err);
  setTimeout(() => code.focus(), 50);

  async function submit() {
    clear(err);
    confirm.disabled = true;
    try {
      const r = await api('/me/mfa/enable', { method: 'POST', body: { code: code.value.trim() } });
      showRecovery(box, r.recoveryCodes, onDone, compact);
    } catch (e) {
      err.append(h('div', { style: { marginTop: '10px' } }, errorBox(e.message)));
      code.select();
    } finally {
      confirm.disabled = false;
    }
  }
}

export function showRecovery(box, codes, onDone, compact) {
  const text = `${document.title} recovery codes\n${new Date().toISOString().slice(0, 10)}\n\n${codes.join('\n')}\n\nEach code works once.`;
  const saved = h('input', { type: 'checkbox' });
  const done = h('button', { class: 'btn btn-primary', disabled: true, onclick: () => onDone?.() }, compact ? 'Done' : 'Continue');
  saved.addEventListener('change', () => { done.disabled = !saved.checked; });
  clear(box).append(
    h('div', { class: 'ok-box' }, icon('check', 16), 'Two-factor sign-in is on.'),
    h('p', {}, 'Save these recovery codes somewhere safe (a password manager). If you lose your phone, each code lets you sign in once.'),
    h('div', { class: 'recovery-grid mono' }, codes.map((c) => h('span', {}, c))),
    h('div', { style: { display: 'flex', gap: '8px', margin: '12px 0' } },
      h('button', { class: 'btn btn-sm', onclick: () => navigator.clipboard?.writeText(text).then(() => toast('Copied')) }, 'Copy'),
      h('button', { class: 'btn btn-sm', onclick: () => {
        const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: 'recovery-codes.txt' });
        a.click();
      } }, icon('download', 13), 'Download')),
    h('label', { class: 'check-row' }, saved, 'I have saved my recovery codes'),
    h('div', { style: { marginTop: '12px' } }, done));
}

// Full-page screen when an admin requires MFA for the user's role.
export function renderForcedMfa(root, { onDone, onLogout }) {
  const box = h('div');
  root.append(h('div', { class: 'login single' },
    h('div', { class: 'login-card wide' },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' } }, logo(30), h('h2', {}, 'Set up two-factor sign-in')),
      h('div', { class: 'sub' }, 'Your administrator requires a second step when you sign in. It takes about a minute.'),
      box,
      h('div', { class: 'login-foot' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); onLogout(); } }, 'Sign out')))));
  mfaSetupFlow(box, { onDone });
}
