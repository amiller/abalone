// NEAR's per-chat signature (lib/near.mjs chatSignatureFails) against a recorded direct chat: the genuine reply verifies,
// and a reply a relay changed by one byte, a different request, or another signer's address does not.
import assert from "node:assert/strict";
import test from "node:test";
import { chatSignatureFails } from "../lib/near.mjs";
const f = (await import("./fixtures/near/chat-signature.json", { with: { type: "json" } })).default;

test("the recorded reply verifies against the attested gateway address", () => assert.equal(chatSignatureFails(f.signature, f.request, f.response, { model: "z-ai/glm-5.3-flash", gateway_signing_address: f.gateway_signing_address }), null));
test("a forged reply does not", () => assert.match(chatSignatureFails(f.signature, f.request, f.response.replace("ok", "no"), { model: "z-ai/glm-5.3-flash", gateway_signing_address: f.gateway_signing_address }), /do not match/));
test("a different request does not", () => assert.match(chatSignatureFails(f.signature, f.request + " ", f.response, { model: "z-ai/glm-5.3-flash", gateway_signing_address: f.gateway_signing_address }), /do not match/));
test("another signer does not", () => assert.match(chatSignatureFails(f.signature, f.request, f.response, { model: "z-ai/glm-5.3-flash", gateway_signing_address: "0x" + "11".repeat(20) }), /not the attested gateway key/));
test("an unknown signature kind does not", () => assert.match(chatSignatureFails({ ...f.signature, signature_kind: "other" }, f.request, f.response, { model: "z-ai/glm-5.3-flash", gateway_signing_address: f.gateway_signing_address }), /unexpected signature kind/));
test("a signature over other hashes does not", () => assert.match(chatSignatureFails({ ...f.signature, text: f.signature.text.replace(/^./, "0") }, f.request, f.response, { model: "z-ai/glm-5.3-flash", gateway_signing_address: f.gateway_signing_address }), /do not match/));
