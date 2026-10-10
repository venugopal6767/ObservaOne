// Time-based one-time passwords (RFC 6238, the codes from Google/Microsoft Authenticator).
import crypto from 'node:crypto';
import { safeEqual } from './secrets.js';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newSecret() {
  return base32Encode(crypto.randomBytes(20));
}

export function hotp(secretB32, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const n = (h.readUInt32BE(off) & 0x7fffffff) % 10 ** digits;
  return String(n).padStart(digits, '0');
}

// Returns the matching time step (to block reuse), or null. Accepts +-1 step for clock drift.
export function verifyTotp(secretB32, code, { lastStep = null, now = Date.now(), window = 1 } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const step = Math.floor(now / 1000 / STEP);
  for (let w = -window; w <= window; w++) {
    const s = step + w;
    if (lastStep !== null && lastStep !== undefined && s <= Number(lastStep)) continue;
    if (safeEqual(hotp(secretB32, s), c)) return s;
  }
  return null;
}

export function otpauthUri({ secret, account, issuer }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;
}

export function recoveryCodes(n = 10) {
  return Array.from({ length: n }, () => {
    const r = crypto.randomBytes(5).toString('hex'); // 10 hex chars
    return `${r.slice(0, 5)}-${r.slice(5)}`;
  });
}
