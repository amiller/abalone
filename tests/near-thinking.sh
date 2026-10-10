#!/usr/bin/env bash
# Live on NEAR (node key in ~/.abalone, a few hundredths of a cent): with no --model the session opens on providers.json
# "default" (nearai/z-ai/glm-5.3-flash), and with reasoning off by default GLM answers without a thinking block
# (near-provider sends chat_template_kwargs.enable_thinking=false; GLM still writes a short thought ending in </think>
# into the content, which near-provider passes on as reasoning).
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work=$(mktemp -d); cd "$work"
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
t0=$SECONDS
ABALONE_NO_CANARIES=1 node "$root/tests/session-drive.mjs" - "A train leaves at 3pm at 60 mph; another leaves the same station at 4pm at 80 mph on the same track. When does the second catch up? One sentence." > ev 2> err || cat err
secs=$((SECONDS - t0))
last='es.filter(e=>e.type==="message_end"&&e.message.role==="assistant").at(-1).message'
ev() { node -e 'const l=require("fs").readFileSync("ev","utf8").trim().split("\n").map(JSON.parse); console.log(eval("(es=>"+process.argv[1]+")")(l))' "$1"; }
echo "  model: $(ev "$last.provider+\"/\"+$last.model")  ${secs}s  answer: $(ev "$last.content.filter(c=>c.type===\"text\").map(c=>c.text).join(\"\")")"
check "with no --model the session uses the configured default, nearai/z-ai/glm-5.3-flash" '[[ $(ev "$last.provider+\"/\"+$last.model") == nearai/z-ai/glm-5.3-flash ]]'
check "reasoning off by default: the answer text holds no thinking (no </think>), and any short thought GLM still writes is a thinking block" '! ev "$last.content.filter(c=>c.type===\"text\").map(c=>c.text).join(\"\")" | grep -q "</think>" && [[ -n $(ev "$last.content.filter(c=>c.type===\"text\").map(c=>c.text).join(\"\")") ]]'
check "and it is short: under 300 output tokens" '[[ $(ev "$last.usage.output") -lt 300 ]]'
echo "near-thinking: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
