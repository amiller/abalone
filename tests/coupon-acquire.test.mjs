import assert from "node:assert/strict";
import test from "node:test";
import { acquire, acquisitionArgs, HELP, offerText } from "../plugins/coupon/acquire.mjs";
const code = "A".repeat(43), id = "a".repeat(64), hash = "b".repeat(64);
const offer = { state: "offered", creditId: id, offerHash: hash, model: "near/model", nominalCapUsd: "0.10", claimWindow: "Claim by tomorrow" };
const options = { "--trial": "/public/trial.json" };
function scenario({ state = "offered", consent = "bbbbbbbb", fail = false } = {}) {
  const seen = [], claims = [], lines = [];
  const manager = { inspect: async (coupon) => { seen.push(coupon); return { ...offer, state }; },
    redeem: async (...args) => { claims.push(args); if (fail) throw new Error("secret: " + code); } };
  return { seen, claims, lines, run: () => acquire({ options, manager, admission: {}, input: async () => code,
    confirm: async () => consent, output: (s) => lines.push(s) }) };
}
test("acquisition has a separate entry and rejects gift secrets in arguments without echoing them", () => {
  assert.match(HELP, /without opening an agent/);
  assert.throws(() => acquisitionArgs([code]), (e) => !e.message.includes(code));
  assert.throws(() => acquisitionArgs(["--recover", code]), /saved credit ID/);
  assert.throws(() => acquisitionArgs(["--status", "--trial", "/p"]), /Choose/);
});
test("declining terms and expired gifts send no claim", async () => {
  for (const opts of [{ consent: "" }, { state: "expired" }, { state: "reconciliation_required" }]) {
    const s = scenario(opts); await s.run(); assert.equal(s.claims.length, 0);
    assert.ok(!s.lines.join("\n").includes(code));
  }
});
test("redemption passes the exact offer hash and leaves session opening to the user", async () => {
  const s = scenario(); await s.run(); assert.deepEqual(s.claims, [[id, { offerHash: hash }]]);
  assert.match(s.lines.at(-1), /No agent was opened/);
  assert.match(s.lines.at(-1), /NEAR coupon is not a Chutes credential/);
  assert.ok(!s.lines.join("\n").includes(code));
});
test("interrupted claim preserves recovery instructions without echoing raw errors", async () => {
  const s = scenario({ fail: true }); assert.equal(await s.run(), false);
  assert.match(s.lines.at(-1), /--recover [a-f0-9]{64}/);
  assert.ok(!s.lines.join("\n").includes(code));
});
test("recovery calls the same durable operation, without inspecting or generating new claim keys", async () => {
  let args;
  await acquire({ options: { "--recover": id }, manager: { redeem: async (...a) => { args = a; } }, output() {} });
  assert.deepEqual(args, [id, { recover: true }]);
});
test("consent includes expiry, sponsor powers, output limit and explicit firmware exception", () => {
  const text = offerText({ ...offer, providerExpiry: "2026-10-27", sponsorPowers: ["revoke"], requestMaxTokens: 4096, outOfDateException: true });
  for (const term of ["2026-10-27", "revoke", "4096", "outdated firmware", "caps may overshoot"]) assert.ok(text.includes(term));
});
test("uncertain prior claim directs recovery with original identity, never a new ordinary redemption", async () => {
  const lines = [];
  await acquire({ options, manager: { inspect: async () => offer, redeem: async () => { throw Object.assign(new Error("secret " + code), { code: "claim_not_reserved" }); } },
    input: async () => code, confirm: async () => "bbbbbbbb", output: (s) => lines.push(s) });
  assert.match(lines.at(-1), /--recover [a-f0-9]{64}/);
  assert.doesNotMatch(lines.at(-1), /redemption again|secret/);
});
