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

// ---- extra functions imported by the real server code (passkeys are not available in the browser preview) ----
const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
function sha256(bytes) {
  const l = bytes.length, n = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(n); m.set(bytes); m[l] = 0x80;
  const dv = new DataView(m.buffer); dv.setUint32(n - 4, (l * 8) >>> 0); dv.setUint32(n - 8, Math.floor((l * 8) / 4294967296));
  const h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]), w = new Uint32Array(64);
  const rr = (x, k) => (x >>> k) | (x << (32 - k));
  for (let o = 0; o < n; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) { const a = rr(w[i-15], 7) ^ rr(w[i-15], 18) ^ (w[i-15] >>> 3), b = rr(w[i-2], 17) ^ rr(w[i-2], 19) ^ (w[i-2] >>> 10); w[i] = (w[i-16] + a + w[i-7] + b) >>> 0; }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) { const t1 = (hh + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0, t2 = ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0; hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0; }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32), o2 = new DataView(out.buffer); h.forEach((v, i) => o2.setUint32(i * 4, v)); return out;
}
export function createHash() {
  const parts = [];
  return { update(d) { parts.push(typeof d === 'string' ? new TextEncoder().encode(d) : Uint8Array.from(d)); return this; },
    digest(enc) { const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; parts.forEach((p) => { all.set(p, o); o += p.length; }); const h = Buffer.from(sha256(all)); return enc ? h.toString(enc) : h; } };
}
export const createPublicKey = () => { throw new Error('Not available in the browser preview'); };
export const verify = () => { throw new Error('Not available in the browser preview'); };
