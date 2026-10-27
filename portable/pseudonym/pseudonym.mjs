// SPDX-License-Identifier: MIT
// Zcash transparent pseudonyms, each its own Free2Z account: pseudonym new|list|login|whoami NAME
// Pseudonym n's key is m/44'/133'/(1000+n)'/0/0 of the wallet seed (the t-address a ZIP-32 wallet shows for account 1000+n),
// so the seed is the backup. Each pseudonym talks to Free2Z over Tor with its own SOCKS credentials, so Tor gives it its own circuits.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1.js';

export const ACCOUNT_BASE = 1000;
const N = secp256k1.Point.Fn.ORDER;
const DIR = '/run/portable-vault/ui/pseudonyms';
const API = 'https://free2z.cash/api';
const sha256 = b => crypto.createHash('sha256').update(b).digest();
const big = b => BigInt('0x' + b.toString('hex'));
const bytes32 = n => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const hmac = (key, data) => crypto.createHmac('sha512', key).update(data).digest();

export function seedOf(mnemonic, passphrase = '') {
  return crypto.pbkdf2Sync(mnemonic.normalize('NFKD'), ('mnemonic' + passphrase).normalize('NFKD'), 2048, 64, 'sha512');
}

// BIP32 private derivation; path entries >= 2**31 are hardened.
export function derive(seed, path) {
  let I = hmac('Bitcoin seed', seed), k = big(I.subarray(0, 32)), c = I.subarray(32);
  for (const i of path) {
    const data = i >= 2 ** 31 ? Buffer.concat([Buffer.alloc(1), bytes32(k)]) : Buffer.from(secp256k1.getPublicKey(bytes32(k), true));
    I = hmac(c, Buffer.concat([data, u32(i)]));
    k = (big(I.subarray(0, 32)) + k) % N;
    c = I.subarray(32);
  }
  return bytes32(k);
}

export const pseudonymKey = (seed, index) => derive(seed, [44 + 2 ** 31, 133 + 2 ** 31, ACCOUNT_BASE + index + 2 ** 31, 0, 0]);

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58check(payload) {
  const b = Buffer.concat([payload, sha256(sha256(payload)).subarray(0, 4)]);
  let n = big(b), s = '';
  for (; n > 0n; n /= 58n) s = B58[Number(n % 58n)] + s;
  for (const x of b) { if (x) break; s = '1' + s; }
  return s;
}

export const tAddress = sk => base58check(Buffer.concat([Buffer.from([0x1c, 0xb8]),
  crypto.createHash('ripemd160').update(sha256(secp256k1.getPublicKey(sk, true))).digest()]));

// zcashd signmessage: double SHA-256 over CompactSize-framed "Zcash Signed Message:\n" and the message;
// base64 of header (31 + recovery id, compressed key) || r || s. Messages here are under 253 bytes.
export function signMessage(sk, message) {
  const magic = Buffer.from('Zcash Signed Message:\n'), body = Buffer.from(message);
  if (body.length > 252) throw Error(`message too long to sign: ${body.length} bytes`);
  const digest = sha256(sha256(Buffer.concat([Buffer.from([magic.length]), magic, Buffer.from([body.length]), body])));
  const sig = Buffer.from(secp256k1.sign(digest, sk, { prehash: false, format: 'recovered' }));
  return Buffer.concat([Buffer.from([31 + sig[0]]), sig.subarray(1)]).toString('base64');
}

// One HTTPS request through Tor; the SOCKS username is the pseudonym's name. The token goes in curl's config on stdin, never argv.
export function tor(name, url, { body, token } = {}) {
  const q = s => JSON.stringify(s);
  const config = [`url = ${q(url)}`, ...(token ? [`header = ${q('Authorization: Token ' + token)}`] : []),
    ...(body ? [`header = "Content-Type: application/json"`, `data-binary = ${q(JSON.stringify(body))}`] : [])].join('\n');
  const out = execFileSync('/usr/bin/curl', ['-q', '--silent', '--show-error', '--proto', '=https', '--proxy', `socks5h://pseudonym-${name}:x@127.0.0.1:9050`,
    '--noproxy', '', '--connect-timeout', '30', '--max-time', '90', '--write-out', '\n%{http_code}', '--config', '-'], { input: config }).toString();
  const i = out.lastIndexOf('\n'), status = Number(out.slice(i + 1)), text = out.slice(0, i);
  if (status < 200 || status > 299) throw Error(`${url}: HTTP ${status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

export async function walletSeed(source) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(source.db, { readOnly: true });
  const rows = db.prepare('SELECT seed, passphrase FROM accounts WHERE name = ?').all(source.account);
  db.close();
  if (rows.length !== 1 || !rows[0].seed) throw Error(`${source.db} must hold one account named ${source.account} with a seed; found ${rows.length}`);
  return seedOf(rows[0].seed, rows[0].passphrase ?? '');
}

const file = name => `${DIR}/${name}.json`;
const read = name => JSON.parse(fs.readFileSync(file(name), 'utf8'));
const write = (name, record) => fs.writeFileSync(file(name), JSON.stringify(record, null, 1) + '\n', { mode: 0o600 });
const names = () => fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();

export async function main([op, name], seed) {
  if (!(op === 'list' && name === undefined || ['new', 'login', 'whoami'].includes(op) && /^[a-z0-9][a-z0-9-]{0,31}$/.test(name ?? '')))
    throw Error('usage: pseudonym new|login|whoami NAME (lowercase letters, digits, -) | pseudonym list');
  if (!fs.existsSync(path.dirname(DIR))) throw Error('the vault is locked: ~/unlock first');
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  if (op === 'list') {
    for (const n of names()) { const r = read(n); console.log(`${n}\t#${r.index}\t${r.address}\t${r.username ?? '(not logged in)'}`); }
    return;
  }
  if (op === 'new') {
    if (fs.existsSync(file(name))) throw Error(`pseudonym ${name} already exists`);
    const index = Math.max(-1, ...names().map(n => read(n).index)) + 1;
    const address = tAddress(pseudonymKey(await seed(), index));
    write(name, { index, address });
    console.log(`${name}: ${address} (wallet account ${ACCOUNT_BASE + index})`);
    return;
  }
  const r = read(name);
  if (op === 'whoami') {
    if (!r.token) throw Error(`${name} is not logged in: pseudonym login ${name}`);
    const u = tor(name, `${API}/auth/user/`, { token: r.token });
    console.log(`${name}: Free2Z ${u.username}, ${u.tuzis} 2Z, token expires ${r.expiry}`);
    return;
  }
  const sk = pseudonymKey(await seed(), r.index);
  if (tAddress(sk) !== r.address) throw Error(`seed gives ${tAddress(sk)} for #${r.index}, not ${r.address}`);
  const { challenge } = tor(name, `${API}/auth/zcash/challenge/`, { body: { address: r.address } });
  const login = tor(name, `${API}/auth/zcash/login/`, { body: { address: r.address, challenge, signature: signMessage(sk, challenge) } });
  write(name, { ...r, username: login.username, token: login.token, expiry: login.expiry ?? null, created: login.created });
  const exit = tor(name, 'https://check.torproject.org/api/ip');
  console.log(`${name}: Free2Z ${login.username}${login.created ? ' (new account)' : ''}, token saved in the vault; Tor exit ${exit.IP}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = JSON.parse(fs.readFileSync(new URL('../wallet/agent-wallet.json', import.meta.url), 'utf8')).source;
  main(process.argv.slice(2), () => walletSeed(source)).catch(e => { console.error(`pseudonym: ${e.message}`); process.exit(1); });
}
