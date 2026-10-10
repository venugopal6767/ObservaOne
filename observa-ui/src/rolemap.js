// Turns groups/orgs/emails from LDAP or SSO into a role, using a JSON map from the settings.
// The first key in the map that matches wins, so put the strongest roles first.

export function mapRole(roleMap, values, { defaultRole = '', match = 'exact' } = {}) {
  const have = (values || []).map((v) => String(v).toLowerCase());
  for (const [key, role] of Object.entries(roleMap || {})) {
    const k = key.toLowerCase();
    const hit = have.some((v) => {
      if (match === 'ldap') {
        // full DN, or just the CN part ("Monitoring-Admins")
        return v === k || v.startsWith(`cn=${k},`);
      }
      if (match === 'email') return k.startsWith('@') ? v.endsWith(k) : v === k;
      return v === k;
    });
    if (hit) return { role, matched: key };
  }
  return { role: defaultRole || null, matched: null };
}

export function hasRoleMap(roleMap) {
  return roleMap && Object.keys(roleMap).length > 0;
}
