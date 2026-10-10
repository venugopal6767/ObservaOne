// Single sign-on: generic OpenID Connect (Keycloak, Entra ID, Okta, ...), Google, GitHub.
import express from 'express';
import * as oidc from 'openid-client';
import { config } from './config.js';
import { q, one } from './db.js';
import { audit } from './store.js';
import { sha256, randomToken } from './secrets.js';
import { upsertExternalUser, finishPrimaryAuth, httpError, loadRoles } from './auth.js';
import { mapRole, hasRoleMap } from './rolemap.js';
import { ldapEnabled } from './ldap.js';

const BIND_COOKIE = 'oo_oauth';

const PROVIDERS = {
  oidc: { type: 'oidc', label: () => config.oidc.label, icon: 'key', enabled: () => !!(config.oidc.issuer && config.oidc.clientId) },
  google: { type: 'oidc', label: () => 'Google', icon: 'google', enabled: () => !!config.google.clientId },
  github: { type: 'github', label: () => 'GitHub', icon: 'github', enabled: () => !!config.github.clientId },
};

export function enabledProviders() {
  return Object.entries(PROVIDERS).filter(([, p]) => p.enabled()).map(([id, p]) => ({ id, label: p.label(), icon: p.icon }));
}

function publicBase(req) {
  if (config.publicUrl) return config.publicUrl;
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  return `${proto}://${req.headers.host}`;
}
const redirectUri = (req, id) => `${publicBase(req)}/api/auth/${id}/callback`;

// ---------- OIDC discovery (cached) ----------
const discovered = new Map();
async function oidcConfig(id) {
  if (discovered.has(id)) return discovered.get(id);
  const c = id === 'google'
    ? { issuer: 'https://accounts.google.com', clientId: config.google.clientId, clientSecret: config.google.clientSecret, allowHttp: false }
    : config.oidc;
  const opts = c.allowHttp ? { execute: [oidc.allowInsecureRequests] } : undefined;
  const cfg = await oidc.discovery(new URL(c.issuer), c.clientId, c.clientSecret, undefined, opts);
  discovered.set(id, cfg);
  return cfg;
}

function readBindCookie(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === BIND_COOKIE) return v.join('=');
  }
  return null;
}

