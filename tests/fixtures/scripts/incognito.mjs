// A stub-e2ee model for tests/incognito.sh: reads secret.txt and runs the folder's test with in-content tools, then
// answers with what came back (so the planted marker is in the model's own reply too). "context?" reports whether a
// reopened trace is in its context.
const text = (m) => typeof m.content === "string" ? m.content : m.content.filter((c) => c.type === "text").map((c) => c.text).join("");
export default (msgs) => {
  const last = text(msgs.filter((m) => m.role === "user").at(-1)), all = msgs.map(text).join("\n");
  if (last.includes("<abalone-result")) return { text: `Done. Results:\n${last}` };
  if (last.startsWith("mode?")) return { text: `incognito=${msgs.filter((m) => m.role === "system").map(text).join("").includes("STRICT INCOGNITO")}` };
  if (last.startsWith("context?")) return { text: `reopened=${all.includes("You unlocked trace")} marker=${(all.match(/MARK-[A-Z0-9]+/) ?? ["none"])[0]}` };
  return { text: `<tool_call>read\n<arg_key>path</arg_key>\n<arg_value>secret.txt</arg_value>\n</tool_call>\n<tool_call>bash\n<arg_key>command</arg_key>\n<arg_value>sh test.sh</arg_value>\n</tool_call>` };
};
