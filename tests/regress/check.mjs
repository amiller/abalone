// Replay one fixture dir's reported turn through the stub provider and assert its expect.json. Prints PASS/FAIL per check.
// usage: node tests/regress/check.mjs <tests/regress/NNNN>
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runPrompt } from "../../lib/rpc.mjs";

const dir = path.resolve(process.argv[2]), fx = JSON.parse(fs.readFileSync(path.join(dir, "fixture.json"), "utf8"));
const { checks } = JSON.parse(fs.readFileSync(path.join(dir, "expect.json"), "utf8"));
if (fx.protocol !== "intools") throw new Error(`${dir}: replay supports protocol "intools", not ${JSON.stringify(fx.protocol)}`);
// The stub runs under the recorded provider's tool setting (the repo's providers.json, or the test config's for a stub), as the real provider would.
const pf = path.join(process.env.ABALONE_CONFIG, "providers.json"), pj = JSON.parse(fs.readFileSync(pf, "utf8"));
const real = [...JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../../providers.json"), "utf8")).admitted, ...pj.admitted].find((a) => a.id === fx.model.split("/")[0]);
if (!real) throw new Error(`${fx.model}: provider not in providers.json`);
pj.admitted.find((a) => a.id === "stub-e2ee").tools = real.tools;
fs.writeFileSync(pf, JSON.stringify(pj));
const cwd = fs.mkdtempSync(path.join(process.env.ABALONE_DIR, "regress-"));
const { events } = await runPrompt({ args: ["--model", "stub-e2ee/script"], message: fx.turns.at(-1).user, onUi: (ev) => { throw new Error(`unexpected ${ev.method} dialog`); },
  env: { ...process.env, STUB_SCRIPT: path.join(import.meta.dirname, "replay.mjs"), REGRESS_FIXTURE: path.join(dir, "fixture.json") }, cwd });
// next_sees checks: a follow-up turn in the same session, whose stub answers with what the model was sent.
let next = "";
if (checks.some((c) => "next_sees" in c)) {
  const r = await runPrompt({ args: ["--model", "stub-e2ee/script", "--continue"], message: "and now?", onUi: (ev) => { throw new Error(`unexpected ${ev.method} dialog`); },
    env: { ...process.env, STUB_SCRIPT: path.join(import.meta.dirname, "replay.mjs"), REGRESS_FIXTURE: path.join(dir, "fixture.json"), REGRESS_ECHO: "1" }, cwd });
  next = r.events.filter((e) => e.type === "message_end" && e.message.role === "assistant").at(-1).message.content.map((c) => c.text ?? "").join("");
}
// screen_* checks: the same replay in the real terminal UI (tmux, NO_COLOR), read once the screen settles. The window is 300
// rows tall because a full redraw clears the scrollback.
let screen = "";
if (checks.some((c) => Object.keys(c)[0].startsWith("screen_"))) {
  const t = `regress-${process.pid}`, tm = (...a) => spawnSync("tmux", ["-L", t, ...a], { encoding: "utf8" }).stdout; // own server: an attached client cannot resize it
  const env = Object.entries({ NO_COLOR: 1, ABALONE_NO_CANARIES: 1, ...Object.fromEntries(["ABALONE_DIR", "ABALONE_CONFIG", "ABALONE_RUNNER_CLAUDE"].map((k) => [k, process.env[k]])),
    STUB_SCRIPT: path.join(import.meta.dirname, "replay.mjs"), REGRESS_FIXTURE: path.join(dir, "fixture.json") }).map(([k, v]) => `${k}=${v}`).join(" ");
  tm("new-session", "-d", "-s", t, "-x", "100", "-y", "300", `cd ${cwd} && env ${env} ${path.join(import.meta.dirname, "../../bin/abalone")} sandbox --model stub-e2ee/script; sleep 60`);
  tm("resize-window", "-t", t, "-x", "100", "-y", "300");
  const settle = async (want) => { let prev = null; for (let i = 0; i < 120; i++) { await new Promise((r) => setTimeout(r, 500)); const cur = tm("capture-pane", "-t", t, "-p");
    if (cur === prev && cur.includes(want)) return; prev = cur; } throw new Error(`tui: the screen never settled on "${want}"`); };
  await settle("nothing shared");
  tm("send-keys", "-t", t, "-l", fx.turns.at(-1).user); tm("send-keys", "-t", t, "Enter");
  await new Promise((r) => setTimeout(r, 2000)); await settle("nothing shared");
  screen = tm("capture-pane", "-t", t, "-p");
  tm("kill-session", "-t", t);
}
const msgs = events.filter((e) => e.type === "message_end" && e.message.role === "assistant").map((e) => e.message);
const appended = events.filter((e) => e.type === "entry_appended").map((e) => e.entry);
// What the user sees: the replies, displayed custom messages, error text and notifications.
const shown = [...msgs.flatMap((m) => [...m.content.filter((c) => c.type === "text").map((c) => c.text), m.errorMessage ?? ""]),
  ...appended.filter((e) => e.type === "custom_message" && e.display).map((e) => e.content),
  ...events.filter((e) => e.method === "notify").map((e) => e.message)].join("\n");
const status = events.filter((e) => e.method === "setStatus").map((e) => e.statusText ?? "").join("\n");
const test = {
  stop: (v) => [msgs.at(-1)?.stopReason === v, `last stopReason ${msgs.at(-1)?.stopReason}`],
  max_model_calls: (v) => [msgs.length <= v, `${msgs.length} model calls`],
  shown_matches: (v) => [new RegExp(v).test(shown), "shown text"],
  shown_not_matches: (v) => [!new RegExp(v).test(shown), "shown text"],
  status_matches: (v) => [new RegExp(v).test(status), "status strip"],
  screen_matches: (v) => [new RegExp(v).test(screen), "screen"],
  screen_not_matches: (v) => [!new RegExp(v).test(screen), "screen"],
  next_sees: (v) => [new RegExp(v).test(next), `the next turn was sent: ${next}`],
  trace_has: (v) => [appended.some((e) => e.customType === v), `entries: ${appended.map((e) => e.customType).join(",")}`],
};
let fail = 0;
for (const c of checks) {
  const [k, v] = Object.entries(c)[0];
  if (!test[k]) throw new Error(`unknown check ${k}`);
  const [ok, why] = test[k](v);
  console.log(`${ok ? "PASS" : "FAIL"} ${path.basename(dir)} ${k} ${JSON.stringify(v)}${ok ? "" : ` (${why})`}`);
  fail ||= !ok;
}
if (fail) console.log(`shown:\n${shown}${screen && `\nscreen:\n${screen}`}`);
process.exit(fail ? 1 : 0);
