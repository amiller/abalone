#!/usr/bin/env bash
# The Claude Code side: the user's own `claude -p` (an open orchestrator) calls abalone-mcp, whose private
# agent (the stub model here) reads the demo corpus. The canary check then runs on Claude Code's full
# stream-json transcript. Uses the user's normal Claude Code login; spend is one short haiku session.
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"; stubcfg
cfg=$(node -e 'console.log(JSON.stringify({mcpServers:{abalone:{command:process.argv[1]+"/bin/abalone-mcp",args:["--model","stub/script"],
  env:{ABALONE_DIR:process.env.ABALONE_DIR,ABALONE_CONFIG:process.env.ABALONE_CONFIG,STUB_SCRIPT:process.argv[1]+"/tests/fixtures/scripts/private-task.mjs",PATH:process.env.PATH}}}}))' "$root")
cd "$root/local-data/demo-corpus"
claude -p --model haiku --mcp-config "$cfg" --strict-mcp-config --tools "" --allowedTools mcp__abalone__ask_abalone --output-format stream-json --verbose \
  "Call the ask_abalone tool once with policy metadata_only and the task 'How many rows does data/participants.csv have?'. Then tell me the answer it returned, verbatim." \
  < /dev/null > "$ABALONE_DIR/claude-transcript.jsonl"
node -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")) { const e=JSON.parse(l);
  if (e.type==="user") for (const c of e.message.content) if (c.type==="tool_result") console.log("  tool_result seen by Claude Code:", JSON.stringify(c.content).slice(0,200));
  if (e.type==="result") console.log("  result:", e.result.slice(0,200)); }' "$ABALONE_DIR/claude-transcript.jsonl"
node "$root/tests/canary-transcript.mjs" "$ABALONE_DIR/claude-transcript.jsonl"
