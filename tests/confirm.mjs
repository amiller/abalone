// A pour outside the policy asks through ctx.ui.confirm, showing the exact payload; yes sends it, no refuses it.
import fs from "node:fs";
import path from "node:path";
import { STATE } from "../lib/config.mjs";
import { runPrompt, assistantText } from "../lib/rpc.mjs";

const payload = "Which exact test fits a 2x2 table with expected counts below 5?";
let fail = 0;
for (const answer of [true, false]) {
  const asked = [];
  const { events } = await runPrompt({ args: ["--model", "stub/script"], message: "go", onUi: (r) => (asked.push(r), { confirmed: answer }),
    env: { ...process.env, STUB_SCRIPT: path.join(import.meta.dirname, "fixtures/scripts/ask.mjs") } });
  const last = fs.readFileSync(path.join(STATE, "disclosures.jsonl"), "utf8").trim().split("\n").map(JSON.parse).at(-1);
  const ok = asked.length === 1 && asked[0].message === payload && /policy two_by_two is not in the catalog/.test(asked[0].title)
    && (answer ? last.approval === "user" && /stub answer/.test(assistantText(events)) : last.approval === "refused" && /not approved/.test(assistantText(events)));
  console.log(`${ok ? "PASS" : "FAIL"} confirm=${answer}: asked ${asked.length}x "${asked[0]?.title}" message=exact payload:${asked[0]?.message === payload}; logged approval=${last.approval}; agent saw: ${assistantText(events).slice(0, 80)}`);
  fail ||= !ok;
}
process.exit(fail ? 1 : 0);
