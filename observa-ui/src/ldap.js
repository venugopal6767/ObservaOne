// Sign-in against LDAP / Active Directory.
// 1) bind with the service account and find the user, 2) bind as the user to check the password,
// 3) map the user's groups to a role.
import fs from 'node:fs';
import { Client } from 'ldapts';
import { config } from './config.js';
import { upsertExternalUser, httpError } from './auth.js';
import { mapRole, hasRoleMap } from './rolemap.js';

export const ldapEnabled = () => !!(config.ldap.url && config.ldap.baseDn);

// RFC 4515: escape the characters that have a meaning in a search filter
export function escapeFilter(v) {
  return String(v).replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function tlsOptions() {
  const o = {};
  if (config.ldap.caFile) o.ca = [fs.readFileSync(config.ldap.caFile)];
  if (config.ldap.insecure) o.rejectUnauthorized = false;
  return o;
}

async function connect() {
  const isLdaps = config.ldap.url.startsWith('ldaps://');
  const c = new Client({
    url: config.ldap.url,
    timeout: 8000,
    connectTimeout: 5000,
    tlsOptions: isLdaps ? tlsOptions() : undefined,
    strictDN: false,
  });
  if (config.ldap.startTls && !isLdaps) await c.startTLS(tlsOptions());
  return c;
}

const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
const first = (v) => asList(v)[0];

// Returns the user row on success, null for wrong username/password.
export async function ldapPasswordAuth(username, password) {
  if (!ldapEnabled()) return null;
  // An empty password would be an "unauthenticated bind" that many servers accept - never allow it.
  if (!password || !username || username.length > 128) return null;
  const svc = await connect();
  let entry;
  try {
    if (config.ldap.bindDn) await svc.bind(config.ldap.bindDn, config.ldap.bindPassword);
    const filter = config.ldap.userFilter.replaceAll('{{username}}', escapeFilter(username));
    const { searchEntries } = await svc.search(config.ldap.baseDn, {
      scope: 'sub', filter, sizeLimit: 2,
      attributes: ['dn', 'mail', 'displayName', 'cn', 'uid', 'sAMAccountName', 'userPrincipalName', 'objectGUID', 'entryUUID', config.ldap.groupAttr],
    });
    if (searchEntries.length !== 1) return null;
    entry = searchEntries[0];
  } finally {
    await svc.unbind().catch(() => {});
  }
  // check the password by binding as the user
  const uc = await connect();
  try {
    await uc.bind(entry.dn, password);
  } catch (e) {
    if (/InvalidCredentials|49/.test(`${e.name} ${e.code} ${e.message}`)) return null;
    throw e;
  } finally {
    await uc.unbind().catch(() => {});
  }
  const groups = asList(entry[config.ldap.groupAttr]);
  const { role } = mapRole(config.ldap.roleMap, groups, { defaultRole: config.ldap.defaultRole, match: 'ldap' });
  const guid = entry.objectGUID ? Buffer.from(entry.objectGUID).toString('hex') : first(entry.entryUUID);
  const login = first(entry.sAMAccountName) || first(entry.uid) || username;
  if (!role) throw httpError(403, 'Your directory account is not in any group that has access. Ask an administrator.');
  return upsertExternalUser('ldap', {
    externalId: guid || entry.dn,
    username: login,
    email: first(entry.mail) || first(entry.userPrincipalName),
    displayName: first(entry.displayName) || first(entry.cn),
    role,
    syncRole: hasRoleMap(config.ldap.roleMap),
  });
}

// Used by the admin "Test LDAP" button: checks the service account and the search.
export async function ldapTest(username) {
  const c = await connect();
  try {
    if (config.ldap.bindDn) await c.bind(config.ldap.bindDn, config.ldap.bindPassword);
    if (!username) return { ok: true, message: 'Connected and service account bind worked.' };
    const filter = config.ldap.userFilter.replaceAll('{{username}}', escapeFilter(username));
    const { searchEntries } = await c.search(config.ldap.baseDn, { scope: 'sub', filter, sizeLimit: 2, attributes: ['dn', config.ldap.groupAttr] });
    if (!searchEntries.length) return { ok: false, message: `No user found with filter ${filter}` };
    const e = searchEntries[0];
    const groups = asList(e[config.ldap.groupAttr]);
    const { role, matched } = mapRole(config.ldap.roleMap, groups, { defaultRole: config.ldap.defaultRole, match: 'ldap' });
    return { ok: true, message: `Found ${e.dn}`, groups, role, matchedBy: matched || (role ? 'default role' : null) };
  } finally {
    await c.unbind().catch(() => {});
  }
}
