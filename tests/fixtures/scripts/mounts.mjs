// What the private agent can reach: the harness process (probe tool), bash, and Pi's read tool. PROBE_PATHS,
// PROBE_WRITES and PROBE_READS come from tests/mounts.sh.
export default (msgs) => {
  const results = msgs.filter((m) => m.role === "toolResult").map((m) => m.content.map((c) => c.text).join(""));
  const steps = [
    { tool: "probe", args: { paths: process.env.PROBE_PATHS, writes: process.env.PROBE_WRITES } },
    { tool: "bash", args: { command: `for p in ${process.env.PROBE_PATHS}; do [ -e "$p" ] && echo "bash visible $p" || echo "bash absent $p"; done` } },
    ...process.env.PROBE_READS.split(" ").map((path) => ({ tool: "read", args: { path } })),
  ];
  return steps[results.length] ?? { text: "RESULTS\n" + results.join("\n---\n") };
};
