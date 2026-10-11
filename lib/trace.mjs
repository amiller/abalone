// The strict-incognito trace store, abalone-trace/2 (docs/protocols/trace-store.md). The launcher, outside the
// sandbox, is the only writer: it holds the stream key for one session and never reads a trace back. Frames are
// libsodium secretstream (XChaCha20-Poly1305); the stream key is wrapped to an age X25519 recipient. The age identity
// is kept passphrase-encrypted (age scrypt) and unlocked only by `trace open`, `--with-trace` and `trace key export`.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as age from "age-encryption";
import _sodium from "libsodium-wrappers";
import { STATE } from "./config.mjs";

await _sodium.ready;
const S = _sodium;
const V = "abalone-trace/2";
export const KEYS = path.join(STATE, "keys");
const HWM = path.join(STATE, "trace-hwm");
const ACTIVE = path.join(KEYS, "trace-active");
const pubFile = (kid) => path.join(KEYS, `trace-${kid}.pub`);
const idFile = (kid) => path.join(KEYS, `trace-${kid}.age`);
const hwmFile = (id) => path.join(HWM, `${id}.json`);
export const dir = (folder) => path.join(folder, ".abalone", "traces");
const sha = (s) => crypto.createHash("sha256").update(s).digest();
const kidOf = (recipient) => sha(recipient).toString("hex").slice(0, 16);

export function keyInfo() {
  if (!fs.existsSync(ACTIVE)) return null;
  const kid = fs.readFileSync(ACTIVE, "utf8").trim();
  return { kid, recipient: fs.readFileSync(pubFile(kid), "utf8").trim(), file: idFile(kid) };
}

// Store an age identity encrypted under a passphrase; its recipient (public) goes beside it for writers.
async function store(identity, passphrase) {
  if (!passphrase) throw new Error("an empty passphrase would leave the trace key unprotected");
  const recipient = await age.identityToRecipient(identity), kid = kidOf(recipient);
  const e = new age.Encrypter();
  e.setPassphrase(passphrase);
  fs.mkdirSync(KEYS, { recursive: true, mode: 0o700 });
  fs.writeFileSync(idFile(kid), await e.encrypt(identity), { mode: 0o600, flag: "wx" });
  fs.writeFileSync(pubFile(kid), recipient + "\n", { mode: 0o600 });
  if (!fs.existsSync(ACTIVE)) fs.writeFileSync(ACTIVE, kid + "\n", { mode: 0o600 });
  return { kid, recipient, file: idFile(kid) };
}

export const createKey = async (passphrase) => { if (keyInfo()) throw new Error(`a trace key already exists: ${keyInfo().file}`); return store(await age.generateX25519Identity(), passphrase); };
export const importKey = (identity, passphrase) => store(identity.trim(), passphrase);

async function identity(kid, passphrase) {
  if (!fs.existsSync(idFile(kid))) {
    const have = fs.existsSync(KEYS) ? fs.readdirSync(KEYS).filter((f) => f.endsWith(".age")).map((f) => f.slice(6, -4)) : [];
    throw new Error(`this trace is encrypted to trace key ${kid}; this computer has ${have.length ? have.join(", ") : "no trace key"} in ${KEYS}. Import the right one with: abalone trace key import`);
  }
  const d = new age.Decrypter();
  d.addPassphrase(passphrase);
  try { return await d.decrypt(fs.readFileSync(idFile(kid)), "text"); }
  catch { throw new Error(`wrong passphrase for trace key ${kid}`); }
}
export const exportKey = async (passphrase) => { const k = keyInfo(); if (!k) throw new Error(`no trace key in ${KEYS}`); return identity(k.kid, passphrase); };

