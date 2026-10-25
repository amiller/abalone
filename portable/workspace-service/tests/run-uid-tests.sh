#!/bin/bash
# Actual separate-UID tests for the portable workspace authority split.
#
# These tests use REAL kernel identity separation: a user namespace whose
# uid/gid map (written via the setuid newuidmap/newgidmap helpers from the
# invoking user's /etc/subuid range) provides the harness with genuinely
# distinct uids for the UI, the agent service, an attacker and the credit
# account. Nothing here fakes a uid field; SO_PEERCRED, /proc ownership and
# filesystem permission checks are enforced by the kernel.
#
# SKIP (exit 0, explicit reason) when user namespaces, the setuid id-mapping
# helpers or a subordinate id range are unavailable — a skipped run is the
# honest result, never a faked pass. Guest qualification is separate work.
set -u

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"

say() { printf '%s\n' "$*"; }

# --- prerequisites ---------------------------------------------------------
command -v unshare >/dev/null 2>&1 || { say "SKIP: unshare is not available"; exit 0; }
command -v newuidmap >/dev/null 2>&1 || { say "SKIP: newuidmap (uidmap package) is not available"; exit 0; }
command -v newgidmap >/dev/null 2>&1 || { say "SKIP: newgidmap (uidmap package) is not available"; exit 0; }
command -v node >/dev/null 2>&1 || { say "SKIP: node is not available"; exit 0; }
command -v setpriv >/dev/null 2>&1 || { say "SKIP: setpriv is not available"; exit 0; }
node -e 'process.exit(process.getuid ? 0 : 1)' || { say "SKIP: node lacks uid support"; exit 0; }

uid="$(id -u)"
# First subordinate range with room for the identities the harness maps
# (inner uids 1..15 plus the mapped root).
range="$(grep "^$(id -un):" /etc/subuid 2>/dev/null | head -1)"
[ -n "$range" ] || range="$(awk -F: -v u="$uid" '$3 == u {print; exit}' /etc/subuid 2>/dev/null)"
[ -n "${range:-}" ] || { say "SKIP: no subordinate uid range in /etc/subuid for $(id -un)"; exit 0; }
base="$(printf '%s' "$range" | cut -d: -f2)"
count="$(printf '%s' "$range" | cut -d: -f3)"
[ "$count" -ge 32 ] || { say "SKIP: subordinate uid range too small (need >= 32, have $count)"; exit 0; }

# The namespace must actually be creatable (some hardened kernels refuse it),
# and a private tmpfs must be mountable inside it: uid-separation checks need
# a filesystem whose superblock belongs to the namespace, so the namespace
# root can chown fixture paths between the genuinely distinct uids.
unshare --user --mount true </dev/null 2>/dev/null || { say "SKIP: unprivileged user namespaces are not permitted on this kernel"; exit 0; }
probe="$(mktemp -d /tmp/portable-uid-probe.XXXXXX)"
unshare --user --map-root-user --mount bash -c "mount -n -t tmpfs none '$probe'" </dev/null 2>/dev/null || { rmdir "$probe" 2>/dev/null; say "SKIP: a private tmpfs cannot be mounted inside the user namespace on this kernel"; exit 0; }
rm -rf "${probe:?}"/.[!.]* "${probe:?}"/* 2>/dev/null; rmdir "$probe" 2>/dev/null

say "# launching uid-separation harness (outer uid $uid, subordinate base $base)"

# --- launch ----------------------------------------------------------------
# The harness runs on a namespace-private tmpfs (see above) and waits for its
# id map; the parent (running as the invoking user) writes the map with the
# setuid helpers, exactly like util-linux --map-auto does. A hard outer
# deadline with kill-after bounds the whole run: no wedged child can leave a
# live hang.
mountpoint="$(mktemp -d /tmp/portable-uid-split.XXXXXX)"
# The wrapper waits for the id map BEFORE exec'ing node: the exec-time
# capability grant for namespace root happens only when uid 0 is already
# mapped, and that grant is what makes chown between the genuinely distinct
# mapped uids a permitted kernel operation on the private tmpfs.
unshare --user --mount bash -c 'while [ "$(cat /proc/self/uid_map 2>/dev/null | tr -d " ")" = "" ]; do sleep 0.05; done; exec node "$2" "$1"' _ "$mountpoint" "$here/uid-harness.mjs" &
inner=$!
sleep 0.4
if ! newuidmap "$inner" 0 "$uid" 1 1 "$base" 31 2>/tmp/portable-uid-newuidmap.$$; then
  kill -9 "$inner" 2>/dev/null
  wait "$inner" 2>/dev/null; inner_rc=$?
  rmdir "$mountpoint" 2>/dev/null
  if [ "${inner_rc:-0}" = "42" ]; then
    say "SKIP: private tmpfs mount failed inside the namespace"
    exit 0
  fi
  say "FAIL: newuidmap refused the mapping (see below); this is an environment error, not a skip"
  cat /tmp/portable-uid-newuidmap.$$ >&2; rm -f /tmp/portable-uid-newuidmap.$$
  exit 1
fi
rm -f /tmp/portable-uid-newuidmap.$$
newgidmap "$inner" 0 "$(id -g)" 1 1 "$base" 31 2>/dev/null || { kill -9 "$inner" 2>/dev/null; say "FAIL: newgidmap refused the mapping"; exit 1; }

timeout_rc=0
deadline=$((SECONDS + 240))
while kill -0 "$inner" 2>/dev/null; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    kill -TERM "$inner" 2>/dev/null
    sleep 10
    kill -9 "$inner" 2>/dev/null
    timeout_rc=124
    break
  fi
  sleep 1
done
wait "$inner" 2>/dev/null
rc=$?
[ "$timeout_rc" -ne 0 ] && rc=$timeout_rc
rmdir "$mountpoint" 2>/dev/null || true
case $rc in
  0) say "# uid-separation harness: PASS" ;;
  42) say "SKIP: private tmpfs mount failed inside the namespace"; exit 0 ;;
  124|137) say "# uid-separation harness: TIMED OUT (hard deadline)" ;;
  *) say "# uid-separation harness: FAIL (exit $rc)" ;;
esac
exit "$rc"
