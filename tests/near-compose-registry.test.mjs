// NEAR code admission by its on-chain DstackApps, with a recorded report from after NEAR's rotation to model compose
// c82b1a2e… (tests/fixtures/near/glm-5.3-flash-c82b1a2e.json, 2026-10-08). A local JSON-RPC stands in for Base and
// answers allowedComposeHashes from a set. Intel PCS and NVIDIA NRAS are live (the recorded quotes are checked for real).
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import fs from "node:fs";
import { checkReport, reportNonce } from "../lib/near.mjs";
import { keccak256 } from "../lib/keccak.mjs";

const rep = JSON.parse(fs.readFileSync(new URL("./fixtures/near/glm-5.3-flash-c82b1a2e.json", import.meta.url)));
const SEL = keccak256(Buffer.from("allowedComposeHashes(bytes32)")).subarray(0, 4).toString("hex");
const GATEWAY = "8bc802c9c8043a9c21d1face81b9c9381ed621644478e0b7f5a7f81a7230b1fa", ROTATED = "c82b1a2eaf6996154a5f39ae621643f034b082d5e51edd3d2ba6009273881d86";
const OLD = "55db164f".padEnd(64, "0");

async function chain(allowed) {
  const calls = [];
  const s = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      const q = JSON.parse(b), r = (result) => res.end(JSON.stringify({ jsonrpc: "2.0", id: q.id, result }));
      if (q.method === "eth_chainId") return r("0x2105");
      if (q.method === "eth_blockNumber") return r("0x2dd6b40");
      const { to, data } = q.params[0];
      calls.push({ to, compose: data.slice(10) });
      assert.equal(data.slice(2, 10), SEL);
      r(allowed.has(data.slice(10)) ? "0x" + "1".padStart(64, "0") : "0x" + "0".padStart(64, "0"));
    });
  });
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok));
  return { reg: { rpc: `http://127.0.0.1:${s.address().port}`, chainId: 8453 }, calls, close: () => s.close() };
}
const check = (reg) => checkReport(rep, reportNonce(rep), "https://cloud-api.near.ai/v1", "z-ai/glm-5.3-flash", { gatewayTcb: "reported", modelTcb: "reported", composeRegistry: reg });

test("rotated compose allowed on chain: admitted, with the DstackApps and block recorded", async () => {
  const c = await chain(new Set([GATEWAY, ROTATED]));
  try {
    const v = await check(c.reg);
    assert.deepEqual(v.profile.compose_hashes, [ROTATED]);
    assert.deepEqual(v.profile.compose_registry.apps, ["0xf550fdfb4eb8ad787c1bcd423f091cbb4a4431ae", "0x2c0a0c96cb6dbd659bf1446e2f3fce58172ff91b"]);
    assert.equal(v.profile.compose_registry.block, 0x2dd6b40);
    assert.match(v.profile.code, /admitted by NEAR's DstackApp governance/);
    assert.deepEqual(c.calls.map((x) => x.to), v.profile.compose_registry.apps);
  } finally { c.close(); }
});

test("rotated compose not allowed (the registry still lists only the old one): refused, naming the compose and app", async () => {
  const c = await chain(new Set([GATEWAY, OLD]));
  try { await assert.rejects(check(c.reg), /model compose c82b1a2eaf699615… is not allowed by its DstackApp 0x2c0a0c96cb6dbd659bf1446e2f3fce58172ff91b on chain 8453/); }
  finally { c.close(); }
});

test("registry RPC unreachable: refused, nothing admitted", async () => {
  await assert.rejects(check({ rpc: "http://127.0.0.1:9", chainId: 8453 }), /compose registry RPC http:\/\/127.0.0.1:9 is unreachable/);
});

test("registry RPC on the wrong chain: refused", async () => {
  const c = await chain(new Set([GATEWAY, ROTATED]));
  try { await assert.rejects(check({ ...c.reg, chainId: 1 }), /compose registry RPC is not chain 1/); } finally { c.close(); }
});
