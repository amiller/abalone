#!/usr/bin/env bash
# abalone node keys: add (hidden stdin, validated, never in argv), list, use, rm, mode 0600; and a failing
# active key is named and nothing else is tried (live redpill 401 with dummy keys; costs nothing).
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"; stubcfg
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
node "$root/tests/fixtures/fake-provider-auth.mjs" > "$ABALONE_DIR/port" & srv=$!
trap 'kill $srv' EXIT
until [[ -s $ABALONE_DIR/port ]]; do sleep 0.1; done
node -e 'const f=process.argv[1],p=JSON.parse(require("fs").readFileSync(f));p.admitted.push({...p.admitted[0],id:"fake",baseUrl:"http://127.0.0.1:"+process.argv[2]+"/v1"});require("fs").writeFileSync(f,JSON.stringify(p))' "$ABALONE_CONFIG/providers.json" "$(cat "$ABALONE_DIR/port")"
printf 'good-secret-1234\n' | "$root/bin/abalone" node keys add fake main > "$ABALONE_DIR/add.out" 2>&1 & add=$!
sleep 0.7
argv=$(for p in $(pgrep -P $add) $add ; do tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null; echo; done)
wait $add; echo "  argv during add: $(grep -m1 abalone.mjs <<<"$argv")"
check "add validates and stores the key" '[[ $(cat "$ABALONE_DIR/add.out") == "added fake/main" ]]'
check "the key never appears in any argv during add" '[[ -n $argv && $argv != *good-secret* ]]'
out=$(printf 'bad-key-0000\n' | "$root/bin/abalone" node keys add fake other 2>&1); code=$?
check "an invalid key is an error ($out)" '[[ $code -ne 0 && $out == *"key rejected by fake: HTTP 401"* ]]'
printf 'good-secret-5678\n' | "$root/bin/abalone" node keys add fake spare > /dev/null
out=$("$root/bin/abalone" node keys list); echo "$out" | sed 's/^/  /'
check "list: provider, label, last 4, date, balance; first key active" '[[ $out == *"*  fake  main  …1234  $(date -u +%F)  balance: n/a"* && $out == *"   fake  spare  …5678"* && $out != *good-secret* ]]'
"$root/bin/abalone" node keys use fake spare; out=$("$root/bin/abalone" node keys list)
check "use switches the active key" '[[ $out == *"*  fake  spare"* && $out == *"   fake  main"* ]]'
"$root/bin/abalone" node keys rm fake main; out=$("$root/bin/abalone" node keys list)
check "rm removes it" '[[ $out != *main* && $out == *spare* ]]'
check "keys.json is mode 0600" '[[ $(stat -c %a "$ABALONE_DIR/node/keys.json") == 600 ]]'
out=$("$root/bin/abalone" caps); check "abalone caps shows the active key as node ⌂ dev (unattested)" '[[ $out == *"fake       node ⌂ dev (unattested) key spare …5678"* ]]'
unset ABALONE_CONFIG
devkey redpill a dummy-aaaa; devkey redpill b dummy-bbbb
out=$(cd "$ABALONE_DIR" && timeout 120 "$root/bin/abalone" -p --model redpill/z-ai/glm-5.2 hi < /dev/null 2>&1); code=$?
echo "  $(grep '✗ node' <<<"$out")"
check "a failing key is named and nothing else is tried" '[[ $code -ne 0 && $out == *"✗ node ⌂ dev key redpill:a:aaaa failed: 401"*"No other key is tried"* && $out != *bbbb* ]]'
echo "keys: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
