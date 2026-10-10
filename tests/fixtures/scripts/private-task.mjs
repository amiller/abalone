// A private agent for abalone-mcp: reads the corpus with the read tool, then answers. The task text
// steers it: LEAK puts a participant name in the answer, LONG makes the answer exceed max_bytes, PROSE answers
// metadata_only in prose. Otherwise it answers in the metadata_only JSON format.
export default (msgs) => {
  const task = JSON.stringify(msgs.filter((m) => m.role === "user").map((m) => m.content));
  const read = msgs.find((m) => m.role === "toolResult");
  if (!read) return { tool: "read", args: { path: "data/participants.csv" } };
  const rows = read.content.map((c) => c.text).join("").trim().split("\n").length - 1;
  if (task.includes("LEAK")) return { text: `About ${Math.round(rows / 10) * 10} rows; one is ${read.content[0].text.split("\n").find((l) => l.startsWith("P-1047"))}` };
  if (task.includes("LONG")) return { text: JSON.stringify({ files: [{ path: "data/wide.csv", columns: Array.from({ length: 100 }, (_, i) => ({ name: `column_${String.fromCharCode(97 + (i % 26), 97 + Math.floor(i / 26))}`, type: "integer" })) }] }) };
  if (task.includes("PROSE")) return { text: `The file has about ${Math.round(rows / 10) * 10} rows.` };
  return { text: JSON.stringify({ files: [{ path: "data/participants.csv", rows_about: Math.round(rows / 10) * 10 }] }) };
};
