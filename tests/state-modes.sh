#!/usr/bin/env bash
# Everything abalone writes under ABALONE_DIR is owner-only (files 0600, dirs 0700): logs, notebook, sessions,
# private-out, exports. Refused pours log a hash and byte count, never the payload. No run or ws-* dir outlives its process.
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"; stubcfg
. "$root/tests/lib/reader.sh"
export XDG_RUNTIME_DIR="$(mktemp -d -p "$XDG_RUNTIME_DIR")"   # this test's own, so other sessions' run dirs do not count
[[ -d $root/local-data/demo-corpus ]] || python3 "$root/evals/pour/make_corpus.py"
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
out=$(mktemp -d)
STUB_SCRIPT="$root/tests/fixtures/scripts/pour.mjs" "$root/bin/abalone" --model stub/script -p go < /dev/null > "$out/pour" 2>&1
"$root/bin/abalone" ask --model ollama/reader "$root/tests/fixtures/docs/tenancy-renewal.pdf" "By what date?" < /dev/null > "$out/ask" 2>&1
"$root/bin/abalone" notebook export "$ABALONE_DIR/exported" > "$out/export" 2>&1
node "$root/tests/mcp.mjs" > "$out/mcp" 2>&1
cd "$ABALONE_DIR"
for p in agents.jsonl disclosures.jsonl egress.jsonl notebook/records.jsonl notebook/index.json notebook/history notebook/sources private-out agent agent/sessions exported/records.jsonl; do
  [[ -e $p ]] || { echo "FAIL missing $p (see $out)"; fail=1; }
done
loose=$(find . \( -path ./config -o -path ./port \) -prune -o -perm /077 -printf '%m %p\n')
echo "  checked $(find . \( -path ./config -o -path ./port \) -prune -o -print | wc -l) paths; group/other-accessible: ${loose:-none}"
check "every file and directory abalone wrote is 0600/0700" '[[ -z $loose ]]'
refused=$(grep '"label":"refused"' disclosures.jsonl)
check "refused pours log payload_sha256 and bytes, never the payload" '[[ $(wc -l <<<"$refused") -ge 5 ]] && ! grep -q "\"payload\":" <<<"$refused" && [[ $(grep -c "\"payload_sha256\":\"[0-9a-f]\{64\}\"" <<<"$refused") -ge 4 ]]'
check "no run dir ($XDG_RUNTIME_DIR/abalone-*) or ws-* temp dir is left behind" '! ls -d "$XDG_RUNTIME_DIR"/abalone-* ws-* 2>/dev/null | grep -q .'
rm -rf "$XDG_RUNTIME_DIR"
echo "state-modes: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
