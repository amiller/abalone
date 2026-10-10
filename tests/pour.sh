#!/usr/bin/env bash
# M2 ask_frontier (spawn:open through the gate), with the stub model and the stub runner:
# a standing pour goes out and is logged; after a hostile open answer, a wider pour is refused without
# asking; a canary blocks; private→outside without a pour is refused; every pour and spawn is logged;
# and the runner sandbox sees only the pour and reaches only the vendor's hosts.
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"; stubcfg
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
out=$(STUB_SCRIPT="$root/tests/fixtures/scripts/pour.mjs" "$root/bin/abalone" --model stub/script -p go < /dev/null 2>&1); echo "$out" | sed 's/^/  /'
d="$ABALONE_DIR/disclosures.jsonl"; a="$ABALONE_DIR/agents.jsonl"
field() { node -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")) console.log(eval("(r=>"+process.argv[2]+")")(JSON.parse(l)))' "$1" "$2"; }
field "$d" 'r.approval+" "+r.policy+" "+r.bytes+"B "+(r.refused??"")' | sed 's/^/  disclosures: /'
field "$a" 'r.event+" "+(r.domain??"")+" "+r.place+" "+(r.runner??r.model??"")+" parent="+r.parent.slice(0,8)' | sed 's/^/  agents: /'
check "standing pour went out and came back labelled open" '[[ $out == *"open (from runner:claude ○ outside"*"Fisher"* ]]'
check "hostile answer did not widen the next pour" '[[ $(sed -n 2p "$d") == *"\"refused\":\"widened after open content: aggregate_k (width 3) > previous width 2\""* ]]'
check "canary blocked" '[[ $(sed -n 3p "$d") == *"\"refused\":\"canary in payload (rule local-data/demo-corpus/canaries.json c-name)\""* ]]'
check "private→outside without a pour refused" '[[ $(sed -n 4p "$d") == *"private→outside without pour"* ]]'
check "4 releases logged, 1 released" '[[ $(wc -l < "$d") == 4 && $(grep -c "\"label\":\"released\"" "$d") == 1 ]]'
check "agents.jsonl: private root + exactly one open runner spawn, linked to its pour" '[[ $(grep -c "\"event\":\"spawn\"" "$a") == 2 && $(grep "\"event\":\"spawn\"" "$a" | sed -n 2p) == *"\"domain\":\"open\""*"\"pour\":\"$(field "$d" r.id | head -1)\""* ]]'
: > "$ABALONE_DIR/egress.jsonl"
out=$(PROBE_PATHS="$HOME $HOME/.ssh $root $root/local-data $ABALONE_DIR/private-out $ABALONE_DIR/agent" \
  STUB_SCRIPT="$root/tests/fixtures/scripts/probe-runner.mjs" "$root/bin/abalone" --model stub/script -p go < /dev/null 2>&1); echo "$out" | sed 's/^/  /'
check "runner: ~, ~/.ssh, the repo, the corpus, private-out and the agent dir are unreadable" '[[ $(grep -c "^readable" <<<"$out") == 0 && $(grep -c "^denied" <<<"$out") == 6 ]]'
check "runner: scratch holds only the pour" '[[ $(sed -n "/^denied/!{/^readable/!p}" <<<"$out" | sed -n 2p) == pour.md ]]'
check "runner: proxy admits api.anthropic.com, refuses example.com, no direct route" '[[ $out == *"proxy api.anthropic.com: 404"* && $out == *"proxy example.com: 000"* && $out == *"direct: exit=6"* ]]'
check "runner: claude is started with no tools, strict empty MCP config, no chrome" '[[ $out == *"args: -p --tools  --strict-mcp-config --no-chrome"* ]]'
check "runner egress: only api.anthropic.com allowed" '[[ $(grep -c "\"allowed\":true" "$ABALONE_DIR/egress.jsonl") -ge 1 && -z $(grep "\"allowed\":true" "$ABALONE_DIR/egress.jsonl" | grep -v api.anthropic.com) ]]'
out=$(ABALONE_DIR="$ABALONE_DIR/rc" node "$root/tests/runner-claude.mjs" 2>&1); echo "$out" | sed 's/^/  real claude: /'
check "real claude in the runner: no tools, no MCP servers (so no claude-in-chrome)" '[[ $out == *"init tools=[] mcp_servers=[]"* ]]'
check "real claude in the runner: connects only to api.anthropic.com" '[[ $out == *api.anthropic.com* && -z $(grep "\"via\":\"connect\"" <<<"$out" | grep -v "\"host\":\"api.anthropic.com\",\"allowed\":true") ]]'
echo "pour: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
