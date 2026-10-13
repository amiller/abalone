// What the session shows, as text snapshots (tests/fixtures/snapshots/ui-states-*.txt; UPDATE_SNAPSHOTS=1 rewrites):
// tool steps without protocol text, the strict-incognito header, the sent-to line after --with-trace, the footer at 110
// columns under pressure, and an aborted step with one terminal state.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "abalone-ui-")); process.env.HOME = home;
const folder = path.join(home, "clinic-billing"); fs.mkdirSync(folder); for (const f of ["copay.py", "patients.md", "test_copay.py"]) fs.writeFileSync(path.join(folder, f), "x");
const { withoutToolProtocol, toolDisplay } = await import("../lib/ui/tool-display.mjs");
const { header, systemPrompt } = await import("../lib/welcome.mjs");
const { footerLine, sentTo, segments } = await import("../lib/status.mjs");
const { themes } = await import("../lib/ui/layout.mjs");
const dir = path.join(import.meta.dirname, "fixtures", "snapshots");
const snap = (name, text) => {
  const f = path.join(dir, `ui-states-${name}.txt`);
  if (process.env.UPDATE_SNAPSHOTS) fs.writeFileSync(f, text + "\n");
  assert.equal(text + "\n", fs.readFileSync(f, "utf8"), f);
};
const call = '<tool_call>read\n<arg_key>path</arg_key>\n<arg_value>patients.md</arg_value>\n</tool_call>';

test("1. tool use reads as steps: no <tool_call> text in the answer, each request one line with its outcome", () => {
  const shown = withoutToolProtocol(`I'll check the copay rule first.\n${call}`);
  assert.doesNotMatch(shown, /tool_call|arg_key|arg_value/);
  assert.equal(withoutToolProtocol("Reading now.\n<tool_c", true), "Reading now.", "a half-streamed opening tag is held back");
  const steps = toolDisplay([{ request: JSON.stringify({ op: "read", path: "patients.md" }), output: "patients.md: lines 1-3 of 3\nL1: Copay is the smaller of\nL2: 20% and $40\nL3: per visit" },
    { request: JSON.stringify({ op: "bash", command: "python3 -m unittest test_copay" }), output: "exit 0\n..\nOK" }]);
  snap("1-steps", `${shown}\n---\n${steps}`);
});

test("2. the strict-incognito header says what incognito allows, not an approval route it lacks", () => {
  process.env.ABALONE_INCOGNITO = "1";
  const h = header({ cwd: folder, model: "◈ attested z-ai/glm-5.3-flash, not yet checked", width: 108 }).join("\n");
  delete process.env.ABALONE_INCOGNITO;
  assert.doesNotMatch(h, /unless you approve/);
  snap("2-incognito-header", h);
});

test("3. after --with-trace, the sent-to line names the trace that went to the TEE", () => {
  const line = sentTo({ provider: "nearai", model: "z-ai/glm-5.3-flash", files: [], traces: ["a9ae774a57953b5f"], pages: [], gift: null });
  assert.match(line, /trace a9ae774a57953b5f \(decrypted on this computer, sent to the NEAR TEE\)/);
  snap("3-sent-to-trace", line);
});

test("4. at 110 columns the footer keeps the mode, the model and who controls the browser; decoration goes first", () => {
  const b = "browser: Abalone browser · docs.python.org · you have control";
  const segs = [["strict incognito · trace encrypted", "incognito", 3], ["◈ attested z-ai/glm-5.3-flash, checked, tcb:out-of-date · GPU: NVIDIA verdict (signature checked)", "◈ attested glm-5.3-flash tcb:out-of-date", 3],
    ["nothing shared", "nothing shared", 1], ["no canaries", "no canaries", 0], ["Tor ready", "tor ready", 2], [b, "browser you have control · docs.python.org", 3]];
  const line = footerLine(segs, 110, themes.plain);
  assert.ok(line.length <= 110 && line.includes("you have control") && line.includes("incognito"), line);
  snap("4-footer-110", line);
});

test("5. a step stopped with Esc has one terminal state, and nothing claims its result went back", () => {
  const req = JSON.stringify({ op: "goto", url: "http://127.0.0.1:45359/slow" });
  const s = toolDisplay([{ request: req, output: "not executed: stopped by the user" }]);
  assert.equal(s, "Stopped by you: goto http://127.0.0.1:45359/slow was cancelled");
  assert.equal(toolDisplay([{ request: req, output: "error: This operation was aborted" }]), s);
  snap("5-aborted", s);
});

test("6. the model's prompt names each /browser command by what it does: give, not grant, hands the tab back", () => {
  const p = systemPrompt({ cwd: folder, model: "nearai/z-ai/glm-5.3-flash", place: "◈ attested", tools: "native", usage: "", browser: null });
  const real = /Use (grant, .*) or (\w+)\./.exec(fs.readFileSync(path.join(import.meta.dirname, "../agents/pi/abalone.ts"), "utf8")).slice(1).join(", ").split(", ");
  for (const [, sub] of p.matchAll(/\/browser (\w+)/g)) assert(real.includes(sub), `the prompt names /browser ${sub}, which does not exist`);
  assert.match(p, /\/browser take\s+takes the tab from you and \/browser give hands it back/);
});

