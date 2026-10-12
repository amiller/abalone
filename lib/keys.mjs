// Configured provider keys: credit-store records of kind "key", one per provider and label
// (<STATE>/credit/<sha256 of "key", provider and label>.json, 0600).
// No local spending cap: the provider's own limit applies.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { STATE, providers } from "./config.mjs";
import { creditStore } from "./credit-store.mjs";

export const TERMS = "no local cap; the provider's limit applies";
const DIR = path.join(STATE, "credit");

// Newest first, so a provider's active key is its most recently added one.
export function list(dir = DIR) {
  if (!fs.existsSync(dir)) return [];
  const s = creditStore(dir);
  const read = (id) => { try { return s.read(id); } catch (e) { throw new Error(`credit record ${path.join(dir, `${id}.json`)} is unreadable or unsafe (${e.message}); configured keys cannot be listed until it is fixed or removed.`); } };
  return s.list().map(read).filter((r) => r.kind === "key").sort((a, b) => b.added.localeCompare(a.added));
}
export const active = (prov, dir = DIR) => list(dir).find((k) => k.provider === prov);

const admitted = (prov) => {
  const p = providers().admitted.find((a) => a.id === prov);
  if (!p) throw new Error(`unknown provider; expected one of ${providers().admitted.map((a) => a.id).join(", ")}`);
  return p;
};

// The record id names the provider and label, so the lock and create-only write keep one key per label.
export function save(prov, label, key) {
  if (!key) throw new Error("empty key");
  const s = creditStore(DIR), id = crypto.createHash("sha256").update(`key\0${prov}\0${label}`).digest("hex"), unlock = s.lock(id);
  try {
    if (s.exists(id)) throw new Error(`a ${prov} key labelled ${label} is already configured`);
    s.write({ version: 1, kind: "key", id, provider: prov, label, key, added: new Date().toISOString() }, { create: true });
  } finally { unlock(); }
}

// One cheap authenticated call: an empty chat completion is rejected for its body (4xx) with a valid
// key, and with 401/403 for an invalid one. It carries no prompt and costs nothing.
async function validate(p, key) {
  const r = await fetch(`${p.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: '{"model":"-","messages":[]}' });
  if (r.status === 401 || r.status === 403) throw new Error(`key rejected by ${p.id}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  if (r.status >= 500) throw new Error(`cannot validate key: ${p.id} answered HTTP ${r.status}`);
}

export async function add(prov, label, key) {
  const p = admitted(prov);
  key = key.trim();
  if (!key) throw new Error("empty key");
  if (list().some((k) => k.provider === prov && k.label === label)) throw new Error(`a ${prov} key labelled ${label} is already configured`);
  await validate(p, key);
  save(prov, label, key);
}

export function used(id) {
  const s = creditStore(DIR), unlock = s.lock(id);
  try { const r = s.read(id); r.lastUsed = new Date().toISOString(); s.write(r); } finally { unlock(); }
}

export function forget(prov, label) {
  const k = list().filter((k) => k.provider === prov && (label === undefined || k.label === label));
  if (!k.length) throw new Error("no such key is configured; abalone key list shows the configured keys");
  if (k.length > 1) throw new Error(`several keys are configured for that provider (${k.map((x) => x.label).join(", ")}): name one with --label`);
  const s = creditStore(DIR), file = path.join(DIR, `${k[0].id}.json`), unlock = s.lock(k[0].id);
  try { fs.unlinkSync(file); fs.unlinkSync(`${file}.lock`); } finally { unlock(); }
  return k[0];
}
