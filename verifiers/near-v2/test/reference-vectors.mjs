// Maintenance-only: execute the pinned upstream helper to reproduce synthetic
// vectors. No network calls, credentials or full browser bundle execution.
import fs from 'node:fs';
import vm from 'node:vm';
import { randomBytes } from 'node:crypto';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { seal, open, hex, digest } from '../crypto.mjs';

const source = fs.readFileSync(process.argv[2]);
const sourceSha256 = 'b2b1d0220cb838b9bc82baed08b1e845429632aad63c70274cc99485b6b4c49f';
if (digest(source) !== sourceSha256) throw new Error('reference bundle hash mismatch');
const text = source.toString('utf8'), start = text.indexOf('var hr=Y.encode('), end = text.indexOf('var Se=', start);
if (start < 0 || end < start) throw new Error('reference helpers missing');
// Only the original Ue/Re/yr/_r definitions and constants are evaluated. Supply
// compatibility bindings for primitives imported by the minified browser chunk.
// Noble v2 accepts byte public keys; upstream's older conversion accepts hex.
const bindings = {
  TA: sha256, pj: x25519, ZA: ed25519, Wj: xchacha20poly1305, vA: randomBytes,
  Ce: (key) => ed25519.utils.toMontgomery(typeof key === 'string' ? Uint8Array.from(Buffer.from(key, 'hex')) : key),
  Ne: ed25519.utils.toMontgomerySecret,
  Te: (hash, input, salt, info, length) => hkdf(hash, input, salt, info, length),
  Y: { encode: (value) => new TextEncoder().encode(value), decode: (value) => new TextDecoder('utf8', { fatal: true }).decode(value) },
  rA: hex, Z: (value) => Uint8Array.from(Buffer.from(value, 'hex')), UA: (...parts) => Uint8Array.from(Buffer.concat(parts)),
};
const upstream = vm.runInNewContext(text.slice(start, end) + ';({Ue,yr,_r})', bindings, { timeout: 1000 });
const seed = Uint8Array.from({ length: 32 }, (_, i) => i), ephemeral = Uint8Array.from({ length: 32 }, (_, i) => i + 32), nonce = Uint8Array.from({ length: 24 }, (_, i) => i + 64), key = upstream.Ue(seed);
const vectors = ['synthetic café 🐚', '', JSON.stringify({ path: 'sample.md', replacement: 'ready' })].map((value) => {
  const envelope = upstream.yr(value, key.publicKey, { ephSecret: ephemeral, nonce });
  if (open(envelope, key.x25519Secret) !== value || upstream._r(seal(value, key.publicKey), key.x25519Secret) !== value) throw new Error('cross-implementation opening failed');
  return { text: value, envelope };
});
fs.writeFileSync(new URL('./fixtures/browser-v2.json', import.meta.url), JSON.stringify({ sourceUrl: 'https://privateinference.gg/chat/js/browser-xfq6xewy.js', sourceSha256, seed: hex(seed), ephemeral: hex(ephemeral), nonce: hex(nonce), publicKey: key.publicKey, vectors }, null, 2) + '\n');
console.log('Pinned upstream helper executed; both implementations opened the other\'s envelopes. Synthetic vectors reproduced.');
