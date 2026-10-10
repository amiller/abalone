#!/usr/bin/env bash
# G5: the private notebook. Save (abalone ask), close (the process exits), reopen (new processes), search,
# navigate to the source line, record a decision, export, delete. Every notebook command runs under strace:
# none may open an inet socket, so neither the index nor any diagnostic leaves the machine.
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"; stubcfg
. "$root/tests/lib/reader.sh"
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
cd "$ABALONE_DIR"
nb() { echo "\$ abalone notebook $*" >> nb.out; strace -f -e trace=connect,sendto,sendmsg -o "trace.$(date +%s%N)" "$root/bin/abalone" notebook "$@" < /dev/null 2>&1 | tee -a nb.out; }

"$root/bin/abalone" ask --model ollama/reader --project lease "$root/tests/fixtures/docs/tenancy-renewal.pdf" "By what date must I return the signed renewal form?" < /dev/null > ask1 2>&1
"$root/bin/abalone" ask --model ollama/reader --project fieldwork "$root/tests/fixtures/docs/adversarial-report.txt" "How many heron pairs nested?" < /dev/null > ask2 2>&1
c=$(grep -oP '^Saved: \Kc-[0-9a-f]+' ask1); src=$(grep -oP '\(source \Ksrc-[0-9a-f]+' ask1)
check "saved a conclusion and its source" '[[ -n $c && -n $src ]]'
nb list > /dev/null
check "reopened: both projects and their sources are listed" 'grep -q "^Project lease" nb.out && grep -q "^Project fieldwork" nb.out && grep -q "$src tenancy-renewal.pdf: 1 questions, 3 quotes" nb.out'
nb decide "$c" "Return the form by 10 November; ask about the month-to-month rate first." > /dev/null
out=$(nb search renewal form November)
check "search returns the quote, the model conclusion, the decision and source lines, labelled apart" \
  'grep -q "^\[quote\] q-" <<<"$out" && grep -q "^\[model conclusion\] $c" <<<"$out" && grep -q "^\[your decision\] d-" <<<"$out" && grep -q "^\[source line\] $src:L20" <<<"$out"'
out=$(nb show "$c")
check "a conclusion shows its question, verification, answer and navigable sources" \
  'grep -q "Question: By what date" <<<"$out" && grep -q "Model: ollama/reader, this computer, local model (not attested)" <<<"$out" && grep -q "source: abalone notebook show $src:L20" <<<"$out" && grep -q "\[your decision\]" <<<"$out"'
out=$(nb show "$src:L20")
check "source navigation lands on the cited line of the stored source" 'grep -q "^> L20: To accept, sign and return the enclosed renewal form by 15 November 2026" <<<"$out"'
nb show "$(grep -oP '^\[quote\] \Kq-[0-9a-f]+' <<<"$(nb search November)" | head -1)" > /dev/null
nb export "$ABALONE_DIR/exported" > /dev/null
check "export holds records, sources, history and the index" '[[ -s exported/records.jsonl && -s exported/index.json && -n $(ls exported/sources) && -n $(ls exported/history) ]]'
nb rm "$src" > /dev/null
left=$(grep -rli brennecke --exclude-dir=config --exclude-dir=exported . | grep -v "^./trace\.\|^./nb.out\|^./ask1")
check "rm removes the source, its quotes, conclusion, decision, history and index entries" '[[ -z $left ]] && [[ $(nb search renewal November) == "no matches" ]] && grep -q "^\[source line\]" <<<"$(nb search heron)"'
echo "  leftover files mentioning the tenant: ${left:-none}"
n=$(ls trace.* | wc -l); inet_calls=$(cat trace.* | grep -c "AF_INET")
echo "  notebook commands traced: $n; inet socket calls: $inet_calls"
check "no notebook command opens an inet socket" '[[ $n -ge 8 && $inet_calls == 0 ]]'
check "the asks contacted only the loopback model" '! grep -v "\"host\":\"127.0.0.1:$port\"" egress.jsonl | grep -q .'
echo "--- transcript"; cat nb.out
check "notebook output fits 80 columns" '! awk "length > 80" nb.out | grep -v "^\$ abalone" | grep -q .'
echo "notebook: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
