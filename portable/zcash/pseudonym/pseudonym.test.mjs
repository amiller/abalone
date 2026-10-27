// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { seedOf, derive, pseudonymKey, tAddress, signMessage } from './pseudonym.mjs';

const H = 2 ** 31;
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('BIP39 seed (reference vector, passphrase TREZOR)', () => {
  assert.equal(seedOf(ABANDON, 'TREZOR').toString('hex'),
    'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04');
});

test('BIP32 private derivation (test vector 1)', () => {
  const seed = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  assert.equal(derive(seed, [H]).toString('hex'), 'edb2e14f9ee77d26dd93b4ecede8d16ed408ce149b6cd80b0715a2d911a0afea');
  assert.equal(derive(seed, [H, 1]).toString('hex'), '3c6cb8d0f6a264c91ea8b5030fadaa8e538b020f0a387421a12de9319dc93368');
});

test('pseudonyms are distinct t1 addresses on account 1000+n', () => {
  const seed = seedOf(ABANDON);
  const a = [0, 1, 2].map(i => tAddress(pseudonymKey(seed, i)));
  assert.equal(new Set(a).size, 3);
  for (const x of a) assert.match(x, /^t1[1-9A-HJ-NP-Za-km-z]{33}$/);
  assert.deepEqual(pseudonymKey(seed, 1), derive(seed, [44 + H, 133 + H, 1001 + H, 0, 0]));
});

// Free2Z's verify.py, transcribed: recover the compressed key from the compact signature and compare P2PKH addresses.
function verify(address, signature, message) {
  const raw = Buffer.from(signature, 'base64'), magic = Buffer.from('Zcash Signed Message:\n'), body = Buffer.from(message);
  const sha = b => crypto.createHash('sha256').update(b).digest();
  const digest = sha(sha(Buffer.concat([Buffer.from([magic.length]), magic, Buffer.from([body.length]), body])));
  if (raw.length !== 65 || raw[0] < 31 || raw[0] > 32) return false;
  const pub = secp256k1.Signature.fromBytes(Buffer.concat([Buffer.from([raw[0] - 31]), raw.subarray(1)]), 'recovered').recoverPublicKey(digest).toBytes(true);
  const h160 = crypto.createHash('ripemd160').update(sha(pub)).digest();
  const p = Buffer.concat([Buffer.from([0x1c, 0xb8]), h160]);
  return address === tAddressFromHash(p);
}
const tAddressFromHash = p => {
  const b = Buffer.concat([p, crypto.createHash('sha256').update(crypto.createHash('sha256').update(p).digest()).digest().subarray(0, 4)]);
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + b.toString('hex')), s = '';
  for (; n > 0n; n /= 58n) s = A[Number(n % 58n)] + s;
  return s;
};

test('signMessage verifies the way Free2Z verifies, only for its own address and message', () => {
  const seed = seedOf(ABANDON);
  const k0 = pseudonymKey(seed, 0), k1 = pseudonymKey(seed, 1);
  const challenge = 'ZUULI-Login:v2:1761600000:abcdef0123456789:0123456789abcdef0123456789abcdef';
  for (let i = 0; i < 20; i++) {
    const m = challenge + i, sig = signMessage(k0, m);
    assert.ok(verify(tAddress(k0), sig, m));
    assert.ok(!verify(tAddress(k1), sig, m));
    assert.ok(!verify(tAddress(k0), sig, m + 'x'));
  }
  assert.throws(() => signMessage(k0, 'x'.repeat(253)), /too long/);
});
