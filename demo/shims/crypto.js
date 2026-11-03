import { Buffer } from 'buffer';
export function randomBytes(n) {
  const a = new Uint8Array(n); globalThis.crypto.getRandomValues(a);
  const b = Buffer.from(a), str = b.toString.bind(b);
  // the browser Buffer polyfill has no 'base64url'
  b.toString = (enc, ...r) => (enc === 'base64url' ? str('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : str(enc, ...r));
  return b;
}
// Demo-only password hash (the real server uses scrypt). Deterministic, NOT for production use.
export function scryptSync(pw, salt, len) {
  const s = String(pw) + '|' + Buffer.from(salt).toString('hex'); const out = new Uint8Array(len); let x = 2166136261;
  for (let r = 0; r < len; r++) { for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i) + r; x = Math.imul(x, 16777619) >>> 0; } out[r] = x & 255; }
  return Buffer.from(out);
}
export function timingSafeEqual(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; }
