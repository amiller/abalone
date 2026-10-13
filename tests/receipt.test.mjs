// Per-response receipt check (§9.3), offline against the verifier's synthetic signed fixtures.
// Run after: (cd vendor/phala-aci/verifier-ts && npx tsc -p tsconfig.test.json)
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fx from "../vendor/phala-aci/verifier-ts/dist-test/test/fixtures.js";
import { receiptTranscriptFromDigests, hashBody } from "../vendor/phala-aci/verifier-ts/dist-test/src/index.js";
import { auditResponse } from "../vendor/phala-aci/provider/dist/provider.js";

const digests = { request: await hashBody(fx.REQUEST_BODY), response: await hashBody(fx.RESPONSE_BODY) };
const upstream = { session: fx.SESSION, requiresVerified: true, serving: "aggregator" };
const audit = (envelope) => receiptTranscriptFromDigests(envelope, fx.KEYSET, fx.KEYSET_DIGEST, digests, upstream);

// Mirrors AciProvider.verifyReceipt: a failed verdict throws, and auditResponse ends the stream with it.
async function streamThrough(envelope) {
  const verify = async () => {
    const t = await audit(envelope);
    if (!t.verdict.verified) throw new Error(`ACI receipt verification failed: ${t.verdict.line}`);
  };
  const res = await auditResponse(new Response(fx.RESPONSE_BODY), verify);
  return res.text();
}

test("control: the valid signed receipt passes and the stream completes", async () => {
  const t = await audit(fx.ENVELOPE);
  assert.equal(t.verdict.verified, true, JSON.stringify(t.lines.filter((l) => l.status === "fail")));
  assert.equal(await streamThrough(fx.ENVELOPE), fx.RESPONSE_BODY);
});

test("bad receipt signature: receipt-1 fails and the stream is terminated naming it", async () => {
  const bad = { ...fx.ENVELOPE, signature: fx.ENVELOPE.signature.replace(/^../, fx.ENVELOPE.signature.startsWith("00") ? "11" : "00") };
  const t = await audit(bad);
  assert.equal(t.lines.find((l) => l.id === "receipt-1").status, "fail");
  await assert.rejects(streamThrough(bad), (e) => { console.log("    " + e.message); return /receipt verification failed/.test(e.message); });
});

test("receipt that says verified serving was not required: upstream-1 fails", async () => {
  const payload = structuredClone(fx.RECEIPT_PAYLOAD);
  payload.event_log.find((e) => e.type === "upstream.verified").required = false;
  const env = await fx.makeDocument(payload);
  const t = await audit(env);
  const line = t.lines.find((l) => l.id === "upstream-1");
  assert.equal(line.status, "fail", line.detail);
  await assert.rejects(streamThrough(env), (e) => { console.log("    " + e.message); return /receipt verification failed/.test(e.message); });
});
