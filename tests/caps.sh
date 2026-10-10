#!/usr/bin/env bash
# abalone caps: the capability matrix and the observer table, and every egress connection of a session
# (harness and runner) maps to a net capability in that table.
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"; stubcfg
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
out=$("$root/bin/abalone" caps); echo "$out" | sed 's/^/  /'
check "matrix has the private agent, bash, the runner and the MCP caller" '[[ $out == *"private-agent"*"bash ⌂ local"*"runner:claude ○ outside"*"mcp-caller ○ outside"* ]]'
check "observer table and guarantees_* set false" '[[ $out == *OBSERVERS*"Frontier vendor"* && $out == *"guarantees_confidentiality_against_operator: false"* && $out == *"direct_fallback: false"* ]]'
# The real config: provider handshakes from the harness, then the real claude binary in the runner sandbox.
unset ABALONE_CONFIG; devkey redpill t dummy; devkey phala t dummy
(cd "$ABALONE_DIR" && "$root/bin/abalone" --list-models < /dev/null > /dev/null 2>&1)
node "$root/tests/runner-claude.mjs" > /dev/null 2>&1
nets=$("$root/bin/abalone" caps --json | node -e 'const d=JSON.parse(require("fs").readFileSync(0));console.log(d.capabilities.filter(c=>c.action==="net").map(c=>c.object).join("\n"))')
hosts=$(node -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")) { const e=JSON.parse(l); if (e.allowed) console.log(e.host) }' "$ABALONE_DIR/egress.jsonl" | sort -u)
echo "  egress hosts: $(echo $hosts)"
check "every allowed connection maps to a net capability" '[[ -n $hosts ]] && ! grep -vxF -f <(echo "$nets") <<<"$hosts" | grep -q .'
echo "caps: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