function safeReturn(r) {
  return typeof r === 'string' && /^\/(?!\/)[\w\-./?=&%#]*$/.test(r) && !r.startsWith('/api/') ? r : '/overview';
}

export const ssoRouter = express.Router();

ssoRouter.get('/auth/providers', (req, res) => {
  res.json({ providers: enabledProviders(), ldap: ldapEnabled() });
});

ssoRouter.get('/auth/:provider/login', async (req, res) => {
  const id = req.params.provider;
  const p = PROVIDERS[id];
  if (!p || !p.enabled()) return res.redirect('/login?sso_error=' + encodeURIComponent('This sign-in method is not configured.'));
  try {
    const state = randomToken(24);
    const binding = randomToken(24);
    const verifier = oidc.randomPKCECodeVerifier();
    const nonce = oidc.randomNonce();
    await q(`INSERT INTO oauth_states (state, provider, code_verifier, nonce, binding, return_to, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, now() + interval '10 minutes')`,
    [sha256(state), id, verifier, nonce, sha256(binding), safeReturn(req.query.return)]);
    const secure = (req.headers['x-forwarded-proto'] || '') === 'https' || req.secure;
    res.setHeader('Set-Cookie', `${BIND_COOKIE}=${binding}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`);
    let url;
    if (p.type === 'oidc') {
      const cfg = await oidcConfig(id);
      url = oidc.buildAuthorizationUrl(cfg, {
        redirect_uri: redirectUri(req, id),
        scope: id === 'google' ? 'openid email profile' : config.oidc.scopes,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
        state,
        nonce,
        ...(id === 'google' && config.google.allowedDomains.length === 1 ? { hd: config.google.allowedDomains[0] } : {}),
      }).href;
    } else {
      const u = new URL(`${config.github.url}/login/oauth/authorize`);
      u.searchParams.set('client_id', config.github.clientId);
      u.searchParams.set('redirect_uri', redirectUri(req, id));
      u.searchParams.set('scope', 'read:user user:email read:org');
      u.searchParams.set('state', state);
      url = u.href;
    }
    res.redirect(url);
  } catch (e) {
    console.error(`[sso] ${id} login start failed:`, e.message);
    res.redirect('/login?sso_error=' + encodeURIComponent(`Cannot reach the ${p.label()} sign-in service.`));
  }
});

ssoRouter.get('/auth/:provider/callback', async (req, res) => {
  const id = req.params.provider;
  const p = PROVIDERS[id];
  const fail = (msg) => res.redirect('/login?sso_error=' + encodeURIComponent(msg));
  if (!p || !p.enabled()) return fail('This sign-in method is not configured.');
  if (req.query.error) return fail(`Sign-in was cancelled or refused (${String(req.query.error).slice(0, 60)}).`);
  const state = String(req.query.state || '');
  const binding = readBindCookie(req);
  const st = state && binding ? await one(
    `DELETE FROM oauth_states WHERE state = $1 AND provider = $2 AND binding = $3 AND expires_at > now() RETURNING *`,
    [sha256(state), id, sha256(binding)]) : null;
  res.append('Set-Cookie', `${BIND_COOKIE}=; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=0`);
  if (!st) return fail('The sign-in link expired or was opened in another browser. Try again.');
  try {
    await loadRoles();
    const profile = p.type === 'oidc' ? await oidcProfile(req, id, st, state) : await githubProfile(req, st);
    const user = await upsertExternalUser(id, profile);
    if (user.disabled) return fail('Your account is disabled.');
    await finishPrimaryAuth(req, res, user, { method: id, remember: false });
    res.redirect(st.return_to || '/overview');
  } catch (e) {
    console.error(`[sso] ${id} callback failed:`, e.message);
    audit(req, 'login.failed', { method: id, reason: e.message.slice(0, 200) });
    fail(e.status && e.status < 500 ? e.message : `${p.label()} sign-in failed. Ask an administrator to check the server log.`);
  }
});

async function oidcProfile(req, id, st, state) {
  const cfg = await oidcConfig(id);
  const current = new URL(redirectUri(req, id));
  for (const [k, v] of Object.entries(req.query)) current.searchParams.set(k, String(v));
  const tokens = await oidc.authorizationCodeGrant(cfg, current, {
    pkceCodeVerifier: st.code_verifier, expectedState: state, expectedNonce: st.nonce, idTokenExpected: true,
  });
  let claims = tokens.claims();
  if (id === 'oidc' && claims[config.oidc.groupsClaim] === undefined) {
    // some providers only put groups in the userinfo response
    try { claims = { ...claims, ...(await oidc.fetchUserInfo(cfg, tokens.access_token, claims.sub)) }; } catch { /* optional */ }
  }
  if (id === 'google') {
    if (!claims.email || claims.email_verified === false) throw httpError(403, 'Your Google e-mail address is not verified.');
    const domain = String(claims.hd || claims.email.split('@')[1] || '').toLowerCase();
    if (config.google.allowedDomains.length && !config.google.allowedDomains.map((d) => d.toLowerCase()).includes(domain)) {
      throw httpError(403, `Google accounts from ${domain} are not allowed.`);
    }
    const { role } = mapRole(config.google.roleMap, [claims.email], { defaultRole: config.google.defaultRole, match: 'email' });
    return { externalId: claims.sub, username: claims.email.split('@')[0], email: claims.email, displayName: claims.name, role, syncRole: hasRoleMap(config.google.roleMap) };
  }
  const raw = claims[config.oidc.groupsClaim];
  const groups = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const { role } = mapRole(config.oidc.roleMap, groups, { defaultRole: config.oidc.defaultRole });
  return {
    externalId: claims.sub,
    username: claims[config.oidc.usernameClaim] || claims.preferred_username || (claims.email || '').split('@')[0] || claims.sub,
    email: claims.email,
    displayName: claims.name,
    role,
    syncRole: hasRoleMap(config.oidc.roleMap),
  };
}

async function gh(path, token) {
  const r = await fetch(`${config.github.apiUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'observa-ui' },
  });
  if (!r.ok) throw new Error(`GitHub API ${path}: HTTP ${r.status}`);
  return r.json();
}

async function githubProfile(req, st) {
  const t = await fetch(`${config.github.url}/login/oauth/access_token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: config.github.clientId, client_secret: config.github.clientSecret, code: String(req.query.code || ''), redirect_uri: redirectUri(req, 'github') }),
  }).then((r) => r.json());
  if (!t.access_token) throw new Error(`GitHub token exchange failed: ${t.error || 'no token'}`);
  const user = await gh('/user', t.access_token);
  let email = user.email;
  if (!email) {
    const emails = await gh('/user/emails', t.access_token).catch(() => []);
    email = emails.find((e) => e.primary && e.verified)?.email || null;
  }
  const orgs = (await gh('/user/orgs', t.access_token).catch(() => [])).map((o) => o.login);
  const teams = (await gh('/user/teams', t.access_token).catch(() => [])).map((x) => `${x.organization?.login}/${x.slug}`);
  if (config.github.allowedOrgs.length) {
    const allowed = config.github.allowedOrgs.map((o) => o.toLowerCase());
    if (!orgs.some((o) => allowed.includes(o.toLowerCase()))) throw httpError(403, 'Your GitHub account is not a member of an allowed organisation.');
  }
  const { role } = mapRole(config.github.roleMap, [...teams, ...orgs], { defaultRole: config.github.defaultRole });
  return { externalId: user.id, username: user.login, email, displayName: user.name, role, syncRole: hasRoleMap(config.github.roleMap) };
}
