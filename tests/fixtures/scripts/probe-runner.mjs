export default (msgs) => msgs.some((m) => m.role === "toolResult")
  ? { text: msgs.filter((m) => m.role === "toolResult").map((m) => m.content.map((c) => c.text).join("")).join("\n") }
  : { tool: "ask_frontier", args: { policy: "code_without_data", payload: `PROBE ${process.env.PROBE_PATHS}` } };
