// Passkey (WebAuthn) support without dependencies: biometric / device-PIN sign-in.
// The phone or laptop keeps the private key; we store only the public key and verify signatures.
import { createHash, createPublicKey, verify } from 'node:crypto';

export const b64uToBuf = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
export const bufToB64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const sha256 = (d) => createHash('sha256').update(d).digest();

/** Minimal CBOR decoder (ints, bytes, text, arrays, maps, simple values) — all WebAuthn needs. Returns [value, nextOffset]. */
export function cbor(buf, o = 0) {
  const ib = buf[o++], mt = ib >> 5, ai = ib & 31;
  const len = () => {
    if (ai < 24) return ai;
    if (ai === 24) return buf[o++];
    if (ai === 25) { const v = buf.readUInt16BE(o); o += 2; return v; }
    if (ai === 26) { const v = buf.readUInt32BE(o); o += 4; return v; }
    throw new Error('Unsupported CBOR length');
  };
  switch (mt) {
    case 0: return [len(), o];
    case 1: return [-1 - len(), o];
    case 2: { const n = len(); const v = buf.subarray(o, o + n); return [v, o + n]; }
    case 3: { const n = len(); return [buf.subarray(o, o + n).toString('utf8'), o + n]; }
    case 4: { const n = len(), a = []; for (let i = 0; i < n; i++) { const [v, p] = cbor(buf, o); a.push(v); o = p; } return [a, o]; }
    case 5: { const n = len(), m = new Map(); for (let i = 0; i < n; i++) { const [k, p1] = cbor(buf, o); const [v, p2] = cbor(buf, p1); m.set(k, v); o = p2; } return [m, o]; }
    case 7: return [ai === 20 ? false : ai === 21 ? true : null, o];
    default: throw new Error('Unsupported CBOR type');
  }
}

export function parseAuthData(ad) {
  if (ad.length < 37) throw new Error('Authenticator data too short');
  const out = { rpIdHash: ad.subarray(0, 32), flags: ad[32], signCount: ad.readUInt32BE(33) };
  out.up = !!(out.flags & 0x01); out.uv = !!(out.flags & 0x04);
  if (out.flags & 0x40) { // attested credential data
    const idLen = ad.readUInt16BE(53);
    out.credentialId = ad.subarray(55, 55 + idLen);
    out.publicKey = cbor(ad, 55 + idLen)[0]; // COSE_Key (extensions may follow; ignored)
  }
  return out;
}

export function coseToJwk(m) {
  const kty = m.get(1), alg = m.get(3);
  if (kty === 2 && m.get(-1) === 1) return { alg: -7, jwk: { kty: 'EC', crv: 'P-256', x: bufToB64u(m.get(-2)), y: bufToB64u(m.get(-3)) } };
  if (kty === 3) return { alg: alg ?? -257, jwk: { kty: 'RSA', n: bufToB64u(m.get(-1)), e: bufToB64u(m.get(-2)) } };
  throw new Error('This device uses an unsupported key type');
}

export function checkClientData(b64, type, challenge, origin) {
  let cd;
  try { cd = JSON.parse(b64uToBuf(b64).toString('utf8')); } catch { throw new Error('Unreadable response from the device'); }
  if (cd.type !== type) throw new Error('Wrong response type');
  if (cd.challenge !== challenge) throw new Error('This request expired — try again');
  if (cd.origin !== origin) throw new Error('This device was set up for a different web address');
  return cd;
}

export function checkAuthData(ad, rpId) {
  const p = parseAuthData(ad);
  if (!p.rpIdHash.equals(sha256(rpId))) throw new Error('This device was set up for a different web address');
  if (!p.up) throw new Error('Biometric check was not completed');
  if (!p.uv) throw new Error('Your device did not verify you (fingerprint, face or PIN)');
  return p;
}

export function verifyAssertion(jwk, authData, clientDataRaw, signature) {
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  return verify('sha256', Buffer.concat([authData, sha256(clientDataRaw)]), key, signature);
}
export const importKey = (jwk) => createPublicKey({ key: jwk, format: 'jwk' });
