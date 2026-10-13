#!/usr/bin/env bash
# M2 end-to-end, live: the user's Claude Code (haiku, an open orchestrator) asks abalone-mcp about the
# private demo corpus; a private agent on an attested model reads it and answers under a catalog policy;
# the canary check runs over Claude Code's whole stream-json transcript. Uses the real ~/.abalone (configured keys).
# Usage: tests/demo-live.sh <provider/model> [gatewayTcb=reported]
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
model=${1:?model}; work="$(mktemp -d)"
if [[ ${2:-} == gatewayTcb=reported ]]; then
  export ABALONE_CONFIG="$work/config"; mkdir -p "$ABALONE_CONFIG/agents/pi"
  cp "$root/agents/pi/admitted.json" "$ABALONE_CONFIG/agents/pi/"; cp "$root/policy.json" "$ABALONE_CONFIG/"
  node -e 'const p=require(process.argv[1]);p.admitted.find(a=>a.id=="nearai").policy.gatewayTcb="reported";require("fs").writeFileSync(process.argv[2],JSON.stringify(p,null,1))' "$root/providers.json" "$ABALONE_CONFIG/providers.json"
fi
cfg=$(node -e 'console.log(JSON.stringify({mcpServers:{abalone:{command:process.argv[1]+"/bin/abalone-mcp",args:["--model",process.argv[2]],
  env:Object.fromEntries(["ABALONE_CONFIG","PATH","HOME"].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))}}}))' "$root" "$model")
cd "$root/local-data/demo-corpus"
since=$(date -u +%FT%T)
claude -p --model haiku --mcp-config "$cfg" --strict-mcp-config --tools "" --allowedTools mcp__abalone__ask_abalone --output-format stream-json --verbose \
  "Use the ask_abalone tool once, with policy aggregate_k and this task: 'Read data/participants.csv. How many participants are in each arm, and what is the mean baseline_isi per arm?'. Then report what it returned." \
  < /dev/null > "$work/claude-transcript.jsonl"
node -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")) { const e=JSON.parse(l);
  if (e.type==="user") for (const c of e.message.content) if (c.type==="tool_result") console.log("tool_result seen by Claude Code:", JSON.stringify(c.content).slice(0,400));
  if (e.type==="result") console.log("Claude Code result:", e.result.slice(0,400), "| cost $"+e.total_cost_usd); }' "$work/claude-transcript.jsonl"
node -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")) { const r=JSON.parse(l); if (r.ts>=process.argv[2] && r.via==="ask_abalone") console.log("disclosure:", JSON.stringify({label:r.label,policy:r.policy,bytes:r.bytes,from_place:r.from_place,attestation:r.attestation,refused:r.refused})) }' "${ABALONE_DIR:-$HOME/.abalone}/disclosures.jsonl" "$since"
node "$root/tests/canary-transcript.mjs" "$work/claude-transcript.jsonl"
