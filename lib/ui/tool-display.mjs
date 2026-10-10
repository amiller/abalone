// What the user sees of in-content tool use. Display only: model messages, parsing, execution and the session trace
// keep the raw protocol. Adapted from abalone-next-demo d376288 (lib/ui/tool-display.mjs).
const OPENERS = ["<abalone-tool>", "<tool_call>"];

// An assistant message without its tool-call blocks; while streaming, a half-written opening tag is held back too.
export function withoutToolProtocol(markdown, streaming = false) {
  let text = markdown.replace(/<abalone-tool>[\s\S]*?<\/abalone-tool>|<tool_call>[\s\S]*?<\/tool_call>/g, "").replace(/(?:<abalone-tool>|<tool_call>)[\s\S]*$/, "");
  if (streaming) for (let n = Math.min(14, text.length); n > 0; n--) if (OPENERS.some((t) => t.startsWith(text.slice(-n)))) { text = text.slice(0, -n); break; }
  return text.trimEnd();
}

const safe = (s) => String(s ?? "").replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-_])/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, "");
const json = (s) => { try { return JSON.parse(s); } catch { return null; } };

// One terminal state per request: Completed, Failed, Stopped (by Esc or /browser stop) or Not executed; then up to 5 lines of result.
export function outcome(output) {
  return /^not executed: stopped by the user|^error: .*aborted/i.test(output) ? "Stopped" : /^not executed|^blocked:/.test(output) ? "Not executed" : /^error:/.test(output) || /^exit [1-9]/.test(output) ? "Failed" : "Completed";
}
const TITLE = { list: (q) => `listed ${q.path ?? "."}`, read: (q) => `read ${q.path}`, grep: (q) => `searched ${q.path ?? "."} for "${q.pattern}"`, write: (q) => `wrote ${q.path}`,
  bash: (q) => `$ ${q.command}`, page: () => "read the browser tab", goto: (q) => `opened ${q.url}`, click: (q) => `clicked ${q.ref}`, type: (q) => `typed into ${q.ref}` };

export function toolDisplay(results, expanded = false) {
  return results.map(({ request, output }) => {
    const q = json(request) ?? {}, state = outcome(output);
    if (state === "Stopped") return safe(`Stopped by you: ${[q.op ?? "the tool request", q.url ?? q.ref ?? q.path ?? q.command].filter(Boolean).join(" ")} was cancelled`);
    const title = `${state} · ${(TITLE[q.op] ?? (() => q.op ?? "tool request"))(q)}`;
    const lines = safe(output).split("\n").filter((l, i, all) => l.trim() || (i && all[i - 1].trim()));
    const shown = expanded ? lines : lines.slice(0, 5);
    return `${safe(title)}\n${shown.map((l) => `  ${l}`).join("\n")}${!expanded && lines.length > shown.length ? `\n  … ${lines.length - shown.length} more lines · Ctrl+O to expand` : ""}`;
  }).join("\n\n");
}

// A trace reopened with --with-trace, as the session shows it: marked as earlier history, each turn shown the way a
// live turn is (answers without tool protocol, each tool request as its one-line outcome). The model gets the full text.
const said = (c) => safe(typeof c === "string" ? c : c.filter((p) => p.type === "text").map((p) => p.text).join("\n")).trim();
export function history(id, records) {
  const end = records.find((r) => r.t === "close");
  const lines = [`Earlier history: trace ${id}, reopened with --with-trace (${end ? `closed ${end.at.slice(0, 16).replace("T", " ")} UTC` : "not closed cleanly"}).`,
    "None of this is happening now. The model receives it with your next message."];
  for (const { t, e } of records) {
    if (t !== "entry") continue;
    const m = e.type === "message" ? e.message : null;
    if (m?.role === "user") lines.push("", `you: ${said(m.content)}`);
    if (m?.role === "assistant" && withoutToolProtocol(said(m.content))) lines.push(`abalone: ${withoutToolProtocol(said(m.content))}`);
    if (e.customType === "abalone-tool") lines.push(...(e.details?.results ?? []).map((r) => `  ${toolDisplay([r]).split("\n")[0]}`));
    if (e.customType === "abalone-note") lines.push(`  ${said(e.content)}`);
  }
  return lines.join("\n");
}
