// System settings stored in the database (small JSON values), cached for 15 seconds.
import { q, one } from './db.js';

const cache = new Map(); // key -> { at, value }

export const DEFAULTS = {
  security: { mfaRequiredRoles: [] },
};

export async function getSetting(key) {
  const c = cache.get(key);
  if (c && Date.now() - c.at < 15_000) return c.value;
  const r = await one('SELECT value FROM settings WHERE key = $1', [key]);
  const value = r ? { ...(DEFAULTS[key] || {}), ...r.value } : structuredClone(DEFAULTS[key] ?? null);
  cache.set(key, { at: Date.now(), value });
  return value;
}

export async function setSetting(key, value, by) {
  await q(`INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
  [key, JSON.stringify(value), by || null]);
  cache.delete(key);
}
