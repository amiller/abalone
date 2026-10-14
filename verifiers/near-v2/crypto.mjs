import { randomBytes } from 'node:crypto';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export const utf8 = (text) => encoder.encode(text);
export const hex = (bytes) => Buffer.from(bytes).toString('hex');
export function unhex(text, length) {
  if (typeof text !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(text)) throw new Error('invalid hex');
  const bytes = Uint8Array.from(Buffer.from(text, 'hex'));
  if (length !== undefined && bytes.length !== length) throw new Error('invalid byte length');
  return bytes;
}
export const digest = (bytes) => hex(sha256(bytes));
const derive = (shared) => hkdf(sha256, shared, undefined, utf8('ed25519_encryption'), 32);
export function replyKey(seed) {
  const generated = seed === undefined; seed ??= randomBytes(32);
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('invalid reply seed');
  try { return { publicKey: hex(ed25519.getPublicKey(seed)), secret: ed25519.utils.toMontgomerySecret(seed) }; }
  finally { if (generated) seed.fill(0); }
}
export function seal(text, recipientKey) {
  if (typeof text !== 'string') throw new Error('text required');
  const ephemeral = randomBytes(32), nonce = randomBytes(24); let key;
  try {
    key = derive(x25519.getSharedSecret(ephemeral, ed25519.utils.toMontgomery(unhex(recipientKey, 32))));
    const encrypted = xchacha20poly1305(key, nonce).encrypt(utf8(text));
    return hex(Buffer.concat([x25519.getPublicKey(ephemeral), nonce, encrypted]));
  } finally { key?.fill(0); ephemeral.fill(0); }
}
export function open(envelope, secret) {
  // The upstream represents an absent/empty output chunk as an empty string.
  if (envelope === '') return '';
  const bytes = unhex(envelope);
  if (bytes.length < 72 || !(secret instanceof Uint8Array) || secret.length !== 32) throw new Error('invalid envelope');
  const key = derive(x25519.getSharedSecret(secret, bytes.subarray(0, 32)));
  try { return decoder.decode(xchacha20poly1305(key, bytes.subarray(32, 56)).decrypt(bytes.subarray(56))); }
  finally { key.fill(0); }
}
export function verifySignature(signature, message, signer) {
  return ed25519.verify(unhex(signature, 64), utf8(message), unhex(signer, 32), { zip215: false });
}
