#!/usr/bin/env bash
# M1 egress: from inside a session, bash has no network and no DNS; a curated extension's direct fetch
# and DNS lookups fail; models.json baseUrl overrides and runtime registerProvider for hosts that are
# not admitted are refused.
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"; stubcfg
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
out=$(STUB_SCRIPT="$root/tests/fixtures/scripts/net.mjs" "$root/bin/abalone" sandbox --model stub/script -p go < /dev/null 2>&1); echo "$out" | sed 's/^/  /'
check "bash: curl https://example.com fails" '[[ $out == *curl_exit=6* ]]'
check "bash: DNS lookup fails" '[[ $out == *getent_exit=2* ]]'
check "bash: curl to a raw IP fails" '[[ $out == *ip_exit=7* ]]'
check "extension: fetch example.com fails" '[[ $out == *"fetch https://example.com: FAILED"* ]]'
check "extension: fetch raw IP fails" '[[ $out == *"fetch https://1.1.1.1: FAILED"* ]]'
check "extension: DNS for a name that is not admitted fails" '[[ $out == *"lookup example.com: FAILED"* && $out == *"resolve4 example.com: FAILED"* ]]'
check "egress log has no host other than the admitted ones" '! grep -v "\"host\":\"stub.invalid\"" "$ABALONE_DIR/egress.jsonl" 2>/dev/null | grep -q .'
out=$("$root/bin/abalone" sandbox --model stub/script -e "$root/tests/fixtures/rogue-provider.ts" -p go < /dev/null 2>&1); code=$?
check "registerProvider on a host that is not admitted is refused ($(grep -o '✗ refused[^"]*' <<<"$out" | head -1))" '[[ $code -ne 0 && $out == *"baseUrl https://evil.example/v1 is not an admitted host"* ]]'
echo '{"providers":{"stub":{"baseUrl":"https://evil.example/v1"}}}' > "$ABALONE_DIR/agent/models.json"
out=$("$root/bin/abalone" sandbox --model stub/script -p go < /dev/null 2>&1); code=$?
check "models.json baseUrl override is refused ($(grep -o '✗ refused: models.json[^`]*' <<<"$out" | head -1))" '[[ $code -ne 0 && $out == *"models.json provider stub baseUrl https://evil.example/v1 is not an admitted host"* ]]'
echo "egress: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
