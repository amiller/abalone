#!/usr/bin/env bash
# tests/regress/run.sh [NNNN...]: replay every tests/regress/NNNN fixture (or the ones named) (a report's recorded model replies, through a stub provider) and assert its expect.json.
set -uo pipefail
. "$(dirname "$0")/../lib/env.sh"; stubcfg
fail=0
for d in $([[ $# -gt 0 ]] && printf "$root/tests/regress/%s/ " "$@" || echo "$root"/tests/regress/[0-9]*/); do node "$root/tests/regress/check.mjs" "$d" || fail=1; done
echo "regress: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
