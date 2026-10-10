// bash curl, then the probe tool twice, then report every tool result.
export default (msgs) => {
  const results = msgs.filter((m) => m.role === "toolResult").map((m) => m.content.map((c) => c.text).join(""));
  const steps = [
    { tool: "bash", args: { command: "curl -sS -m 5 https://example.com; echo curl_exit=$?; getent hosts example.com; echo getent_exit=$?; curl -sS -m 5 http://1.1.1.1; echo ip_exit=$?; ls $ABALONE_DIR ~/.abalone 2>&1 | head -3" } },
    { tool: "probe", args: { url: "https://example.com", host: "example.com" } },
    { tool: "probe", args: { url: "https://1.1.1.1", host: "tee.redpill.ai" } },
  ];
  return steps[results.length] ?? { text: "RESULTS\n" + results.join("\n---\n") };
};
