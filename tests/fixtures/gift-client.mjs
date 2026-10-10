// A coupon holder's requests without Pi, for the ledger tests: the same verification, E2EE and device
// signing as curated/near-provider.ts, against the real node and real NEAR. ABALONE_DIR is the recipient.
//   one | distinct N | same N | seq N → JSON array of turns (seq: N one after another, each timed) (same: N concurrent with one idempotency key, then one more retry)
//   forge <account>              → a request on someone else's account, signed by a fresh key
//   hangup-mid | hangup-end      → start a turn, then exit the process (no close) after its first frame, or right after
//                                  its last: the peer sees the client's libp2p stream reset
// Requests go through an attested libp2p client (lib/p2p.mjs) to the coupon's peer, or to ABALONE_PEER for forge.
// GIFT_IDEM fixes the idempotency key of "one"; GIFT_PROMPT sets the prompt.
import crypto from "node:crypto";
import { providers } from "../../lib/config.mjs";
import { coupon, deviceHeaders } from "../../lib/gift.mjs";
import { decrypt, encrypt, verifyNearModel } from "../../lib/near.mjs";
import { giftClient } from "../../lib/p2p.mjs";

const [mode, arg] = process.argv.slice(2);
const maxTokens = Number(process.env.GIFT_MAX_TOKENS ?? 400);
const cfg = providers().admitted.find((a) => a.id === "nearai");
let c = coupon();
const g = await giftClient(mode === "forge" ? process.env.ABALONE_PEER : c.peer, providers().peers.admit);
if (mode === "forge") {
  const k = crypto.generateKeyPairSync("ed25519").privateKey;
  c = { node: g.url, account: arg, model: "z-ai/glm-5.3-flash", device_key: k.export({ format: "pem", type: "pkcs8" }) };
  const p = "/v1/attestation/report?model=x&nonce=00";
  const r = await fetch(c.node + p, { headers: deviceHeaders(c, "GET", p, "", "") });
  console.log(JSON.stringify({ status: r.status, error: (await r.json()).error?.message }));
  process.exit(0);
}
c = { ...c, node: g.url };
const v = await verifyNearModel(cfg.baseUrl, c.model, (p) => fetch(c.node + p, { headers: deviceHeaders(c, "GET", p, "", "") }), cfg.policy);

// A transport failure is recorded as the turn's result (status 0, the error and its cause), not a crash.
const turn = (...a) => turn1(...a).catch((e) => ({ status: 0, error: `${e.message}${e.cause ? `: ${e.cause.code ?? ""} ${e.cause.message}` : ""}` }));
async function turn1(prompt, idem, ecdh, node = c.node) {
  const body = JSON.stringify({ model: c.model, stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens, messages: [{ role: "user", content: encrypt(prompt, v.signingPublicKey) }] });
  const r = await fetch(`${node}/v1/chat/completions`, { method: "POST", body, headers: { "content-type": "application/json", "x-signing-algo": "ecdsa",
    "x-client-pub-key": ecdh.getPublicKey("hex").slice(2), "x-model-pub-key": v.signingPublicKey, ...deviceHeaders(c, "POST", "/v1/chat/completions", idem, body) } });
  const raw = await r.text();
  if (!r.ok) return { status: r.status, node, error: JSON.parse(raw).error.message };
  let text = "", usage = null, charge = null;
  for (const l of raw.split("\n")) {
    if (l.startsWith(": abalone-charge ")) charge = JSON.parse(l.slice(17));
    if (!l.startsWith("data: {")) continue;
    const d = JSON.parse(l.slice(6));
    usage = d.usage ?? usage;
    for (const ch of d.choices ?? []) if (ch.delta?.content) text += decrypt(ch.delta.content, ecdh);
  }
  return { status: r.status, node, idem, text, usage, charge, waited: raw.includes(": abalone-status confirming credit"), replayed: r.headers.get("x-abalone-replayed") === "1", sha: crypto.createHash("sha256").update(raw.split("\n: abalone-charge")[0]).digest("hex") };
}
const fresh = () => { const e = crypto.createECDH("secp256k1"); e.generateKeys(); return e; };
const idem = () => crypto.randomBytes(16).toString("hex");
const prompt = process.env.GIFT_PROMPT || "Reply with exactly: abalone ok";
let out;
if (mode === "hangup-mid" || mode === "hangup-end") {
  const e = fresh(), i = idem();
  const body = JSON.stringify({ model: c.model, stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens, messages: [{ role: "user", content: encrypt(prompt, v.signingPublicKey) }] });
  const r = await fetch(`${c.node}/v1/chat/completions`, { method: "POST", body, headers: { "content-type": "application/json", "x-signing-algo": "ecdsa",
    "x-client-pub-key": e.getPublicKey("hex").slice(2), "x-model-pub-key": v.signingPublicKey, ...deviceHeaders(c, "POST", "/v1/chat/completions", i, body) } });
  if (mode === "hangup-mid") await r.body.getReader().read(); else await r.text();
  console.log(JSON.stringify({ hungup: mode, status: r.status }));
  process.exit(0);
}
if (mode === "one") out = [await turn(prompt, process.env.GIFT_IDEM || idem(), fresh())];
if (mode === "seq") { out = []; for (let i = 0; i < Number(arg); i++) { const t0 = Date.now(); out.push({ ...(await turn(prompt, idem(), fresh())), ms: Date.now() - t0 }); } }
if (mode === "distinct") out = await Promise.all(Array.from({ length: Number(arg) }, () => turn(prompt, idem(), fresh())));
if (mode === "same") {
  const i = idem(), e = fresh();
  out = await Promise.all(Array.from({ length: Number(arg) }, () => turn(prompt, i, e)));
  out.push(await turn(prompt, i, e));
}
console.log(JSON.stringify(out));
await g.close();