// One writer per session, created by the launcher with a fresh stream key; it never reopens an existing trace.
export async function writer(folder, recipient, id) {
  const kid = kidOf(recipient), K = S.crypto_secretstream_xchacha20poly1305_keygen();
  const e = new age.Encrypter();
  e.addRecipient(recipient);
  const { state, header: ss } = S.crypto_secretstream_xchacha20poly1305_init_push(K);
  const header = JSON.stringify({ v: V, id, kid, key: Buffer.from(await e.encrypt(K)).toString("base64"), ss: Buffer.from(ss).toString("base64") });
  K.fill(0);
  const ad = sha(header);
  fs.mkdirSync(dir(folder), { recursive: true, mode: 0o700 });
  fs.mkdirSync(HWM, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const file = path.join(dir(folder), `${stamp}-${id}.trace`);
  fs.writeFileSync(file, header + "\n", { mode: 0o600, flag: "wx" });
  let frames = 0, closed = false;
  const put = (obj, tag) => {
    if (closed) throw new Error(`trace ${file} is already closed`);
    const line = Buffer.from(S.crypto_secretstream_xchacha20poly1305_push(state, JSON.stringify(obj), ad, tag)).toString("base64");
    fs.appendFileSync(file, line + "\n");
    frames++;
    closed = tag === S.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
    // The high-water mark, outside the folder: open() refuses a trace shorter than this or with a different last frame.
    fs.writeFileSync(hwmFile(id), JSON.stringify({ id, file, frames, last: sha(line).toString("hex"), closed }), { mode: 0o600 });
  };
  return { file, id, append: (obj) => put(obj, S.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE),
    close: (obj) => put(obj, S.crypto_secretstream_xchacha20poly1305_TAG_FINAL), frames: () => frames };
}

const lines = (file) => { const ls = fs.readFileSync(file, "utf8").split("\n"); return { ls: ls.slice(0, -1), partial: ls.at(-1) !== "" }; };
const hwm = (id) => fs.existsSync(hwmFile(id)) ? JSON.parse(fs.readFileSync(hwmFile(id), "utf8")) : null;
const idOf = (file) => path.basename(file).replace(/\.trace$/, "").split("-").slice(1).join("-");

// What can be said without the key: sizes, frame counts and this computer's high-water mark.
export function list(folder) {
  if (!fs.existsSync(dir(folder))) return [];
  return fs.readdirSync(dir(folder)).filter((f) => f.endsWith(".trace")).sort().map((f) => {
    const file = path.join(dir(folder), f), { ls, partial } = lines(file), h = JSON.parse(ls[0]);
    return { id: idOf(file), file, bytes: fs.statSync(file).size, frames: ls.length - 1, partial, kid: h.kid, hwm: hwm(h.id) };
  });
}

export const find = (folder, id) => {
  const ts = list(folder).filter((t) => t.id === id || t.id.startsWith(id));
  if (ts.length !== 1) throw new Error(`${ts.length ? "more than one" : "no"} trace ${id} in ${dir(folder)} (abalone trace list ${folder})`);
  return ts[0];
};

// Decrypt a whole trace. Throws on a wrong key or passphrase, a header that does not match the file name, any frame
// that fails authentication, a frame after the final one, or a trace shorter than (or diverging from) its high-water mark.
export async function open(file, passphrase) {
  const { ls, partial } = lines(file), header = ls[0], h = JSON.parse(header);
  if (h.v !== V) throw new Error(`${file}: not an ${V} trace (header v=${h.v})`);
  if (h.id !== idOf(file)) throw new Error(`${file}: the header names trace ${h.id}, the file name ${idOf(file)}`);
  const d = new age.Decrypter();
  d.addIdentity(await identity(h.kid, passphrase));
  let K;
  try { K = await d.decrypt(Buffer.from(h.key, "base64")); }
  catch { throw new Error(`${file}: trace key ${h.kid} does not unwrap this trace (altered header)`); }
  const state = S.crypto_secretstream_xchacha20poly1305_init_pull(Buffer.from(h.ss, "base64"), K), ad = sha(header);
  K.fill(0);
  const records = [];
  let closed = false;
  for (let i = 1; i < ls.length; i++) {
    if (closed) throw new Error(`${file}: frame ${i - 1} follows the final frame`);
    const r = S.crypto_secretstream_xchacha20poly1305_pull(state, Buffer.from(ls[i], "base64"), ad);
    if (!r) throw new Error(`${file}: frame ${i - 1} failed authentication (corrupted, altered or out of order); frames 0..${i - 2} verified, nothing printed`);
    records.push(JSON.parse(S.to_string(r.message)));
    closed = r.tag === S.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
  }
  const m = hwm(h.id), frames = ls.length - 1;
  if (m && frames < m.frames) throw new Error(`${file}: truncated or rolled back: it has ${frames} frames, and this computer recorded ${m.frames}`);
  if (m && frames === m.frames && sha(ls.at(-1)).toString("hex") !== m.last) throw new Error(`${file}: its last frame differs from the one this computer recorded (replaced)`);
  return { header: h, records, closed, frames, partial,
    hwm: m ? `matches this computer's high-water mark (${m.frames} frames${m.closed ? ", closed" : ""})` : "no high-water mark on this computer: a cut at a frame boundary would not be detected" };
}

const text = (c) => typeof c === "string" ? c : c.filter((p) => p.type === "text").map((p) => p.text).join("\n");
export function transcript(records) {
  return records.flatMap((r) => {
    if (r.t === "start") return [`[${r.mode} session in ${r.folder}, started ${r.at}]`];
    if (r.t === "close") return [`[closed ${r.at}: ${r.entries} entries; ${r.reason}]`];
    const e = r.e;
    if (e.type === "message") {
      const m = e.message;
      if (m.role === "toolResult") return [`tool result (${m.toolName}): ${text(m.content)}`];
      const calls = m.role === "assistant" ? m.content.filter((c) => c.type === "toolCall").map((c) => `\n  → ${c.name} ${JSON.stringify(c.arguments)}`).join("") : "";
      return [`${m.role}${m.role === "assistant" ? ` (${m.provider}/${m.model})` : ""}: ${text(m.content)}${calls}`];
    }
    if (e.type === "custom_message") return [`${e.customType}: ${text(e.content)}`];
    return [];
  }).join("\n\n");
}

// Leave no trace: delete trace files and their high-water marks. Scope in the contract.
export function remove(folder, id) {
  const ts = id === "--all" ? list(folder) : [find(folder, id)];
  for (const t of ts) { fs.rmSync(t.file); fs.rmSync(hwmFile(t.id), { force: true }); }
  return ts.map((t) => t.file);
}
