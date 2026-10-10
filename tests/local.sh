#!/usr/bin/env bash
# ⌂ local inference: a loopback OpenAI-compatible server answers a turn through the sandbox egress,
# and a local provider configured with a non-loopback host is refused.
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"; stubcfg
fail=0
node "$root/tests/fixtures/local-llm.mjs" > "$ABALONE_DIR/port" & srv=$!
trap 'kill $srv' EXIT
until [[ -s $ABALONE_DIR/port ]]; do sleep 0.1; done
port=$(cat "$ABALONE_DIR/port")
setlocal() { node -e 'const f=process.argv[1],p=JSON.parse(require("fs").readFileSync(f));p.local=[{id:"ollama",baseUrl:process.argv[2]}];require("fs").writeFileSync(f,JSON.stringify(p))' "$ABALONE_CONFIG/providers.json" "$1"; }
setlocal "http://127.0.0.1:$port/v1"
out=$("$root/bin/abalone" -p --model ollama/tiny "hi" < /dev/null 2>&1); echo "[loopback] $out"
[[ $out == *"hello from the local model"* ]] || fail=1
grep -q "\"via\":\"local\",\"host\":\"127.0.0.1:$port\"" "$ABALONE_DIR/egress.jsonl" && echo "  egress: via local 127.0.0.1:$port" || fail=1
setlocal "http://192.168.1.5:$port/v1"
out=$("$root/bin/abalone" -p --model ollama/tiny "hi" < /dev/null 2>&1); code=$?; echo "[non-loopback] exit=$code $out"
[[ $code -ne 0 && $out == *"is not on loopback"* ]] || fail=1
echo "local: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
