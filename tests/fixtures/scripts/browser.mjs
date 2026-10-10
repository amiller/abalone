// A model that uses the in-content browser ops: "browse <op> [json args]" asks for that op; a tool result is echoed back.
const text = (m) => typeof m.content === "string" ? m.content : m.content.filter((c) => c.type === "text").map((c) => c.text).join("");
export default (msgs) => {
  const sys = msgs.filter((m) => m.role === "system").map(text).join("\n"), last = text(msgs.filter((m) => m.role === "user").at(-1));
  if (last.includes("<abalone-result")) return { text: `result:\n${last}` };
  const m = last.match(/^browse (\w+)\s*(.*)$/s);
  if (m) return { text: `<abalone-tool>${JSON.stringify({ op: m[1], ...(m[2] ? JSON.parse(m[2]) : {}) })}</abalone-tool>` };
  return { text: `browser in prompt: ${/The browser: (.*)/.exec(sys)?.[1] ?? "none"}` };
};
