// NEAR direct admission against reports recorded from glm-5-3-flash-i0 and -i1 on 2026-10-23 (all_attestations removed:
// it repeats the report). Intel PCS and NVIDIA RIMs are live; a local JSON-RPC stands in for Base. i0 runs the reviewed
// dstack-nvidia-0.5.11 image; i1 runs another image (RTMR1 4ae60980…, which teep also refuses) and must be refused.
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import fs from "node:fs";
import { checkReport } from "../lib/near.mjs";

process.env.ABALONE_GPU_REVOCATION = "skip";
const load = (i) => JSON.parse(fs.readFileSync(new URL(`./fixtures/near/direct-glm-5.3-flash-${i}.json`, import.meta.url)));
async function chain() {
  const s = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      const q = JSON.parse(b), r = (result) => res.end(JSON.stringify({ jsonrpc: "2.0", id: q.id, result }));
      r(q.method === "eth_chainId" ? "0x2105" : q.method === "eth_blockNumber" ? "0x2dd6b40" : "0x" + "1".padStart(64, "0"));
    });
  });
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok));
  return { reg: { rpc: `http://127.0.0.1:${s.address().port}`, chainId: 8453 }, close: () => s.close() };
}
const check = (rep, i, reg, stages = []) => checkReport(rep, rep.request_nonce, `https://glm-5-3-flash-${i}.completions.near.ai/v1`, "z-ai/glm-5.3-flash",
  { gatewayTcb: "UpToDate", modelTcb: "UpToDate", gpuSignature: "required", composeRegistry: reg }, fetch, (s) => stages.push(s));

test("recorded i0: admitted under the strict policy, pinned to its own attested TLS key", async () => {
  const c = await chain(), rep = load("i0");
  try {
    const v = await check(rep, "i0", c.reg);
    assert.equal(v.profile.route, "direct");
    assert.equal(v.profile.boot_image, "dstack-nvidia-0.5.11");
    assert.deepEqual(v.profile.model_tcb_statuses, ["UpToDate"]);
    assert.equal(v.profile.tls_spki, rep.tls_cert_fingerprint);
    assert.equal(v.signingPublicKey, rep.signing_public_key);
    assert.equal(v.profile.gpu_revocation, "not checked");
    v.transport.close();
  } finally { c.close(); }
});
test("recorded i1: refused at boot-measurement (unreviewed image), before the compose registry or a transport", async () => {
  const c = await chain(), stages = [];
  try {
    await assert.rejects(check(load("i1"), "i1", c.reg, stages), /boot measurements are not a reviewed dstack image \(RTMR1 4ae609807c765916/);
    assert.equal(stages.at(-1), "boot-measurement");
  } finally { c.close(); }
});
test("recorded i0 with a nonce other than its own is refused", async () => {
  const c = await chain(), rep = load("i0");
  try {
    await assert.rejects(checkReport(rep, "00".repeat(32), "https://glm-5-3-flash-i0.completions.near.ai/v1", "z-ai/glm-5.3-flash",
      { gatewayTcb: "UpToDate", modelTcb: "UpToDate", gpuSignature: "required", composeRegistry: c.reg }), /nonce/);
  } finally { c.close(); }
});
