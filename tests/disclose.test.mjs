// The disclosure screen (the session's pour prompt) and the footer strip as text: 80 and 120 columns, with and without color, against snapshots in
// tests/fixtures/snapshots. UPDATE_SNAPSHOTS=1 rewrites them (review the diff before committing).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { screen } from "../lib/disclose.mjs";
import { footerLine } from "../lib/status.mjs";
import { STATES, status, themes } from "../lib/ui/layout.mjs";

const dir = path.join(import.meta.dirname, "fixtures", "snapshots");
const d = {
  id: "d-0123abcd", needed: true, to: "runner:claude", dest: { to: "runner:claude",
    what: "runner:claude, outside abalone: one run of your own Claude subscription, in a sandbox that sees only this text",
    account: "It goes out under your own Claude login: the vendor can tie it, its size and its timing to your account.",
    envelope: 'abalone puts one fixed line before it: "The file pour.md holds a question from another agent. Answer it."' }, policy: "free_text", maxBytes: 600, edited: false, file: "tenancy-renewal.pdf",
  help: "Whether a fixed-term tenancy rolls over if the tenant does nothing before the renewal deadline.",
  reveals: "The jurisdiction, that the user is a tenant facing a renewal with a rent rise of about 5%, and that a deadline is near.",
  payload: "Under a typical residential tenancy in England, if a renewal offer raises the monthly rent by about 5% and the tenant does nothing before the deadline, does the tenancy roll over to a periodic tenancy, and on what terms?\nAnswer in two short paragraphs.",
  verdict: { verdict: "go", reason: "standing policy" }, hosts: ["api.anthropic.com", "console.anthropic.com", "platform.claude.com"],
  login: "/repo/runner-home/claude", loggedIn: true, canaries: 12, budget: 6000, log: "/home/user/.abalone/disclosures.jsonl", sent: 0, notSent: 1, noSend: null,
};
d.bytes = Buffer.byteLength(d.payload); d.sha = "5e1f00c0ffee" + "0".repeat(52);
const SGR = /\x1b\[[0-9;]*m/g;

for (const cols of [80, 120]) {
  test(`disclosure screen at ${cols} columns`, () => {
    const plain = screen(d, cols, themes.plain), color = screen(d, cols, themes.ansi);
    for (const [name, text] of [[`disclose-${cols}.txt`, plain], [`disclose-${cols}-color.txt`, color]]) {
      if (process.env.UPDATE_SNAPSHOTS) fs.writeFileSync(path.join(dir, name), text + "\n");
      assert.equal(text + "\n", fs.readFileSync(path.join(dir, name), "utf8"), name);
    }
    assert.equal(color.replace(SGR, ""), plain, "color adds emphasis only: without it the text is identical");
    assert.ok(!plain.includes("\x1b"), "no escape bytes without color");
    for (const l of plain.split("\n")) assert.ok(l.length <= cols, `${l.length} > ${cols}: ${l}`);
    const amber = color.split("\n").filter((l) => l.includes("\x1b[33m")).map((l) => l.replace(SGR, ""));
    assert.deepEqual(amber.slice(0, 2).map((l) => l.slice(0, 18)), ["REVIEW DISCLOSURE ", "Continue privately"], "amber marks only the proposed boundary change");
    assert.equal(amber.length, 3, "the header and the two-line choice note");
    assert.equal(/Details: choose "details"/.test(plain), cols < 120, "details: a dialog option at 80, a pane at 120");
    assert.equal(/\| Details \(from config/.test(plain), cols >= 120);
  });
}

test("a blocked send is said in words, and the screen offers no send", () => {
  const b = { ...d, payload: "a\x1b[2Kb", verdict: { verdict: "block", reason: "payload holds control or bidi characters" }, noSend: "blocked by the gate: payload holds control or bidi characters" };
  const plain = screen(b, 80, themes.plain);
  assert.match(plain, /gate +free_text, \d+ of 600 bytes: blocked: payload holds control/);
  assert.match(plain, /Send is\s+not available: blocked by the gate/);
  assert.match(plain, /^\| a\\x1b\[2Kb$/m, "the escape is spelled out inside the exact block");
});

test("the footer strip: one line within 80 columns; color only paints tcb:out-of-date", () => {
  const segs = [["◈ attested z-ai/glm-5.3-flash, verified, tcb:out-of-date", "◈ attested glm-5.3-flash tcb:out-of-date"], ["nothing shared", "nothing shared"], ["$0.0003 used", "$0.0003"], ["gift $4.98 left", "gift $4.98"]];
  const plain = footerLine(segs, 80, themes.plain), color = footerLine(segs, 80, themes.ansi);
  assert.equal(plain, "◈ attested glm-5.3-flash tcb:out-of-date · nothing shared · $0.0003 · gift $4.98");
  assert.equal(footerLine(segs, 120, themes.plain), segs.map((s) => s[0]).join(" · "));
  assert.equal(color.replace(SGR, ""), plain);
  assert.equal(color.match(SGR).length, 2, "only the flag is painted");
  assert.equal(footerLine(segs, 40, themes.plain).length, 40, "an over-long strip is cut to the width, marked with …");
});

test("every task state renders as a word", () => {
  for (const s of STATES) assert.equal(status(s, "x", 80)[0], `[${s}] x`);
  assert.throws(() => status("done", "x", 80));
});
