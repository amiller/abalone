// Issue 0007: per-model admission behind RedPill, on session lists and receipts recorded live on 2026-10-08
// (tests/fixtures/aci-upstreams, from local-data/default-model-2026-10-08/evidence). Offline.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { modelVerdict, receiptVerdict, vet } from "../lib/upstream.mjs";

const dir = path.join(import.meta.dirname, "fixtures/aci-upstreams");
const redpill = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../providers.json"), "utf8")).admitted.find((a) => a.id === "redpill");
const load = (kind, m) => JSON.parse(fs.readFileSync(path.join(dir, `${kind}-${m.replace("/", "_")}.json`), "utf8"));
const sessions = (m) => load("sessions", m).sessions;
const cited = JSON.parse(fs.readFileSync(path.join(dir, "cited-sessions.json"), "utf8")).sessions; // fetched by id: a listing is a snapshot
const cases = [
  ["nvidia/nemotron-3.5-lightning", { label: "via RedPill → Phala TEE" }],
  ["moonshotai/kimi-k3", { reason: "upstream chutes is not admitted" }],
  ["z-ai/glm-5.3-flash", { reason: "upstream near-ai: tcb_up_to_date is refuted" }],
  ["meta-llama/llama-3.3-70b-instruct", { reason: "upstream tinfoil is not admitted" }],
];

for (const [m, want] of cases) {
  test(`model ${m}: ${want.label ?? want.reason}`, () => assert.deepEqual(modelVerdict(redpill.upstreams, sessions(m)), want));
  test(`recorded receipt for ${m} judged by the session it cites`, () => assert.equal(receiptVerdict(redpill.upstreams.admit, load("receipt", m), cited), want.label ? null : want.reason));
}
test("a model with no listed session is refused", () => assert.deepEqual(modelVerdict(redpill.upstreams, []), { reason: "no upstream session listed" }));

test("vet: the launcher's allowlist from the recorded listings", async () => {
  const http = async (url) => {
    const u = new URL(url);
    const body = u.pathname.endsWith("/models") ? { data: cases.map(([id]) => ({ id, is_tee: true })) } : load("sessions", u.searchParams.get("model"));
    return new Response(JSON.stringify(body));
  };
  const v = await vet(redpill, http);
  assert.deepEqual(Object.keys(v.admitted), ["nvidia/nemotron-3.5-lightning"]);
  assert.deepEqual(Object.keys(v.refused).sort(), ["meta-llama/llama-3.3-70b-instruct", "moonshotai/kimi-k3", "z-ai/glm-5.3-flash"]);
});
test("vet: a failed listing throws (the launcher then loads nothing from that provider)", async () => {
  await assert.rejects(vet(redpill, async () => new Response("", { status: 503 })), /redpill \/models: HTTP 503/);
});
