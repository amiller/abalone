#!/usr/bin/env bash
# The private sandbox's view (lib/sandbox.mjs piArgv), from the harness process itself, from bash, and through Pi's read
# tool: the folder is there; the rest of the host (/etc beyond CA certs and passwd, /srv, /var, /opt, ~/.ssh) is absent;
# the runner login dirs exist but are empty; approvals/ is read-only; the read tool refuses paths outside its read roots.
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"; stubcfg
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
folder="$ABALONE_DIR/folder"; mkdir -p "$folder"; echo "the private memo" > "$folder/memo.txt"
echo "runner token" > "$root/runner-home/test/marker"
hidden="/etc/hostname /etc/shadow /etc/ssh /srv /var/log /opt $HOME/.ssh $root/runner-home/test/marker"
cd "$folder"
out=$(PROBE_PATHS="$hidden $folder/memo.txt $root/runner-home/test /etc/ssl/certs/ca-certificates.crt" PROBE_WRITES="$ABALONE_DIR/approvals/standing.json $root/runner-home/test/w $folder/w" \
  PROBE_READS="memo.txt /etc/passwd ~/.abalone/node/keys.json $ABALONE_DIR/approvals/standing.json" \
  STUB_SCRIPT="$root/tests/fixtures/scripts/mounts.mjs" "$root/bin/abalone" sandbox --model stub/script -p go < /dev/null 2>&1); echo "$out" | sed 's/^/  /'
rm -f "$root/runner-home/test/marker"
host_w=$([[ -e $root/runner-home/test/w ]] && echo present || echo absent)
for p in $hidden; do check "harness and bash: $p absent" '[[ $out == *"
absent $p"* && $out == *"bash absent $p"* ]]'; done
check "harness: the folder, CA certificates and the (empty) runner login dir are there" '[[ $out == *"visible $folder/memo.txt"* && $out == *"visible /etc/ssl/certs/ca-certificates.crt"* && $out == *"visible $root/runner-home/test
"* ]]'
check "harness: approvals/ is read-only; a write to the runner login dir lands in a throwaway tmpfs, not the real login; the folder is writable" \
  '[[ $out == *"unwritable $ABALONE_DIR/approvals/standing.json EROFS"* && $host_w == absent && $out == *"wrote $folder/w"* ]]'
check "read tool: the folder is readable" '[[ $out == *"the private memo"* ]]'
check "read tool: /etc/passwd, the node keystore and approvals/ are refused by capability" '[[ $out == *"missing capability read(/etc/passwd)"* && $out == *"missing capability read($HOME/.abalone/node/keys.json)"* && $out == *"missing capability read($ABALONE_DIR/approvals/standing.json)"* ]]'
echo "mounts: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
