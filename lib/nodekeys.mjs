// The node's keystore: provider API keys belong to node contributors, never to agent users.
// <STATE>/node/keys.json, mode 0600: { active: {provider: label}, keys: [{kind, provider, label, key, added}] }.
// kind is "api-key" here; the coupon track adds kind "coupon" entries on the agent side.
import fs from "node:fs";
import path from "node:path";
import { NODE_DIR, providers } from "./config.mjs";

const FILE = path.join(NODE_DIR, "keys.json");
export const load = () => fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : { active: {}, keys: [] };
function save(store) {
  fs.mkdirSync(NODE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(FILE, JSON.stringify(store, null, 1), { mode: 0o600 });
  fs.chmodSync(FILE, 0o600);
}
const provider = (id) => {
  const p = providers().admitted.find((a) => a.id === id);
  if (!p) throw new Error(`unknown provider ${id}: expected one of ${providers().admitted.map((a) => a.id).join(", ")}`);
  return p;
};
const find = (store, prov, label) => {
  const k = store.keys.find((k) => k.provider === prov && k.label === label);
  if (!k) throw new Error(`no key ${prov}/${label}`);
  return k;
};

// One cheap authenticated call: an empty chat completion is rejected for its body (4xx) with a valid
// key, and with 401/403 for an invalid one. It carries no prompt and costs nothing.
export async function validate(p, key) {
  const r = await fetch(`${p.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: '{"model":"-","messages":[]}' });
  if (r.status === 401 || r.status === 403) throw new Error(`key rejected by ${p.id}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  if (r.status >= 500) throw new Error(`cannot validate key: ${p.id} answered HTTP ${r.status}`);
}

export async function add(prov, label, key) {
  const p = provider(prov);
  key = key.trim();
  if (!key) throw new Error("empty key");
  const store = load();
  if (store.keys.some((k) => k.provider === prov && k.label === label)) throw new Error(`key ${prov}/${label} already exists`);
  await validate(p, key);
  store.keys.push({ kind: "api-key", provider: prov, label, key, added: new Date().toISOString() });
  store.active[prov] ??= label;
  save(store);
}
export function use(prov, label) { const s = load(); find(s, prov, label); s.active[prov] = label; save(s); }
export function rm(prov, label) {
  const s = load(); find(s, prov, label);
  s.keys = s.keys.filter((k) => !(k.provider === prov && k.label === label));
  if (s.active[prov] === label) delete s.active[prov];
  save(s);
}
export const list = () => { const s = load(); return s.keys.map((k) => ({ ...k, active: s.active[k.provider] === k.label })); };
export function active(prov) { const s = load(); return s.active[prov] && find(s, prov, s.active[prov]); }
