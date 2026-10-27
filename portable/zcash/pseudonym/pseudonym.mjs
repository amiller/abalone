// SPDX-License-Identifier: MIT
// Zcash transparent pseudonyms, each its own Free2Z account: pseudonym new|exit|login|whoami NAME, pseudonym list
// Pseudonym n's key is m/44'/133'/(1000+n)'/0/0 of the wallet seed, so the seed is the backup. Zkool restoring account 1000+n
// stores this address (diversifier index 0) but displays the one at the account's default diversifier index. Each pseudonym talks to Free2Z through its own Nym client and recorded exit.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1.js';

export const ACCOUNT_BASE = 1000;
const N = secp256k1.Point.Fn.ORDER;
const DIR = '/run/portable-vault/pseudonyms';
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

// One HTTPS request through a SOCKS proxy. The token goes in curl's config on stdin, never argv.
export function curl(proxy, url, { body, token } = {}) {
  const q = s => JSON.stringify(s);
  const config = [`url = ${q(url)}`, ...(token ? [`header = ${q('Authorization: Token ' + token)}`] : []),
    ...(body ? [`header = "Content-Type: application/json"`, `data-binary = ${q(JSON.stringify(body))}`] : [])].join('\n');
  const r = spawnSync('/usr/bin/curl', ['-q', '--silent', '--show-error', '--proto', '=https', '--proxy', proxy, '--noproxy', '',
    '--connect-timeout', '60', '--max-time', '120', '--write-out', '\n%{http_code}', '--config', '-'], { input: config, maxBuffer: 64 << 20 });
  if (r.status !== 0) throw Error(`${url}: ${r.stderr.toString().trim() || 'curl exit ' + r.status}`);
  const out = r.stdout.toString();
  const i = out.lastIndexOf('\n');
  return { status: Number(out.slice(i + 1)), text: out.slice(0, i) };
}
export function json(proxy, url, opts) {
  const { status, text } = curl(proxy, url, opts);
  if (status < 200 || status > 299) throw Error(`${url}: HTTP ${status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

// Free2Z refuses Tor exits, so each pseudonym reaches it through its own nym-socks5-client (own keys, gateway and exit),
// run as portable-nym for the length of one command. Its state lives in the vault next to the record.
const NYM = '/opt/nym/nym-socks5-client';
const TOR = 'socks5h://127.0.0.1:9050';
const nymHome = name => `${DIR}/${name}.nym`;
const nymProxy = r => `socks5h://127.0.0.1:${1100 + r.index}`;
const nymUser = () => { const [, , uid, gid] = execFileSync('getent', ['passwd', 'portable-nym']).toString().split(':'); return { uid: +uid, gid: +gid }; };
const seconds = t => ((performance.now() - t) / 1000).toFixed(1);

function nymInit(name, provider) {
  const home = nymHome(name), u = nymUser();
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { mode: 0o700 });
  fs.chownSync(home, u.uid, u.gid);
  execFileSync(NYM, ['init', '--id', name, '--provider', provider], { ...u, env: { HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] });
}

function nymRun(name, r) {
  const t = performance.now();
  const child = spawn(NYM, ['run', '--id', name, '--host', '127.0.0.1', '--port', String(1100 + r.index)], { ...nymUser(), env: { HOME: nymHome(name) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error(`nym client for ${name} not ready in 120 s: ${log.slice(-500)}`)); }, 120000);
    const on = d => {
      log += d;
      if (!log.includes('Client startup finished!')) return;
      clearTimeout(timer); child.stdout.off('data', on); child.stderr.off('data', on); child.stdout.resume(); child.stderr.resume();
      console.error(`${name}: Nym client up in ${seconds(t)} s`); resolve(child);
    };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('exit', code => { clearTimeout(timer); reject(Error(`nym client for ${name} exited with ${code}: ${log.slice(-500)}`)); });
  });
}

