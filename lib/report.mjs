// abalone report <session-file> [--include-text] [--title <t>] [--turn <n>] [--into <dir>]: an issue from the template in
// <dir>/tasks/issues/NNNN-<slug>.md and a replay fixture of turn n (default the last) in <dir>/tests/regress/NNNN/. Local files only;
// nothing is sent. User text, file contents and earlier replies are placeholders unless includeText.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.mjs";
import { inContent } from "./intools.mjs";

const text = (c) => typeof c === "string" ? c : c.filter((p) => p.type === "text").map((p) => p.text).join("");

export function report(sessionFile, { includeText = false, title = "untitled report", turn, into = ROOT } = {}) {
  const hide = (kind, s) => includeText ? s : `<${kind}, ${Buffer.byteLength(s)} bytes>`;
  const turns = [];
  let model = null, provider = null;
  for (const e of fs.readFileSync(sessionFile, "utf8").trim().split("\n").map(JSON.parse)) {
    const m = e.type === "message" ? e.message : null, steps = turns.at(-1)?.steps;
    if (m?.role === "user") turns.push({ user: hide("user text", text(m.content)), steps: [] });
    else if (!steps) continue;
    else if (m?.role === "assistant") {
      ({ provider, model } = m);
      const thinking = m.content.filter((c) => c.type === "thinking").map((c) => c.thinking).join("\n\n");
      steps.push({ model: text(m.content), ...(thinking && { thinking }), ...(m.stopReason !== "stop" && { stop: m.stopReason }), ...(m.errorMessage && { error: m.errorMessage }) });
    }
    else if (e.type === "custom_message") steps.push({ [e.customType]: e.customType === "abalone-tool" ? hide("tool result", text(e.content)) : text(e.content) });
    else if (e.type === "custom" && e.customType === "protocol-error") steps.push({ protocol_error: e.data.request });
  }
  if (turn) turns.splice(turn);
  if (!turns.length || turns.length < (turn ?? 0)) throw new Error(`${sessionFile} has no user turn ${turn ?? ""} to report`);
  for (const t of turns.slice(0, -1)) for (const s of t.steps) for (const k of ["model", "thinking"]) if (k in s) s[k] = hide(`model ${k === "model" ? "reply" : k}`, s[k]);
  const issues = path.join(into, "tasks", "issues"), regress = path.join(into, "tests", "regress");
  fs.mkdirSync(issues, { recursive: true });
  const n = String(1 + Math.max(0, ...[...fs.readdirSync(issues), ...(fs.existsSync(regress) ? fs.readdirSync(regress) : [])].map((f) => parseInt(f, 10)).filter(Number.isInteger))).padStart(4, "0");
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  const last = turns.at(-1).steps, replies = last.filter((s) => "model" in s), end = replies.at(-1);
  const fixture = { issue: n, source: path.basename(sessionFile), model: `${provider}/${model}`, protocol: inContent(provider) ? "intools" : "native", redacted: !includeText, turns };
  const dir = path.join(regress, n), issue = path.join(issues, `${n}-${slug}.md`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "fixture.json"), JSON.stringify(fixture, null, 1) + "\n");
  fs.writeFileSync(path.join(dir, "expect.json"), JSON.stringify({ issue: n, checks: [{ stop: "stop" }] }, null, 1) + "\n");
  fs.writeFileSync(issue, `# ${n}: ${title}

- **Reported:** ${new Date().toISOString().slice(0, 10)}, with abalone report, from session ${path.basename(sessionFile)}.
- **Status:** open.
- **Severity:** to fill.
- **Where:** model \`${fixture.model}\`, tool protocol ${fixture.protocol}.
- **Fixture:** \`tests/regress/${n}/\` (${includeText ? "user text and file contents included" : "user text and file contents redacted"}).

## Repro
\`tests/regress/run.sh\` replays turn ${turns.length}'s ${replies.length} recorded model replies through the stub provider.

## Observed
${replies.length} model call(s) in turn ${turns.length}; it ended with stop reason \`${end?.stop ?? "stop"}\`${end?.error ? `, error: \`${end.error}\`` : ""}. ${last.filter((s) => "protocol_error" in s).length} protocol-error entries.

## Expected
To fill.

## Causes
To fill.

## Fix acceptance
- [ ] \`tests/regress/${n}/expect.json\` states the expected behaviour, fails on the reported commit, and passes after the fix.
`);
  return { issue, fixture: dir };
}
