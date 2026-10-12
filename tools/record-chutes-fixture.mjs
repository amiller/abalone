// Records one live Chutes instance attestation and one sealed chat for the offline test (tests/chutes.test.mjs), into
// tests/fixtures/chutes/attestation.json: the instance's ML-KEM key, its evidence for a nonce we chose, every verification
// fetch it caused (Intel PCS collateral, NVIDIA NRAS and JWKS), then a tiny chat sealed to it: the request blob, the
// sealed reply and the one-request response key that opens it. The account key comes from CHUTES_API_KEY and is not
// recorded, nor are the instance's invoke nonces. The chat costs a few tokens. Intel collateral expires (about 30 days).
//   CHUTES_API_KEY=... node tools/record-chutes-fixture.mjs [chute model id]
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT, providers } from "../lib/config.mjs";
import { API, checkEvidence, open, seal } from "../lib/chutes.mjs";

const cfg = providers().admitted.find((a) => a.id === "chutes"), model = process.argv[2] ?? "deepseek-ai/DeepSeek-V3.2-TEE";
const H = { authorization: `Bearer ${process.env.CHUTES_API_KEY}` };
const get = async (p) => { const r = await fetch(API + p, { headers: H }); if (!r.ok) throw new Error(`${p.split("?")[0]} HTTP ${r.status}: ${await r.text()}`); return r.json(); };
const chuteId = (await (await fetch(cfg.modelsUrl)).json()).data.find((m) => m.id === model).chute_id;
const inst = (await get(`/e2e/instances/${chuteId}`)).instances.find((i) => i.nonces?.length);
const nonce = crypto.randomBytes(32).toString("hex");
const { quote, certificate, gpu_evidence } = await get(`/instances/${inst.instance_id}/evidence?nonce=${nonce}`);
const evidence = { quote, certificate, gpu_evidence }, http = [];
const recording = async (url, init = {}) => {
  const res = await fetch(url, init), body = Buffer.from(await res.arrayBuffer());
  const headers = Object.fromEntries([...res.headers].filter(([name]) => !/^(authorization|proxy-authorization|cookie|set-cookie)$/i.test(name)));
  http.push({ url: String(url), method: init.method ?? "GET", request: init.body ?? null, status: res.status, headers, body: body.toString("base64") });
  return new Response(body, { status: res.status, headers: res.headers });
};
const recorded = new Date().toISOString();
const profile = await checkEvidence(evidence, nonce, inst, cfg.policy, recording);
const request = { model, messages: [{ role: "user", content: "Reply with exactly: abalone-chutes-fixture" }], max_tokens: 16, stream: false };
const { blob, sk } = seal(inst.e2e_pubkey, request);
const r = await fetch(`${API}/e2e/invoke`, { method: "POST", body: blob, headers: { ...H, "content-type": "application/octet-stream", "X-Chute-Id": chuteId,
  "X-Instance-Id": inst.instance_id, "X-E2E-Nonce": inst.nonces[0], "X-E2E-Stream": "false", "X-E2E-Path": "/v1/chat/completions" } });
const reply = Buffer.from(await r.arrayBuffer());
if (!r.ok) throw new Error(`invoke HTTP ${r.status}: ${reply}`);
fs.mkdirSync(path.join(ROOT, "tests/fixtures/chutes"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "tests/fixtures/chutes/attestation.json"), JSON.stringify({ recorded, model, chuteId, policy: cfg.policy, nonce,
  instance: { instance_id: inst.instance_id, e2e_pubkey: inst.e2e_pubkey }, evidence, http,
  chat: { request, blob: blob.toString("base64"), reply: reply.toString("base64"), sk: Buffer.from(sk).toString("base64") } }));
console.log(`recorded ${model} instance ${inst.instance_id}: ${profile.measurement}, TCB ${profile.model_tcb}, ${profile.gpu}; ${http.length} verification fetches; reply ${open(reply, sk)}`);
