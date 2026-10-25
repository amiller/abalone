// A model that uses abalone's in-content tool protocol (stub-e2ee): it asks for a tool when the user's message calls
// for one, then answers from the result. It also reports what its system prompt says about who it is.
const text = (m) => typeof m.content === "string" ? m.content : m.content.filter((c) => c.type === "text").map((c) => c.text).join("");
export default (msgs) => {
  const sys = msgs.filter((m) => m.role === "system").map(text).join("\n"), last = text(msgs.filter((m) => m.role === "user").at(-1));
  const ask = (q) => ({ text: `Let me look.\n<abalone-tool>${JSON.stringify(q)}</abalone-tool>` });
  if (text(msgs.find((m) => m.role === "user")).startsWith("loop")) return ask({ op: "list", path: "." });
  // "write draft": writes draft.md on the first call, then every later call answers with the folder listing in the first message.
  if (text(msgs.find((m) => m.role === "user")).startsWith("write draft")) return msgs.some((m) => m.role === "assistant")
    ? { text: text(msgs.find((m) => m.role === "user")).match(/\[folder [^\n]*listed by abalone on this computer\][\s\S]*$/)[0] } : ask({ op: "write", path: "draft.md", content: "draft" });
  if (last.includes("<abalone-result")) return { text: `From abalone's tool result:\n${last}` };
  if (last.startsWith("what's in this folder")) return ask({ op: "list", path: "." });
  if (last.startsWith("summarize tenancy-renewal.txt")) return ask({ op: "read", path: "tenancy-renewal.txt" });
  if (last.startsWith("read outside")) return ask({ op: "read", path: "../agents.jsonl" });
  if (last.startsWith("read file ")) return ask({ op: "read", path: last.slice(10).split(/[\s[]/)[0] });
  if (last.startsWith("grep codename")) return ask({ op: "grep", pattern: "codename", path: "." });
  if (last.startsWith("mixed")) return { text: `<abalone-tool>{"op": "list"}</abalone-tool>\n<abalone-tool>{"op": "browser"}</abalone-tool>` };
  if (last.startsWith("glm native")) return { text: "<tool_call>list\n<arg_key>path</arg_key>\n<arg_value>.</arg_value>\n</tool_call>" };
  if (last.startsWith("malformed")) return { text: "<abalone-tool>{op: list}</abalone-tool>" };
  return { text: `system prompt: abalone=${sys.includes("You are abalone")} protocol=${sys.includes("<tool_call>OP")} usage=${sys.includes("Session usage, from abalone's accounting")} sentto=${sys.includes('"sent to" line from measured state')} pi=${/\bpi\b/i.test(sys.split(/\n\s*\n/, 1)[0])}` };
};
