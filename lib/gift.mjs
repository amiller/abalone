// Gift codes, device and issuer keys, and the signed requests a coupon holder or the issuer sends to a node.
// Code: "g1" + Crockford base32(secret16 ‖ sha256(secret)[0:3]). The node knows a code only as its account,
// keccak256("abalone-code/1" ‖ secret). Device and issuer keys are Ed25519, generated where they are used.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { STATE } from "./config.mjs";
import { keccak256 } from "./keccak.mjs";

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const b32 = (buf) => { let bits = "", s = ""; for (const b of buf) bits += b.toString(2).padStart(8, "0"); for (let i = 0; i < bits.length; i += 5) s += B32[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)]; return s; };
const unb32 = (s) => { let bits = ""; for (const c of s) { const i = B32.indexOf(c); if (i < 0) return null; bits += i.toString(2).padStart(5, "0"); } return Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2))); };
const check = (secret) => crypto.createHash("sha256").update(secret).digest().subarray(0, 3);

export const newCode = () => { const s = crypto.randomBytes(16); return "g1" + b32(Buffer.concat([s, check(s)])); };
export function parseCode(code) {
  const raw = /^g1[0-9A-Z]{31}$/.test(code ?? "") && unb32(code.slice(2));
  if (!raw || b32(raw) !== code.slice(2) || !check(raw.subarray(0, 16)).equals(raw.subarray(16, 19))) throw new Error("This code looks incomplete. Chat apps sometimes cut long links. Open the link again and copy the whole command.");
  return raw.subarray(0, 16);
}
export const account = (code) => keccak256(Buffer.concat([Buffer.from("abalone-code/1"), parseCode(code)])).toString("hex");

// A gift travels as "<code>.<signed grant>": the issuer's signed Grant {account, amount, expiry, from, terms} rides
// with the code (in a link, in its fragment), so no peer needs to hear from the issuer, and the recipient reads the
// terms from what the issuer signed.
export function makeGift(code, g) {
  const msg = JSON.stringify({ type: "grant", account: account(code), ...g, nonce: crypto.randomBytes(16).toString("hex") });
  return `${code}.${Buffer.from(JSON.stringify({ msg, sig: sign(issuerKey(), msg) })).toString("base64url")}`;
}
export function parseGift(token) {
  const [code, g] = (token ?? "").split(".");
  parseCode(code);
  let grant;
  try { grant = JSON.parse(Buffer.from(g ?? "", "base64url").toString()); } catch { grant = null; }
  const m = grant && JSON.parse(grant.msg);
  if (m?.type !== "grant" || m.account !== account(code)) throw new Error("This gift command looks incomplete. Chat apps sometimes cut long links. Open the link again and copy the whole command.");
  return { code, grant, m };
}

export const usd = (s) => { const m = /^\$?(\d+(?:\.\d{1,2})?)\s*(usd)?$/i.exec(s ?? ""); if (!m) throw new Error(`not an amount: ${s} (expected e.g. 5usd)`); return Math.round(Number(m[1]) * 1e6); };
export const fmt = (micro) => `$${(micro / 1e6).toFixed(micro && Math.abs(micro) < 10000 ? 4 : 2)}`;

export const sha = (b) => crypto.createHash("sha256").update(b ?? "").digest("hex");
export const pubHex = (key) => crypto.createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
export const pubKey = (hex) => crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(hex, "hex")]), format: "der", type: "spki" });
export const sign = (key, msg) => crypto.sign(null, Buffer.from(msg), key).toString("hex");
export const verify = (hex, msg, sig) => crypto.verify(null, Buffer.from(msg), pubKey(hex), Buffer.from(sig, "hex"));

function keyFile(file) {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, crypto.generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
  }
  return crypto.createPrivateKey(fs.readFileSync(file));
}
export const ISSUER_KEY = process.env.ABALONE_ISSUER_KEY || path.join(STATE, "issuer.key");
export const issuerKey = () => keyFile(ISSUER_KEY);

// What a device signs for each node request. The idempotency key makes a captured request worthless:
// the node answers a repeat with the stored (still encrypted) response and never debits twice.
export const requestMsg = (method, url, ts, idem, bodyHash) => [method, url, ts, idem, bodyHash].join("\n");

// The recipient side: ~/.abalone/coupon.json (0600) holds the peer's multiaddr, the account and the device key.
export const COUPON = path.join(STATE, "coupon.json");
export const coupon = () => fs.existsSync(COUPON) ? JSON.parse(fs.readFileSync(COUPON, "utf8")) : null;

export function deviceHeaders(c, method, url, idem, body) {
  const ts = String(Date.now());
  return { "x-abalone-account": c.account, "x-abalone-ts": ts, "x-abalone-idem": idem, "x-abalone-sig": sign(crypto.createPrivateKey(c.device_key), requestMsg(method, url, ts, idem, sha(body))) };
}

// base: the loopback endpoint of an attested libp2p client for `peer` (lib/p2p.mjs giftClient).
export async function redeem(node, peer, token) {
  const { code, grant, m } = parseGift(token);
  const acct = m.account;
  const existing = coupon();
  if (existing && existing.account !== acct) throw new Error(`This computer already holds a different gift (${COUPON}). Remove that file first if you mean to replace it.`);
  const device = existing ? crypto.createPrivateKey(existing.device_key) : crypto.generateKeyPairSync("ed25519").privateKey;
  const unreachable = (e) => { throw new Error(`Couldn't reach the server that handles gifts. Nothing was sent, and your code still works. Try the same command again in a few minutes.\ndetails: ${node}: ${e.cause?.code ?? e.message}`); };
  const r = await fetch(`${node}/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, grant, device: pubHex(device) }) })
    .catch(unreachable);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error.message);
  const c = { peer, account: acct, device: pubHex(device), device_key: device.export({ format: "pem", type: "pkcs8" }), amount: j.amount, expiry: j.expiry, from: j.from, model: j.model };
  fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
  fs.writeFileSync(COUPON, JSON.stringify(c, null, 1), { mode: 0o600 });
  return { ...j, terms: m.terms, coupon: c };
}

// The issuer's own funding book, <STATE>/gifts.json (0600): what it has declared as prepaid at the peer (--setup) and
// the gifts it signed. A gift past the declared amount is refused here; the peer refuses claims past its reserve.
const BOOK = path.join(STATE, "gifts.json");
export const book = () => fs.existsSync(BOOK) ? JSON.parse(fs.readFileSync(BOOK, "utf8")) : { funded: 0, gifts: [] };
export const committed = (b) => b.gifts.reduce((s, g) => s + g.amount, 0); // the issuer cannot see spending, so a gift stays committed
export function saveBook(b) { fs.mkdirSync(STATE, { recursive: true, mode: 0o700 }); fs.writeFileSync(BOOK, JSON.stringify(b, null, 1), { mode: 0o600 }); }

// Signed status request to a peer (the issuer reading its peer's ledger).
export async function issue(node, m) {
  const msg = JSON.stringify({ ...m, ts: Date.now(), nonce: crypto.randomBytes(16).toString("hex") });
  const r = await fetch(`${node}/admin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ msg, sig: sign(issuerKey(), msg) }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error.message);
  return j;
}
