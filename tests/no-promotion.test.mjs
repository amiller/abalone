// G7: a no-promotion gift creates no campaign consent and lets no unsolicited commercial offer render.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ABALONE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "abalone-g7-"));
const c = await import("../lib/consent/index.mjs");
const day = 86400e3, until = new Date(Date.now() + 30 * day).toISOString();
const reset = () => fs.rmSync(path.join(process.env.ABALONE_DIR, "consent.json"), { force: true });
const offers = () => c.OFFER_KINDS.flatMap((kind) => c.SURFACES.map((surface) => ({ kind, surface })));

test("terms must state noPromotion with explicit scope and duration", () => {
  assert.throws(() => c.parseTerms({}), /noPromotion must be stated/);
  assert.throws(() => c.parseTerms({ noPromotion: true }), /scope/);
  assert.throws(() => c.parseTerms({ noPromotion: { scope: ["terminal"] } }), /until/);
  assert.throws(() => c.parseTerms({ noPromotion: { scope: ["billboard"], until } }), /scope/);
  assert.deepEqual(c.parseTerms({ noPromotion: false }), { noPromotion: false });
});

test("redemption creates no consent; no unsolicited offer on any surface", () => {
  reset();
  c.applyGift("gift-1", { noPromotion: { scope: c.SURFACES, until } });
  assert.deepEqual(c.load().consents, []);
  for (const o of offers()) assert.equal(c.mayOffer(o), false, `${o.kind}@${o.surface}`);
});

test("no-promotion overrides a prior consent within scope and duration, then lapses", () => {
  reset();
  c.grantConsent("campaign", { scope: ["terminal", "email"], until });
  c.applyGift("gift-2", { noPromotion: { scope: ["terminal"], until: new Date(Date.now() + day).toISOString() } });
  assert.equal(c.mayOffer({ kind: "campaign", surface: "terminal" }), false);
  assert.equal(c.mayOffer({ kind: "campaign", surface: "email" }), true);
  assert.equal(c.mayOffer({ kind: "campaign", surface: "terminal" }, Date.now() + 2 * day), true);
});

test("a gift without no-promotion still grants no consent", () => {
  reset();
  c.applyGift("gift-3", { noPromotion: false });
  assert.deepEqual(c.load(), { consents: [], restrictions: [] });
  for (const o of offers()) assert.equal(c.mayOffer(o), false);
});

test("recipient-opened marketplace is not blocked", () => {
  reset();
  c.applyGift("gift-4", { noPromotion: { scope: c.SURFACES, until } });
  assert.equal(c.mayOffer({ kind: "trace-sale", surface: "terminal", solicited: true }), true);
  assert.deepEqual(c.load().consents, []);
});
