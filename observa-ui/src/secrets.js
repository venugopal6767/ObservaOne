// App secret, encryption of stored secrets (MFA keys, channel tokens), random tokens.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

function loadAppSecret() {
  if (process.env.APP_SECRET && process.env.APP_SECRET.length >= 32) return process.env.APP_SECRET;
  if (process.env.APP_SECRET) console.warn('[secrets] APP_SECRET is shorter than 32 characters - using the generated one instead');
  // Generated once and kept in the data volume, so it survives restarts.
  const file = path.join(config.dataDir, 'app-secret');
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch { /* first start */ }
  fs.mkdirSync(config.dataDir, { recursive: true });
  const s = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(file, s, { mode: 0o600 });
  console.log(`[secrets] generated a new app secret in ${file}`);
  return s;
}

const KEY = crypto.createHash('sha256').update(`observa-enc|${loadAppSecret()}`).digest();

// AES-256-GCM. Output: "v1:" + base64(iv | tag | ciphertext)
export function encrypt(text) {
  if (text === null || text === undefined) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`;
}

export function decrypt(blob) {
  if (!blob) return null;
  if (!String(blob).startsWith('v1:')) throw new Error('Unknown secret format');
  const raw = Buffer.from(String(blob).slice(3), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

export const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// HMAC signature for webhooks we send (receivers can verify X-Observa-Signature)
export function sign(body) {
  return crypto.createHmac('sha256', KEY).update(body).digest('hex');
}