// A usable exit answers Free2Z with something other than its 403. Three random network requesters, each failure shown.
async function pickExit(name, r) {
  const nodes = json(TOR, 'https://validator.nymtech.net/api/v1/nym-nodes/described?size=1000').data;
  const all = nodes.map(n => n.description?.network_requester?.address).filter(Boolean).sort(() => Math.random() - 0.5);
  for (const provider of all.slice(0, 3)) {
    let child;
    try {
      nymInit(name, provider);
      child = await nymRun(name, r);
      const t = performance.now(), { status } = curl(nymProxy(r), 'https://free2z.cash/');
      if (status === 403 || status === 0) throw Error(`free2z.cash answered ${status}`);
      console.error(`${name}: exit ${provider.slice(0, 12)}... reaches Free2Z (${status} in ${seconds(t)} s)`);
      return { provider, child };
    } catch (e) {
      child?.kill();
      console.error(`${name}: exit ${provider.slice(0, 12)}... unusable: ${e.message}`);
    }
  }
  throw Error(`no usable Nym exit for ${name} in 3 tries; run pseudonym exit ${name} again`);
}

// Runs fn with the pseudonym's Nym client up (already started by pickExit, or started here), then stops the client.
async function viaNym(name, r, fn, child) {
  child ??= await nymRun(name, r);
  try { return await fn(nymProxy(r)); }
  catch (e) { throw Error(`${e.message}\n(if the recorded Nym exit is dead, pseudonym exit ${name} picks a new one)`); }
  finally { child.kill(); }
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
  if (!(op === 'list' && name === undefined || ['new', 'exit', 'login', 'whoami'].includes(op) && /^[a-z0-9][a-z0-9-]{0,31}$/.test(name ?? '')))
    throw Error('usage: pseudonym new|exit|login|whoami NAME (lowercase letters, digits, -) | pseudonym list');
  if (!fs.existsSync(path.dirname(DIR) + '/ui')) throw Error('the vault is locked: ~/unlock first');
  fs.mkdirSync(DIR, { recursive: true, mode: 0o711 });
  if (op === 'list') {
    for (const n of names()) { const r = read(n); console.log(`${n}\t#${r.index}\t${r.address}\t${r.username ?? '(not logged in)'}\t${r.exitIp ?? '(no exit yet)'}`); }
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
    const u = await viaNym(name, r, proxy => json(proxy, `${API}/auth/user/`, { token: r.token }));
    console.log(`${name}: Free2Z ${u.username}, ${u.tuzis} 2Z, token expires ${r.expiry}`);
    return;
  }
  let child;
  if (op === 'exit' || !r.provider) {
    ({ provider: r.provider, child } = await pickExit(name, r));
    write(name, r);
  }
  const sk = pseudonymKey(await seed(), r.index);
  if (tAddress(sk) !== r.address) throw Error(`seed gives ${tAddress(sk)} for #${r.index}, not ${r.address}`);
  await viaNym(name, r, async proxy => {
    r.exitIp = json(proxy, 'https://check.torproject.org/api/ip').IP;
    write(name, r);
    if (op === 'exit') return console.log(`${name}: Nym exit ${r.exitIp} recorded`);
    const t = performance.now();
    const { challenge } = json(proxy, `${API}/auth/zcash/challenge/`, { body: { address: r.address } });
    const login = json(proxy, `${API}/auth/zcash/login/`, { body: { address: r.address, challenge, signature: signMessage(sk, challenge) } });
    write(name, { ...r, username: login.username, token: login.token, expiry: login.expiry ?? null, created: login.created });
    console.log(`${name}: Free2Z ${login.username}${login.created ? ' (new account)' : ''} in ${seconds(t)} s, token saved in the vault; Nym exit ${r.exitIp}`);
  }, child);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = JSON.parse(fs.readFileSync(new URL('../wallet/agent-wallet.json', import.meta.url), 'utf8')).source;
  main(process.argv.slice(2), () => walletSeed(source)).catch(e => { console.error(`pseudonym: ${e.message}`); process.exit(1); });
}
