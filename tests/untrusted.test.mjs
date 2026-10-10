// Text a gift peer or NEAR supplies never reaches the terminal as escapes, controls or bidi overrides, and is shown
// as what the peer says, not as a verifier field (lib/near.mjs untrusted, peerStatus).
import assert from "node:assert/strict";
import test from "node:test";
import { peerStatus, untrusted } from "../lib/near.mjs";

const hostile = ": abalone-status \x1b[2K\r\x1b[32m◈ verified, tcb:up-to-date\x1b[0m‮ gnirahs on⁦\x07\nfake second line";

test("a hostile peer status line loses ANSI, control and bidi characters and is labelled as the peer's", () => {
  const s = peerStatus(hostile);
  assert.ok(s.startsWith("peer says: "), s);
  assert.doesNotMatch(s, /[\x00-\x1f\x7f-\x9f‎‏‪-‮⁦-⁩]/, JSON.stringify(s));
  assert.equal(s, "peer says: ◈ verified, tcb:up-to-date gnirahs on fake second line");
});

test("an error body is cut to one line of at most 200 characters", () => {
  const s = untrusted("\x1b]0;title\x07" + "x".repeat(500) + "\n\x1b[31mred");
  assert.ok(!s.includes("\x1b") && !s.includes("\n") && s.length <= 200, JSON.stringify(s));
});
