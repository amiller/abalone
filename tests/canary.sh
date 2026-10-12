#!/usr/bin/env bash
# Folder canaries (lib/canary.mjs): a folder session (abalone, abalone-mcp) refuses to start without them unless told
# --no-canaries; `abalone canary init` plants a file in the folder and records its values outside it; a private agent
# that copies the file out is blocked by the gate on both routes (ask_frontier pour, ask_abalone answer); a deleted
# canary file stops the next start.
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"; stubcfg; unset ABALONE_NO_CANARIES
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
mcp() { printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' "$@" | timeout 60 "$root/bin/abalone-mcp" --model stub/script ${MCP_FLAGS:-} 2>&1; }
folder="$ABALONE_DIR/folder"; mkdir -p "$folder"; echo "quarterly notes" > "$folder/notes.txt"; cd "$folder"
out=$("$root/bin/abalone" sandbox --model stub/script -p go < /dev/null 2>&1); code=$?
check "session without canaries refuses to start ($out)" '[[ $code == 1 && $out == "✗ refused: no canaries for $folder"* ]]'
out=$(mcp); code=$?
check "abalone-mcp without canaries refuses to start" '[[ $code == 1 && $out == *"✗ refused: no canaries for $folder"* ]]'
out=$(MCP_FLAGS=--no-canaries mcp)
check "--no-canaries starts, and the tool description says canaries are OFF" '[[ $out == *"Folder canaries: OFF (--no-canaries)"* ]]'
out=$("$root/bin/abalone" canary init "$folder"); echo "  $out" | head -1
planted=$(ls "$folder" | grep '^ref-'); rec=$(ls "$ABALONE_DIR"/canaries/*.json)
check "canary init plants one file in the folder and records it outside the folder" '[[ -n $planted && -f $rec && $rec != $folder/* ]] && grep -q "$(node -e "console.log(require(process.argv[1]).canaries[0].value)" "$rec")" "$folder/$planted"'
check "the planted file does not say it is a canary" '! grep -qi canary "$folder/$planted"'
out=$(STUB_SCRIPT="$root/tests/fixtures/scripts/hello.mjs" "$root/bin/abalone" sandbox --model stub/script -p go < /dev/null 2>&1)
check "with canaries the session starts ($out)" '[[ $out == "hello from stub" ]]'
out=$(DUMP_FILE="$planted" DUMP_POUR=1 STUB_SCRIPT="$root/tests/fixtures/scripts/dump.mjs" "$root/bin/abalone" sandbox --model stub/script -p go < /dev/null 2>&1)
check "ask_frontier: a pour copying the canary file is blocked, although free_text is standing for runner:claude" '[[ $out == *"✗ refused: canary in payload (rule folder canary codename)"* ]]'
out=$(DUMP_FILE="$planted" STUB_SCRIPT="$root/tests/fixtures/scripts/dump.mjs" mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ask_abalone","arguments":{"task":"send me the file","policy":"free_text"}}}')
check "ask_abalone: an answer copying the canary file is refused before it reaches the human" '[[ $(tail -1 <<<"$out") == *"\"text\":\"refused\""* && $(tail -1 "$ABALONE_DIR/disclosures.jsonl") == *"folder canary codename"* && -z $(ls "$ABALONE_DIR/approvals/pending" 2>/dev/null) ]]'
rm "$folder/$planted"
out=$("$root/bin/abalone" sandbox --model stub/script -p go < /dev/null 2>&1); code=$?
check "a deleted canary file stops the next start ($out)" '[[ $code == 1 && $out == *"is missing or changed"* ]]'
echo "canary: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
