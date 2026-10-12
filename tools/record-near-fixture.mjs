// Records one live NEAR attestation for the offline G8 test (tests/g8-offline.mjs): the report for a nonce we chose,
// and every verification fetch it caused (NVIDIA NRAS, Intel PCS collateral, NEAR's DstackApps on Base), into
// tests/fixtures/near/attestation.json. Request bodies are kept so JSON-RPC calls to one URL replay apart.
// Uses the configured nearai key (abalone key add nearai) for the report fetch only; no chat request is made, so it costs
// nothing. The key is not recorded. Intel collateral expires (about 30 days), after which the fixture must be re-recorded.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT, providers } from "../lib/config.mjs";
import { checkReport, reportPath } from "../lib/near.mjs";
import { active } from "../lib/keys.mjs";

const key = active("nearai").key;
const near = providers().admitted.find((a) => a.id === "nearai"), model = process.argv[2] ?? "z-ai/glm-5.3-flash";
const nonce = crypto.randomBytes(32).toString("hex");
const r = await fetch(new URL(near.baseUrl).origin + reportPath(model, nonce), { headers: { authorization: `Bearer ${key}` } });
if (!r.ok) throw new Error(`report HTTP ${r.status}: ${await r.text()}`);
const report = await r.json(), http = [];
const recording = async (url, init = {}) => {
  const res = await fetch(url, init), body = Buffer.from(await res.arrayBuffer());
  const headers = Object.fromEntries([...res.headers].filter(([name]) => !/^(authorization|proxy-authorization|cookie|set-cookie)$/i.test(name)));
  http.push({ url: String(url), method: init.method ?? "GET", request: init.body ?? null, status: res.status, headers, body: body.toString("base64") });
  return new Response(body, { status: res.status, headers: res.headers });
};
const v = await checkReport(report, nonce, near.baseUrl, model, near.policy, recording);
fs.writeFileSync(path.join(ROOT, "tests/fixtures/near/attestation.json"), JSON.stringify({ recorded: new Date().toISOString(), model, baseUrl: near.baseUrl, policy: near.policy, nonce, report, http }));
console.log(`recorded ${model}: ${http.length} verification fetches, gateway TCB ${v.profile.gateway_tcb}, signing ${v.profile.model_signing_address}`);
