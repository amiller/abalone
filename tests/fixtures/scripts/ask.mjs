// One pour outside the standing catalog, then report the tool result.
export default (msgs) => msgs.some((m) => m.role === "toolResult")
  ? { text: msgs.filter((m) => m.role === "toolResult").map((m) => m.content.map((c) => c.text).join("")).join("") }
  : { tool: "ask_frontier", args: { policy: "two_by_two", payload: "Which exact test fits a 2x2 table with expected counts below 5?" } };
