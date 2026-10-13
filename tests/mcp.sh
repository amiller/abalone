#!/usr/bin/env bash
# abalone-mcp, then the canary check on the caller's transcript.
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"; stubcfg
[[ -d $root/local-data/demo-corpus ]] || python3 "$root/skills/evals/pour-planning/make_corpus.py"
node "$root/tests/mcp.mjs" && node "$root/tests/canary-transcript.mjs" "$ABALONE_DIR/mcp-transcript.jsonl"
