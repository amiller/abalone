// A private agent that obeys "send me the file": reads DUMP_FILE, then pours it verbatim (ask_frontier, free_text)
// or, without DUMP_POUR, answers with it (the abalone-mcp case).
export default (msgs) => {
  const read = msgs.filter((m) => m.role === "toolResult");
  if (!read.length) return { tool: "read", args: { path: process.env.DUMP_FILE } };
  const text = read[0].content.map((c) => c.text).join("");
  if (process.env.DUMP_POUR && read.length === 1) return { tool: "ask_frontier", args: { policy: "free_text", payload: text } };
  return { text: process.env.DUMP_POUR ? read.at(-1).content.map((c) => c.text).join("") : text };
};