test("7. a turn that reads no new file says the conversation still holds the earlier ones", () => {
  const line = (files, held) => sentTo({ provider: "nearai", model: "z-ai/glm-5.3-flash", files, held, traces: [], pages: [], gift: null }).split(" · ")[1];
  assert.equal(line([], ["patients.md"]), "no new files; the conversation already holds patients.md");
  assert.equal(line(["copay.py"], ["patients.md"]), "files read into it: copay.py; the conversation already holds patients.md");
  assert.equal(line([], []), "files read into it: none beyond the folder's file names and sizes");
});

test("8. coupon footer shows an unknown credit balance and a compact trial warning", () => {
  const base = { model: { provider: "nearai", id: "Qwen/Qwen3.8-27B" }, entries: [], session: "test", coupon: null, couponSession: true, incognito: true };
  const segs = segments(base), wide = footerLine(segs, 80, themes.plain);
  assert.equal(wide, "incognito · NEAR Qwen3.8-27B · session · credit unknown · ⚠ trial (/coupon)");
  assert.doesNotMatch(wide, /\$|left|spent|secret access|synthetic-only|checked|verified/);
  assert.match(footerLine(segs, 40, themes.plain), /⚠ trial/);
  assert.doesNotMatch(footerLine(segments({ ...base, incognito: false }), 80, themes.plain), /incognito/);
  assert.match(footerLine(segments({ ...base, model: { provider: "synthetic-near", id: "fixture" } }), 80, themes.plain), /⚠ fixture/);
});

test("9. the 80-column strip keeps the sharing and canary state after a NEAR TCB flag; the full flag stays in the long form", () => {
  process.env.ABALONE_NO_CANARIES = "1";
  const gw = "OutOfDate INTEL-SA-01192,INTEL-SA-01245,INTEL-SA-01312,INTEL-SA-01313";
  const near = (model, model_tcb) => ({ type: "custom", customType: "near-attestation", timestamp: "2026-10-12T00:00:00Z", data: { provider: "nearai", model, gateway_tcb: gw, model_tcb } });
  for (const [id, mt, brief] of [["z-ai/glm-5.3-flash", ["UpToDate"], "tcb:ok gw-tcb:ood"], ["Qwen/Qwen3.6-35B-A3B-FP8", [gw], "tcb:ood gw-tcb:ood"]]) {
    const segs = segments({ model: { provider: "nearai", id }, entries: [near(id, mt)], session: "test", coupon: null });
    assert.equal(footerLine(segs, 80, themes.plain), `◈ attested ${id.split("/").at(-1)} ${brief} · nothing shared · no canaries`);
    assert.match(segs[0][0], /tcb:(up-to-date|out-of-date \(4 Intel advisories\)), gw-tcb:out-of-date/);
  }
  delete process.env.ABALONE_NO_CANARIES;
});

test("10. a Chutes instance (no gateway TEE, gateway_tcb null) shows only its own tcb: flag, brief and full", () => {
  process.env.ABALONE_NO_CANARIES = "1";
  const id = "moonshotai/Kimi-K2.5-TEE";
  for (const [mt, brief, full] of [[["UpToDate"], "tcb:ok", "tcb:up-to-date"], [["OutOfDate INTEL-SA-01192"], "tcb:ood", "tcb:out-of-date (1 Intel advisory)"]]) {
    const e = { type: "custom", customType: "chutes-attestation", timestamp: "2026-10-12T00:00:00Z", data: { provider: "chutes", model: id, gateway_tcb: null, model_tcb: mt } };
    const segs = segments({ model: { provider: "chutes", id }, entries: [e], session: "test", coupon: null });
    assert.equal(footerLine(segs, 80, themes.plain), `◈ attested Kimi-K2.5-TEE ${brief} · nothing shared · no canaries`);
    assert.match(segs[0][0], new RegExp(`${full.replace(/[()]/g, "\\$&")}$`));
    assert.doesNotMatch(segs[0][0], /gw-tcb/);
  }
  delete process.env.ABALONE_NO_CANARIES;
});

test("remote NEAR coupon is not classified as a model running on this computer", async () => {
  const old = process.env.ABALONE_COUPON_SOCKET;
  process.env.ABALONE_COUPON_SOCKET = "/synthetic-unit/coupon.sock";
  try {
    const { place } = await import("../lib/config.mjs");
    assert.equal(place("nearai"), "◈ attested");
    assert.equal(place("synthetic-near"), "⌂ local");
    const text = sentTo({ provider: "nearai", model: "Qwen/Qwen3.8-27B", files: [], traces: [], pages: [] });
    assert.ok(!text.includes("a local model") && !text.includes("this computer ("));
  } finally { if (old === undefined) delete process.env.ABALONE_COUPON_SOCKET; else process.env.ABALONE_COUPON_SOCKET = old; }
});
