#!/usr/bin/env bash
# abalone key: add (hidden stdin or a 0600 --input-file, validated, never in argv), list (never the key), forget; records
# are 0600 credit-store files; and a failing configured key is named and nothing else is tried (live redpill 401 with dummy keys; costs nothing).
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"; stubcfg
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
node "$root/tests/fixtures/fake-provider-auth.mjs" > "$ABALONE_DIR/port" & srv=$!
trap 'kill $srv' EXIT
until [[ -s $ABALONE_DIR/port ]]; do sleep 0.1; done
node -e 'const f=process.argv[1],p=JSON.parse(require("fs").readFileSync(f));p.admitted.push({...p.admitted[0],id:"fake",baseUrl:"http://127.0.0.1:"+process.argv[2]+"/v1"});require("fs").writeFileSync(f,JSON.stringify(p))' "$ABALONE_CONFIG/providers.json" "$(cat "$ABALONE_DIR/port")"
printf 'good-secret-1234\n' | "$root/bin/abalone" key add fake --label main > "$ABALONE_DIR/add.out" 2>&1 & add=$!
sleep 0.7
argv=$(for p in $(pgrep -P $add) $add ; do tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null; echo; done)
wait $add; echo "  argv during add: $(grep -m1 abalone.mjs <<<"$argv")"
check "add validates and stores the key" '[[ $(cat "$ABALONE_DIR/add.out") == "added fake key main: no local cap; the provider'"'"'s limit applies" ]]'
check "the key never appears in any argv during add" '[[ -n $argv && $argv != *good-secret* ]]'
out=$(printf 'bad-key-0000\n' | "$root/bin/abalone" key add fake --label other 2>&1); code=$?
check "an invalid key is an error ($out)" '[[ $code -ne 0 && $out == *"key rejected by fake: HTTP 401"* ]]'
out=$("$root/bin/abalone" key add fake good-secret-9999 < /dev/null 2>&1); code=$?
check "a key given as an argument is refused and not echoed" '[[ $code -ne 0 && $out == *"never from arguments"* && $out != *good-secret* ]]'
f="$ABALONE_DIR/key.txt"; printf 'good-secret-5678\n' > "$f"; chmod 644 "$f"
out=$("$root/bin/abalone" key add fake --label spare --input-file "$f" 2>&1); code=$?
check "--input-file must be 0600" '[[ $code -ne 0 && $out == *"mode 0600"* ]]'
chmod 600 "$f"; "$root/bin/abalone" key add fake --label spare --input-file "$f" > /dev/null; rm -f "$f"
out=$("$root/bin/abalone" key list); echo "$out" | sed 's/^/  /'
check "list: provider, label, added, last used, terms; never the key" '[[ $out == *"fake  main  added $(date -u +%F)  last used never  no local cap; the provider'"'"'s limit applies"* && $out == *"fake  spare"* && $out != *secret* && $out != *1234* ]]'
out=$("$root/bin/abalone" key forget fake 2>&1); code=$?
check "forget with several keys needs --label" '[[ $code -ne 0 && $out == *"name one with --label"* ]]'
"$root/bin/abalone" key forget fake --label main > /dev/null; out=$("$root/bin/abalone" key list)
check "forget removes it" '[[ $out != *main* && $out == *spare* ]]'
check "records and locks are mode 0600, one record left" '[[ $(stat -c %a "$ABALONE_DIR"/credit/*.json) == 600 && $(ls "$ABALONE_DIR"/credit | wc -l) == 2 ]]'
out=$("$root/bin/abalone" caps); check "abalone caps shows the configured key" '[[ $out == *"fake       configured key spare …5678 (no local cap; the provider'"'"'s limit applies)"* ]]'
unset ABALONE_CONFIG
printf dummy-aaaa | devkey redpill a; sleep 0.01; printf dummy-bbbb | devkey redpill b
out=$(cd "$ABALONE_DIR" && timeout 120 "$root/bin/abalone" sandbox -p --model redpill/z-ai/glm-5.2 hi < /dev/null 2>&1); code=$?
echo "  $(grep '✗ configured' <<<"$out")"
check "the newest key is used, a failure names it and nothing else is tried" '[[ $code -ne 0 && $out == *"✗ configured key redpill:b:bbbb failed: 401"*"No other key is tried"* && $out != *aaaa* ]]'
check "a used key records last used" '[[ $("$root/bin/abalone" key list) == *"redpill  b  added $(date -u +%F)  last used $(date -u +%F)"* ]]'
echo "keys: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
