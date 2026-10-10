#!/usr/bin/env bash
# Live, no spend: a sealed /fetch of check.torproject.org/api/ip through abalone's built-in Tor (tor-js, Arti in
# WebAssembly). The answer must say IsTor: true. The first bootstrap can take a couple of minutes.
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"; stubcfg
export ABALONE_NO_CANARIES=1
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
mkdir -p "$ABALONE_DIR/work" && cd "$ABALONE_DIR/work"
CHOICES='["fetch via sealed route (Tor, built in)"]' DONE='^Fetched|failed|refused|timed out' TIMEOUT_MS=300000 node "$root/tests/command-drive.mjs" stub/script "/fetch https://check.torproject.org/api/ip" > ../ev 2>../err || cat ../err
node -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")) { const e=JSON.parse(l); if (e.method==="notify") console.log("  "+e.message) }' ../ev
cat ip 2>/dev/null; echo
check "the sealed route reached check.torproject.org through Tor (IsTor: true)" 'node -e "process.exit(JSON.parse(require(\"fs\").readFileSync(\"ip\",\"utf8\")).IsTor===true?0:1)"'
check "Tor state is kept in ABALONE_DIR/tor, mode 0700" '[[ $(stat -c %a "$ABALONE_DIR/tor") == 700 ]]'
check "the fetch is a disclosure on the sealed route" 'grep -q "\"via\":\"fetch\".*\"route\":\"sealed (Tor (built in))\"" "$ABALONE_DIR/disclosures.jsonl"'
echo "tor-live: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
