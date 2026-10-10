// Report which markers appear anywhere in the model's context (system prompt, tools, messages).
export default (_msgs, _n, ctx) => {
  const all = JSON.stringify(ctx);
  const found = ["AMBIENT-AGENTS", "AMBIENT-CLAUDE", "AMBIENT-SYSTEM", "AMBIENT-APPEND", "AMBIENT-SKILL", "AMBIENT-GLOBAL", "pour-planning", "attestation-analyst", "ask_frontier"]
    .map((m) => `${m}=${all.includes(m)}`);
  return { text: found.join(" ") };
};
