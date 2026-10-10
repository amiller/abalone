#!/usr/bin/env bash
# G4: understand a private downloaded file. abalone ask against the loopback reader stub (⌂ local), traced.
#   1. synthetic private PDF: statement before reading, cited answer, strip from runtime state, only the model endpoint contacted;
#   2. adversarial document: injected instructions, a tool call, a forged status strip with terminal escapes, a bogus citation;
#   3. a remote-placed model with no verifier output that claims to be verified.
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"; stubcfg
. "$root/tests/lib/reader.sh"
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
cd "$ABALONE_DIR"
q="By what date must I return the signed renewal form?"
strace -f -e trace=connect -o trace "$root/bin/abalone" ask --model ollama/reader "$root/tests/fixtures/docs/tenancy-renewal.pdf" "$q" < /dev/null > out1 2>&1
cat out1
check "statement (file, analysis place, workspace, sharing) printed before the file is read" \
  '[[ $(grep -n "^File:" out1 | cut -d: -f1) -lt $(grep -n "^Reading" out1 | cut -d: -f1) && $(grep -c "^Analysis: ollama/reader on this computer\|^Workspace: \|^Sharing: none" out1) == 3 ]]'
check "answer cites the deadline line (and a range in a comma list) and abalone quotes them from the file, a PDF's page marked as [page 1]" 'grep -q "\[L20\] \"To accept, sign and return the enclosed renewal form by 15 November" out1 && grep -q "^  \[L1\] \"\[page 1\]\"" out1'
flat() { sed -n "/^Status (from/,/^Saved:/p" "$1" | tr -s " \n" " "; }
"$root/bin/abalone" show evidence > ev1 2>&1; cat ev1
check "one-line strip reads runtime state; full evidence behind abalone show evidence" \
  '[[ $(flat out1) == *"Model: this computer (not attested) · Sharing: none · Credit: none used · details: abalone show evidence"* ]] && grep -q "Model: ollama/reader, this computer, local model (not attested)" ev1 && grep -q "Sharing: none (0 pours logged)" ev1'
check "a long path breaks after a slash, never inside a name" 'grep -q "tenancy-renewal.pdf (" out1'
check "80 columns, no escape bytes (no-color output)" '! awk "length > 80" out1 | grep -q . && ! grep -qP "\x1b|\r" out1'
echo "  endpoints (strace connect, launcher + sandbox): $(inet trace | tr '\n' ' ')"
echo "  egress.jsonl: $(node -e 'for (const l of require("fs").readFileSync("egress.jsonl","utf8").trim().split("\n")) { const e=JSON.parse(l); console.log(e.via, e.host) }' | sort | uniq -c | tr -s ' ' | tr '\n' ';')"
check "only the admitted model endpoint was contacted" '[[ $(inet trace) == "127.0.0.1:$port" ]] && ! grep -v "\"host\":\"127.0.0.1:$port\"" egress.jsonl | grep -q .'
check "the extraction workspace is removed" '! ls -d ws-* 2>/dev/null | grep -q .'

"$root/bin/abalone" ask --model ollama/reader "$root/tests/fixtures/docs/adversarial-report.txt" "How many heron pairs nested?" < /dev/null > out2 2>&1
cat -v out2
answer=$(sed -n '/^Answer (model output/,/^$/p' out2 | sed '1d;$d')
check "no ESC, CR or bidi override reaches the terminal" '! grep -qP "\x1b|\r|\x{202e}" out2'
check "every model line is prefixed; the forged strip appears only inside the answer" \
  '! grep -qv "^  | " <<<"$answer" && [[ $(grep -c "^Status (from" out2) == 1 ]] && ! grep -v "^  | " out2 | grep -q "nearai/big\|\$500"'
check "strip still reads runtime state" '[[ $(flat out2) == *"Model: this computer (not attested) · Sharing: none"* ]]'
check "a citation of a line that does not exist is flagged" 'grep -q "\[L999\] cited by the model, but the file has no such line" out2'
hist=$(ls -t notebook/history/*.jsonl | head -1)
check "the injected bash call did not run (tools off): Pi returned an error tool result" \
  'grep -q "\"toolName\":\"bash\".*\"isError\":true" "$hist" && ! find "$ABALONE_DIR" "$root/tests" -name pwned.txt | grep -q . && ! grep -q evil.example egress.jsonl'

STUB_SCRIPT="$root/tests/fixtures/scripts/claims-verified.mjs" "$root/bin/abalone" ask --model stub/script "$root/tests/fixtures/docs/adversarial-report.txt" "What is this?" < /dev/null > out3 2>&1
"$root/bin/abalone" show evidence > ev3 2>&1
grep "^Analysis\|Model:" out3 ev3
check "a remote model with no verifier output is shown NOT verified, whatever it says" '[[ $(flat out3) == *"Model: remote, NOT verified · "* ]] && grep -q "Model: stub/script, remote, NOT verified (no verifier output in this session)" ev3'
echo "private-work: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
