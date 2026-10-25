#!/bin/bash
# run-tests.sh — offline test suite for the portable storage slice.
#
# Uses ONLY injected fake executors (cryptsetup, lsblk, blkid, findmnt,
# mount, umount, fuser, ...) driven by a state directory: no host block
# device is opened, nothing is really mounted or formatted, no service is
# touched. To exercise the real production code paths (require_root, the
# trust chain, the lifecycle flock) the suite re-execs itself in an
# unprivileged user+mount namespace (unshare --user --map-root-user --mount)
# with a private tmpfs on /run — mapped-root with no host privilege. When
# namespaces are unavailable, root-mode tests are labelled SKIPPED, never
# faked.
#
# Usage: tests/run-tests.sh
set -uo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUEST="$SRC_DIR/guest"
TESTS="$SRC_DIR/tests"
UUID="12345678-1234-1234-1234-123456789abc"

PASS=0
FAIL=0
SKIPPED=0

ok()   { PASS=$((PASS + 1)); printf 'ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL %s %s\n' "$1" "${2:-}"; }
skip() { SKIPPED=$((SKIPPED + 1)); printf 'skip %s\n' "$1"; }
expect_rc() { # expect_rc <desc> <want> <got>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "(want rc=$2 got rc=$3)"; fi
}
expect_contains() { # expect_contains <desc> <haystack> <needle>
  case "$2" in *"$3"*) ok "$1" ;; *) bad "$1" "(missing: $3)" ;; esac
}
expect_lacks() { # expect_lacks <desc> <haystack> <needle>
  case "$2" in *"$3"*) bad "$1" "(unexpected: $3)" ;; *) ok "$1" ;; esac
}

# --- namespace bootstrap -------------------------------------------------------

if [ "${PORTABLE_TESTS_IN_NS:-0}" != "1" ]; then
  # Phase 0 (unprivileged, outside any namespace): the broker unit tests whose
  # REFUSAL cases are best proven with files owned by a real unprivileged uid
  # (owner-mismatch trust refusals are impossible to stage inside a
  # single-entry user namespace).
  printf 'phase 0: broker python tests (unprivileged run)\n'
  if python3 "$SRC_DIR/tests/test-broker.py" > "$SRC_DIR/tests/.phase0.log" 2>&1; then
    printf 'ok   broker: python unit tests (unprivileged refusals) passed\n'
  else
    cat "$SRC_DIR/tests/.phase0.log"
    printf 'FAIL broker: python unit tests (unprivileged refusals) failed\n'
    exit 1
  fi
  rm -f "$SRC_DIR/tests/.phase0.log"
  if unshare --user --map-root-user --mount true 2>/dev/null; then
    exec unshare --user --map-root-user --mount -- \
      env PORTABLE_TESTS_IN_NS=1 bash "$SRC_DIR/tests/run-tests.sh" "$@"
  fi
  printf 'SKIP: user+mount namespaces unavailable on this kernel/host.\n'
  printf '      Root-mode tests (trust chain, lifecycle lock, full script paths)\n'
  printf '      cannot run here; only parser-level checks would remain.\n'
  exit 77
fi

# Private /run (tmpfs) inside the namespace: real production paths
# (/run/portable-vault, /run/portable-control) are exercised with zero
# visibility outside the namespace.
mount -t tmpfs -o mode=0755 tmpfs /run || { echo "cannot mount private /run"; exit 1; }

python3 "$TESTS/test-deploy-accounts.py" || exit 1

WORK=/run/portable-storage-tests
rm -rf "$WORK"
mkdir -p "$WORK"
VBTESTS="$WORK/vbtests"
mkdir -p "$VBTESTS"

# --- staged deploy (as mapped root; the deployed tree is root-owned) -----------
STAGE="$WORK/opt"
bash "$GUEST/deploy.sh" --stage "$STAGE" >/dev/null 2>&1 \
  || { echo "FATAL: deploy --stage failed"; exit 1; }
BIN="$STAGE/bin"
ETC="$STAGE/etc"
CONF="$ETC/vault.conf"
sed -i "s/^VAULT_LUKS_UUID=\$/VAULT_LUKS_UUID=$UUID/" "$CONF"
chmod 0600 "$CONF"

# --- fake executor bin ----------------------------------------------------------
FAKEBIN="$WORK/fakebin"
mkdir -p "$FAKEBIN"
for t in cryptsetup lsblk blkid wipefs mkfs.ext4 findmnt mount umount fuser id chown mkdir chmod stat; do
  ln -sf "$TESTS/fake-runner.py" "$FAKEBIN/$t"
done

STATE="$WORK/state"
new_state() {
  rm -rf "$STATE"
  mkdir -p "$STATE"
}
setf() { printf '%s' "$2" > "$STATE/$1"; }   # setf <file> <content>
hasf() { [ -e "$STATE/$1" ]; }

STDIN_FILE=
reset_mp() { rm -rf /run/portable-vault; }
run_vault() { # run_vault <script-basename> [extra args...]
  local script="$1"; shift
  local redir=/dev/null
  if [ -n "${STDIN_FILE:-}" ]; then redir="$STDIN_FILE"; STDIN_FILE=; fi
  RUN_OUT="$(env FAKE_STATE="$STATE" PATH="$FAKEBIN:$PATH" \
    "$BIN/$script" --config "$CONF" "$@" < "$redir" 2>&1)"
  RUN_RC=$?
}

# Log entries carry {"tool": ..., "argv": [<argv WITHOUT the tool name>, ...]}.
calls() { # calls <tool> [cryptsetup-subcommand]: count matching invocations
  python3 - "$STATE/log" "$1" "${2:-}" <<'PYEOF2'
import json, sys
log, tool, sub = sys.argv[1], sys.argv[2], sys.argv[3]
n = 0
try:
    for line in open(log):
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("tool") != tool:
            continue
        if sub and (not e.get("argv") or e["argv"][0] != sub):
            continue
        n += 1
except OSError:
    pass
print(n)
PYEOF2
}
cryptsetup_calls() { calls cryptsetup "${1:-}"; }
tool_calls() { calls "$1"; }
stdin_hex_of() { # stdin_hex_of <subcommand> [nth=1]
  python3 - "$STATE/log" "$1" "${2:-1}" <<'EOF'
import json, sys
log, sub, nth = sys.argv[1], sys.argv[2], int(sys.argv[3])
n = 0
for line in open(log):
    try:
        e = json.loads(line)
    except Exception:
        continue
    if e.get("tool") == "cryptsetup" and e.get("argv") and e["argv"][0] == sub:
        n += 1
        if n == nth:
            print(e.get("stdin_hex", ""))
            sys.exit(0)
print("")
EOF
}
ts_of() { # ts_of <tool> [sub] [nth=1] : first timestamp of matching call
  python3 - "$STATE/log" "$1" "${2:-}" "${3:-1}" <<'EOF'
import json, sys
log, tool, sub, nth = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
n = 0
for line in open(log):
    try:
        e = json.loads(line)
    except Exception:
        continue
    if e.get("tool") != tool:
        continue
    if sub and (not e.get("argv") or e["argv"][0] != sub):
        continue
    n += 1
    if n == nth:
        print(e.get("ts", 0))
        sys.exit(0)
print(0)
EOF
}
wait_for_call() { # wait_for_call <tool> [sub] [timeout-s=5]: rc 0 once the log
  local tool="$1" sub="${2:-}" t="${3:-5}" n   # shows the call (BOUNDED wait)
  local deadline=$(( $(date +%s) + t ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    n="$(calls "$tool" "$sub")"
    [ "$n" -ge 1 ] && return 0
    sleep 0.1
  done
  return 1
}
wait_bounded() { # wait_bounded <pid> [timeout-s=10]: rc 0 once the process is
  local pid="$1" t="${2:-10}"    # gone (BOUNDED wait; never waits forever)
  local deadline=$(( $(date +%s) + t ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -0 "$pid" 2>/dev/null && return 1
  return 0
}

printf 'portable storage offline test suite (namespace mode, fake executors)\n\n'

# --- 1. syntax ------------------------------------------------------------------
for s in "$GUEST"/*.sh; do
  if bash -n "$s" 2>/dev/null; then ok "bash -n: $(basename "$s")"; else bad "bash -n: $(basename "$s")"; fi
done
python3 -c "import ast; ast.parse(open('$GUEST/vault-broker.py').read())" 2>/dev/null \
  && ok "python parse: vault-broker.py" || bad "python parse: vault-broker.py"

# --- 2. config parser: injection refusal (no eval, known keys only) --------------
PDIR="$WORK/parser"
mkdir -p "$PDIR"
run_load() { # run_load <config-file>: exit code of load_config in a subshell
  ( set -euo pipefail; umask 077; source "$GUEST/common.sh"; load_config "$1" ) >/dev/null 2>&1
  echo $?
}
# The review's PoC shape and friends: none of this may execute anything.
printf 'A]+x} ]; touch %s/marker; #=1\n' "$PDIR" > "$PDIR/inj1.conf"
printf 'X$(touch %s/marker)=1\n' "$PDIR" > "$PDIR/inj2.conf"
printf 'Y`touch %s/marker`=1\n' "$PDIR" > "$PDIR/inj3.conf"
printf 'VAULT_MAPPER_NAME=ok\nVAULT_MAPPER_NAME=ok2\n' > "$PDIR/dup.conf"
printf 'vault_mapper_name=lowercase\n' > "$PDIR/lower.conf"
printf 'VAULT_FSTYPE=ext9\n' > "$PDIR/badval.conf"
printf 'no-equals-sign-line\n' > "$PDIR/noeq.conf"
head -c 5000 /dev/zero | tr '\0' 'a' > "$PDIR/big.conf"
cp "$CONF" "$PDIR/good.conf"
for case_i in 1 2 3; do
  rc="$(run_load "$PDIR/inj$case_i.conf")"
  expect_rc "parser: injection config inj$case_i refused (EX_CONFIG)" 5 "$rc"
  if [ -e "$PDIR/marker" ]; then bad "parser: inj$case_i executed payload (marker exists)"; else ok "parser: inj$case_i no side effects"; fi
done
expect_rc "parser: duplicate key refused" 5 "$(run_load "$PDIR/dup.conf")"
expect_rc "parser: lowercase/unknown key refused" 5 "$(run_load "$PDIR/lower.conf")"
expect_rc "parser: bad value refused" 5 "$(run_load "$PDIR/badval.conf")"
expect_rc "parser: unparsable line refused" 5 "$(run_load "$PDIR/noeq.conf")"
expect_rc "parser: oversize config refused" 5 "$(run_load "$PDIR/big.conf")"
expect_rc "parser: pinned good config accepted" 0 "$(run_load "$PDIR/good.conf")"
# Whitespace/CRF alignment with the Python broker parser: NEITHER parser may
# accept a line the other refuses (no stripping in either).
printf ' VAULT_FSTYPE=ext4\n' > "$PDIR/lead.conf"
printf 'VAULT_MOUNT_OPTIONS=nodev,nosuid,noexec \n' > "$PDIR/trail.conf"
printf 'VAULT_MOUNT_SUBDIR_CREDIT=credit\r\n' > "$PDIR/crlf.conf"
expect_rc "parser: leading whitespace refused (bash/python aligned)" 5 "$(run_load "$PDIR/lead.conf")"
expect_rc "parser: trailing whitespace refused (bash/python aligned)" 5 "$(run_load "$PDIR/trail.conf")"
expect_rc "parser: CR/LF line refused (bash/python aligned)" 5 "$(run_load "$PDIR/crlf.conf")"

# --- 3. config trust chain (through the real production script) ------------------
new_state
chmod 0644 "$CONF"
run_vault unlock-vault.sh
expect_rc "trust: config mode 0644 refused by unlock (EX_CONFIG)" 5 "$RUN_RC"
expect_contains "trust: refusal names the mode problem" "$RUN_OUT" "mode"
[ "$(cryptsetup_calls)" = 0 ] && ok "trust: no cryptsetup call after config refusal" || bad "trust: cryptsetup called despite config refusal"
chmod 0600 "$CONF"

ln -sf "$CONF" "$ETC/link.conf"
RUN_OUT="$(env FAKE_STATE="$STATE" PATH="$FAKEBIN:$PATH" "$BIN/unlock-vault.sh" --config "$ETC/link.conf" 2>&1)"; RC=$?
expect_rc "trust: symlinked config refused" 5 "$RC"
rm -f "$ETC/link.conf"

chmod 0770 "$ETC"
run_vault unlock-vault.sh
expect_rc "trust: group-writable config dir refused" 5 "$RUN_RC"
chmod 0755 "$ETC"

new_state
ln -s "$WORK/evil-target" /run/portable-vault
run_vault unlock-vault.sh
expect_rc "unlock: symlinked mountpoint refused before any open (EX_PRECOND)" 6 "$RUN_RC"
[ "$(cryptsetup_calls open)" = 0 ] && ok "unlock: no open attempted for symlinked mountpoint" || bad "unlock: open attempted for symlinked mountpoint"
rm -f /run/portable-vault

# --- 3b. trust bootstrap: shared code is validated BEFORE it executes -------
# The entrypoints source common.sh; a tampered leaf (writable, symlinked,
# wrong-mode) must be refused BEFORE the source line — the appended payload
# must never run, even though the old code would also have exited 5 later.
TBIN="$WORK/tbin"
mk_tbin() { rm -rf "$TBIN"; cp -a "$BIN" "$TBIN"; }

new_state
mk_tbin
printf '\ntouch %s/tb-pwned\n' "$WORK" >> "$TBIN/common.sh"
chmod 0777 "$TBIN/common.sh"
RUN_OUT="$(env FAKE_STATE="$STATE" PATH="$FAKEBIN:$PATH" "$TBIN/unlock-vault.sh" --config "$CONF" 2>&1)"; RC=$?
expect_rc "bootstrap: world-writable common.sh refused BEFORE sourcing (EX_CONFIG)" 5 "$RC"
expect_contains "bootstrap: refusal names the mode problem" "$RUN_OUT" "mode"
if [ -e "$WORK/tb-pwned" ]; then bad "bootstrap: payload appended to writable common.sh EXECUTED"; else ok "bootstrap: payload in writable common.sh never executed"; fi
[ "$(cryptsetup_calls)" = 0 ] && ok "bootstrap: no cryptsetup call after pre-source refusal" || bad "bootstrap: cryptsetup ran despite pre-source refusal"

new_state
mk_tbin
rm -f "$TBIN/common.sh"
ln -s "$GUEST/common.sh" "$TBIN/common.sh"
RUN_OUT="$(env FAKE_STATE="$STATE" PATH="$FAKEBIN:$PATH" "$TBIN/lock-vault.sh" --config "$CONF" 2>&1)"; RC=$?
expect_rc "bootstrap: symlinked common.sh refused BEFORE sourcing" 5 "$RC"
expect_contains "bootstrap: refusal names the symlink" "$RUN_OUT" "symlink"

new_state
mk_tbin
chmod 0777 "$TBIN"
RUN_OUT="$(env FAKE_STATE="$STATE" PATH="$FAKEBIN:$PATH" "$TBIN/vault-status.sh" --config "$CONF" 2>&1)"; RC=$?
expect_rc "bootstrap: group/world-writable helper DIRECTORY refused" 5 "$RC"
expect_contains "bootstrap: refusal names the writable directory" "$RUN_OUT" "writable"

new_state
mk_tbin
reset_mp
printf 'x' > "$WORK/pass.txt"
RUN_OUT="$(env FAKE_STATE="$STATE" PATH="$FAKEBIN:$PATH" "$TBIN/unlock-vault.sh" --config "$CONF" < "$WORK/pass.txt" 2>&1)"; RC=$?
expect_rc "bootstrap: pristine staged copy still passes (normal deployment works)" 0 "$RC"
reset_mp

# --- 4. unlock scenarios -----------------------------------------------------------
new_state
setf OPEN_RC 1
printf 'wrong-key' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
run_vault unlock-vault.sh
expect_rc "unlock: wrong key refused (EX_VAULT)" 4 "$RUN_RC"
[ "$(cryptsetup_calls close)" = 0 ] && ok "unlock: wrong key did NOT close anything (no leftover existed)" || bad "unlock: wrong key closed a mapping that was not its leftover"
if hasf mapping; then bad "unlock: wrong key left a mapping file"; else ok "unlock: wrong key leaves no mapping"; fi

new_state
setf OPEN_RC 1
setf OPEN_LEAVE own
STDIN_FILE="$WORK/pass.txt"
run_vault unlock-vault.sh
expect_rc "unlock: own leftover after failed open -> EX_VAULT with cleanup" 4 "$RUN_RC"
[ "$(cryptsetup_calls close)" = 1 ] && ok "unlock: own leftover mapping closed exactly once" || bad "unlock: own leftover close count $(cryptsetup_calls close)"

new_state
setf OPEN_RC 1
setf OPEN_LEAVE foreign
STDIN_FILE="$WORK/pass.txt"
run_vault unlock-vault.sh
expect_rc "unlock: foreign leftover after failed open -> EX_VAULT, NOT closed" 4 "$RUN_RC"
[ "$(cryptsetup_calls close)" = 0 ] && ok "unlock: foreign leftover mapping not closed (not ours)" || bad "unlock: foreign leftover was closed"
hasf mapping && ok "unlock: foreign leftover mapping preserved" || bad "unlock: foreign leftover mapping vanished"

new_state
setf mapping "/dev/fake-vb
"
run_vault unlock-vault.sh
expect_rc "unlock: pre-existing WRONG mapper refused (EX_PRECOND), never closed" 6 "$RUN_RC"
[ "$(cryptsetup_calls close)" = 0 ] && ok "unlock: wrong existing mapper NOT closed" || bad "unlock: wrong existing mapper was closed"
[ "$(tool_calls mount)" = 0 ] && ok "unlock: wrong existing mapper NOT mounted" || bad "unlock: wrong existing mapper was mounted"
hasf mapping && ok "unlock: wrong existing mapper preserved" || bad "unlock: wrong existing mapper vanished"

new_state
printf '/dev/fake-va %s\n/dev/fake-vb %s\n' "$UUID" "$UUID" > "$STATE/lsblk.uuidmap"
run_vault unlock-vault.sh
expect_rc "unlock: duplicate UUID devices refused" 6 "$RUN_RC"
[ "$(cryptsetup_calls open)" = 0 ] && ok "unlock: no open with duplicate UUIDs" || bad "unlock: opened despite duplicate UUIDs"

new_state
printf 'correct horse battery staple' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
run_vault unlock-vault.sh
expect_rc "unlock: happy path" 0 "$RUN_RC"
EXPECT_HEX="$(od -An -v -tx1 "$WORK/pass.txt" | tr -d ' \n')"
GOT_HEX="$(stdin_hex_of open)"
[ "$GOT_HEX" = "$EXPECT_HEX" ] && ok "unlock: passphrase bytes fed to cryptsetup EXACTLY (stdin hex match)" || bad "unlock: passphrase bytes mismatch ($GOT_HEX != $EXPECT_HEX)"
hasf mapping && ok "unlock: mapping active after unlock" || bad "unlock: mapping missing after unlock"
hasf mount && ok "unlock: mounted after unlock" || bad "unlock: mount missing after unlock"
for d in credit agent ui; do
  [ -d "/run/portable-vault/$d" ] && ok "unlock: per-account dir $d created" || bad "unlock: per-account dir $d missing"
done
expect_contains "unlock: state line reports unlocked" "$RUN_OUT" "state: mapping=active mounted=yes"
reset_mp

# per-account directory verification: existing dirs with wrong mode/owner are
# refused (never silently claimed as 0700 protection), with own-state cleanup.
new_state
mkdir -p -m 0755 /run/portable-vault/credit
printf 'x' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
run_vault unlock-vault.sh
expect_rc "unlock: existing per-account dir with wrong mode refused (EX_PRECOND)" 6 "$RUN_RC"
expect_contains "unlock: wrong-mode dir refusal reports it" "$RUN_OUT" "mode"
[ "$(cryptsetup_calls close)" = 1 ] && ok "unlock: refusal cleaned up own mapping (close)" || bad "unlock: wrong-mode dir did not close own mapping"
[ "$(tool_calls umount)" = 1 ] && ok "unlock: refusal cleaned up own mount (umount)" || bad "unlock: wrong-mode dir did not unmount own mount"
reset_mp

new_state
mkdir -p -m 0700 /run/portable-vault/agent   # right mode, owner root (not portable-agent)
printf 'x' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
run_vault unlock-vault.sh
expect_rc "unlock: existing per-account dir with wrong OWNER refused" 6 "$RUN_RC"
reset_mp

new_state
setf mapping "/dev/fake-va
"
setf mount "/dev/mapper/portable-vault ext4 nodev,nosuid,noexec shared
"
STDIN_FILE=/dev/null
run_vault unlock-vault.sh
expect_rc "unlock: already-unlocked is idempotent" 0 "$RUN_RC"
[ "$(cryptsetup_calls open)" = 0 ] && ok "unlock: idempotent path does not reopen" || bad "unlock: idempotent path reopened"

new_state
setf mapping "/dev/fake-va
"
setf mount "/dev/other-device ext4 nodev,nosuid,noexec shared 259:0
"
STDIN_FILE=/dev/null
run_vault unlock-vault.sh
expect_rc "unlock: unrelated mount (different DEVICE identity) at mountpoint refused" 6 "$RUN_RC"
[ "$(tool_calls umount)" = 0 ] && ok "unlock: unrelated mount NOT unmounted" || bad "unlock: unrelated mount was unmounted"
[ "$(cryptsetup_calls close)" = 0 ] && ok "unlock: unrelated mount did not close the mapping" || bad "unlock: unrelated mount closed the mapping"

new_state
setf mapping "/dev/fake-va
"
# Same SOURCE STRING as the mapper but a different kernel device: only the
# major:minor comparison rejects this (same-string/same-label mounts).
setf mount "/dev/mapper/portable-vault ext4 nodev,nosuid,noexec shared 259:0
"
STDIN_FILE=/dev/null
run_vault unlock-vault.sh
expect_rc "unlock: same-string mount on a DIFFERENT device refused" 6 "$RUN_RC"
[ "$(tool_calls umount)" = 0 ] && ok "unlock: same-string foreign mount NOT unmounted" || bad "unlock: same-string foreign mount was unmounted"

new_state
setf mapping "/dev/fake-va
"
setf mount "/dev/mapper/portable-vault ext4 nodev,nosuid,relatime shared 253:0
"
STDIN_FILE=/dev/null
run_vault unlock-vault.sh
expect_rc "unlock: mount missing a mandatory option (noexec) refused" 6 "$RUN_RC"
reset_mp

new_state
setf ACCOUNTS "portable-agent portable-ui"
printf 'x' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
run_vault unlock-vault.sh
expect_rc "unlock: missing account refused BEFORE any open (preflight)" 6 "$RUN_RC"
[ "$(cryptsetup_calls open)" = 0 ] && ok "unlock: no open with missing account" || bad "unlock: opened despite missing account"

# --- 4b. failure cleanup: ordinary post-open errors are never bypassed -------
# ENOSPC/EIO-class failures (mkdir/chmod/stat/chown/mount) after a successful
# open must clean up ONLY this operation's resources and end with a truthful
# observed mapping/mount state — not exit silently via set -e.

new_state
reset_mp
setf MKDIR_RC 1
printf 'x' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
run_vault unlock-vault.sh
expect_rc "cleanup: mountpoint mkdir failure -> EX_VAULT with cleanup" 4 "$RUN_RC"
[ "$(cryptsetup_calls close)" = 1 ] && ok "cleanup: mkdir failure closed own mapping" || bad "cleanup: mkdir failure did not close own mapping"
[ "$(tool_calls umount)" = 0 ] && ok "cleanup: mkdir failure had nothing to unmount" || bad "cleanup: mkdir failure unmounted something"
expect_contains "cleanup: mkdir failure reports truthful state" "$RUN_OUT" "state after cleanup: mapping=no mounted=no"
reset_mp

new_state
mkdir -p /run/portable-vault   # mountpoint exists: failure moves into ensure_dir
setf MKDIR_RC 1
printf 'x' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
run_vault unlock-vault.sh
expect_rc "cleanup: per-account mkdir failure -> EX_VAULT with cleanup" 4 "$RUN_RC"
[ "$(tool_calls umount)" = 1 ] && ok "cleanup: per-account mkdir failure unmounted own mount" || bad "cleanup: per-account mkdir failure left own mount"
[ "$(cryptsetup_calls close)" = 1 ] && ok "cleanup: per-account mkdir failure closed own mapping" || bad "cleanup: per-account mkdir failure left own mapping"
expect_contains "cleanup: per-account mkdir failure truthful state" "$RUN_OUT" "state after cleanup: mapping=no mounted=no"
reset_mp

new_state
reset_mp
setf CHMOD_RC 1
printf 'x' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
run_vault unlock-vault.sh
expect_rc "cleanup: mountpoint chmod failure -> EX_VAULT with cleanup" 4 "$RUN_RC"
[ "$(cryptsetup_calls close)" = 1 ] && ok "cleanup: chmod failure closed own mapping" || bad "cleanup: chmod failure did not close own mapping"
expect_contains "cleanup: chmod failure truthful state" "$RUN_OUT" "state after cleanup: mapping=no mounted=no"
reset_mp

new_state
reset_mp
setf MOUNT_RC 1
printf 'x' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
run_vault unlock-vault.sh
expect_rc "cleanup: mount failure after open -> EX_VAULT with cleanup" 4 "$RUN_RC"
[ "$(cryptsetup_calls close)" = 1 ] && ok "cleanup: mount failure closed own mapping" || bad "cleanup: mount failure left own mapping"
[ "$(tool_calls umount)" = 0 ] && ok "cleanup: mount failure unmounted nothing (none existed)" || bad "cleanup: mount failure unmounted something"
expect_contains "cleanup: mount failure truthful state" "$RUN_OUT" "state after cleanup: mapping=no mounted=no"
reset_mp

new_state
reset_mp
setf CHOWN_RC 1
printf 'x' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
run_vault unlock-vault.sh
expect_rc "cleanup: chown failure after mount -> EX_PRECOND with cleanup" 6 "$RUN_RC"
[ "$(tool_calls umount)" = 1 ] && ok "cleanup: chown failure unmounted own mount" || bad "cleanup: chown failure left own mount"
[ "$(cryptsetup_calls close)" = 1 ] && ok "cleanup: chown failure closed own mapping" || bad "cleanup: chown failure left own mapping"
expect_contains "cleanup: chown failure truthful state" "$RUN_OUT" "state after cleanup: mapping=no mounted=no"
reset_mp

new_state
reset_mp
mkdir -p -m 0700 /run/portable-vault/credit   # existing dir: ensure_dir VERIFIES it
printf '/run/portable-vault/credit\n' > "$STATE/stat.failpath"
printf 'x' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
run_vault unlock-vault.sh
expect_rc "cleanup: stat (I/O) failure on existing dir -> EX_PRECOND with cleanup" 6 "$RUN_RC"
expect_contains "cleanup: stat failure reported" "$RUN_OUT" "cannot stat"
[ "$(tool_calls umount)" = 1 ] && ok "cleanup: stat failure unmounted own mount" || bad "cleanup: stat failure left own mount"
[ "$(cryptsetup_calls close)" = 1 ] && ok "cleanup: stat failure closed own mapping" || bad "cleanup: stat failure left own mapping"
reset_mp

new_state
reset_mp
setf CHOWN_RC 1
setf UMOUNT_RC 1
setf CLOSE_RC 1
printf 'x' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
run_vault unlock-vault.sh
expect_rc "cleanup: failing umount+close -> EX_PRECOND, state preserved visibly" 6 "$RUN_RC"
expect_contains "cleanup: failed unmount warns, never forces" "$RUN_OUT" "WARNING"
expect_contains "cleanup: failed cleanup reports TRUTHFUL remaining state" "$RUN_OUT" "state after cleanup: mapping=active mounted=yes"
hasf mount && ok "cleanup: failed unmount left the mount visible" || bad "cleanup: mount vanished despite umount failure"
hasf mapping && ok "cleanup: failed close left the mapping visible" || bad "cleanup: mapping vanished despite close failure"
reset_mp

# --- 4c. signals: interrupted opens still clean up only their own resources --
new_state
reset_mp
setf OPEN_SLEEP 2
printf 'p1' > "$WORK/pass.txt"
env FAKE_STATE="$STATE" PATH="$FAKEBIN:$PATH" "$BIN/unlock-vault.sh" --config "$CONF" \
  < "$WORK/pass.txt" > "$WORK/sig1.out" 2>&1 & SPID=$!
if wait_for_call cryptsetup open 5; then ok "signal fixture: open started"; else bad "signal fixture: open never started"; fi
kill -TERM "$SPID" 2>/dev/null
if wait_bounded "$SPID" 8; then
  wait "$SPID"; SRC=$?
  SIG1_OUT="$(cat "$WORK/sig1.out")"
  expect_rc "signal: TERM during open -> EX_VAULT after deferred cleanup" 4 "$SRC"
  [ "$(cryptsetup_calls close)" = 1 ] && ok "signal: interrupted open's leftover mapping closed" || bad "signal: interrupted open leftover not closed"
  expect_contains "signal: interrupted open reports truthful state" "$SIG1_OUT" "state after cleanup: mapping=no mounted=no"
else
  kill -KILL "$SPID" 2>/dev/null; wait "$SPID" 2>/dev/null
  bad "signal: TERM during open did not exit within bound"
fi
reset_mp

new_state
reset_mp
setf MOUNT_SLEEP 2
printf 'p1' > "$WORK/pass.txt"
env FAKE_STATE="$STATE" PATH="$FAKEBIN:$PATH" "$BIN/unlock-vault.sh" --config "$CONF" \
  < "$WORK/pass.txt" > "$WORK/sig2.out" 2>&1 & SPID=$!
if wait_for_call mount "" 5; then ok "signal fixture: mount started"; else bad "signal fixture: mount never started"; fi
kill -TERM "$SPID" 2>/dev/null
if wait_bounded "$SPID" 8; then
  wait "$SPID"; SRC=$?
  SIG2_OUT="$(cat "$WORK/sig2.out")"
  expect_rc "signal: TERM during mount -> EX_VAULT after deferred cleanup" 4 "$SRC"
  [ "$(tool_calls umount)" = 1 ] && ok "signal: interrupted mount was unmounted by cleanup" || bad "signal: interrupted mount left mounted"
  [ "$(cryptsetup_calls close)" = 1 ] && ok "signal: interrupted mount's mapping closed" || bad "signal: interrupted mount left mapping"
  expect_contains "signal: interrupted mount reports truthful state" "$SIG2_OUT" "state after cleanup: mapping=no mounted=no"
else
  kill -KILL "$SPID" 2>/dev/null; wait "$SPID" 2>/dev/null
  bad "signal: TERM during mount did not exit within bound"
fi
reset_mp

# --- 5. lock scenarios --------------------------------------------------------------
state_unlocked() {
  reset_mp
  new_state
  printf 'x' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
  run_vault unlock-vault.sh >/dev/null 2>&1
  [ "$RUN_RC" = 0 ] || { bad "lock fixture: unlock failed rc=$RUN_RC"; return 1; }
}
if state_unlocked; then
  setf FUSER_RC 0
  run_vault lock-vault.sh
  expect_rc "lock: busy (writers active) -> EX_BUSY" 3 "$RUN_RC"
  [ "$(tool_calls umount)" = 0 ] && ok "lock: busy leaves mount in place (no umount)" || bad "lock: busy path unmounted"
  [ "$(cryptsetup_calls close)" = 0 ] && ok "lock: busy leaves mapping active" || bad "lock: busy path closed mapping"
  hasf mount && ok "lock: busy vault remains visibly unlocked (mount present)" || bad "lock: busy vault lost its mount"

  new_state
  setf mapping "/dev/fake-vb
"
  setf mount "/dev/mapper/portable-vault ext4 nodev,nosuid,noexec shared
"
  setf FUSER_RC 0
  run_vault lock-vault.sh
  expect_rc "lock: wrong-backing mapper refused, never unmounted/closed" 6 "$RUN_RC"
  [ "$(tool_calls umount)" = 0 ] && ok "lock: wrong mapper not unmounted" || bad "lock: wrong mapper unmounted"
  [ "$(cryptsetup_calls close)" = 0 ] && ok "lock: wrong mapper not closed" || bad "lock: wrong mapper closed"

  if state_unlocked; then
    setf FUSER_RC 1
    run_vault lock-vault.sh
    expect_rc "lock: happy path locks" 0 "$RUN_RC"
    hasf mapping && bad "lock: mapping still active after lock" || ok "lock: mapping closed"
    hasf mount && bad "lock: mount still present after lock" || ok "lock: mount gone"
    expect_contains "lock: state line reports locked" "$RUN_OUT" "state: mapping=no mounted=no"
  fi

  new_state
  run_vault lock-vault.sh
  expect_rc "lock: already locked is idempotent" 0 "$RUN_RC"
fi

# --- 5b. lock interruption + structured status states ------------------------------
# Interrupted lock never forces anything: it reports the state it reached.
new_state
setf mapping "/dev/fake-va
"
setf mount "/dev/mapper/portable-vault ext4 nodev,nosuid,noexec shared 253:0
"
setf FUSER_RC 0
( umask 077; flock -x /run/.portable-vault-lifecycle.lock -c 'sleep 3' ) & HOLDPID=$!
sleep 0.3
env FAKE_STATE="$STATE" PATH="$FAKEBIN:$PATH" "$BIN/lock-vault.sh" --config "$CONF" \
  > "$WORK/siglock.out" 2>&1 & LPID=$!
# Wait until lock-vault has OPENED the lifecycle lock fd (bounded): only then
# is it past startup and genuinely waiting for the lock, so the TERM tests
# the waiting state rather than the pre-trap startup window.
LPLOCKED=no
LDEADLINE=$(( $(date +%s) + 8 ))
while [ "$(date +%s)" -lt "$LDEADLINE" ]; do
  [ -e "/proc/$LPID/fd/9" ] && { LPLOCKED=yes; break; }
  kill -0 "$LPID" 2>/dev/null || break
  sleep 0.05
done
[ "$LPLOCKED" = yes ] && ok "lock signal fixture: lock-vault waiting on the lifecycle lock" || bad "lock signal fixture: never reached the lock wait"
kill -TERM "$LPID" 2>/dev/null
if wait_bounded "$LPID" 10; then
  wait "$LPID"; LRC=$?
  SIGLOCK_OUT="$(cat "$WORK/siglock.out")"
  expect_rc "lock signal: TERM while waiting -> EX_VAULT, never forced" 4 "$LRC"
  expect_contains "lock signal: interruption reports the reached state" "$SIGLOCK_OUT" "interrupted by signal"
  expect_contains "lock signal: state line is truthful" "$SIGLOCK_OUT" "mapping=active mounted=yes"
else
  kill -KILL "$LPID" 2>/dev/null; wait "$LPID" 2>/dev/null
  bad "lock signal: TERM did not exit within bound"
fi
wait "$HOLDPID" 2>/dev/null
[ "$(cryptsetup_calls close)" = 0 ] && ok "lock signal: nothing was closed" || bad "lock signal: closed something despite interruption"
[ "$(tool_calls umount)" = 0 ] && ok "lock signal: nothing was unmounted" || bad "lock signal: unmounted something despite interruption"

# status: the FINAL state line reflects identity + exact mount, never a
# single fact. Foreign mapper must be state: unsafe (exit 6), not unlocked.
new_state
setf mapping "/dev/fake-vb
"
setf mount "/dev/mapper/portable-vault ext4 nodev,nosuid,noexec shared 253:0
"
run_vault vault-status.sh
expect_rc "status: foreign backing device -> EX_PRECOND (unsafe, not unlocked)" 6 "$RUN_RC"
expect_contains "status: final line is state: unsafe" "$RUN_OUT" "state: unsafe"
expect_lacks "status: foreign mapper never reported unlocked" "$RUN_OUT" "state: unlocked"

new_state
setf mapping "/dev/fake-va
"
setf mount "/dev/other-device ext4 nodev,nosuid,noexec shared 259:0
"
run_vault vault-status.sh
expect_rc "status: unrelated mount at mountpoint -> unsafe" 6 "$RUN_RC"
expect_contains "status: unrelated mount unsafe detail" "$RUN_OUT" "state: unsafe"

new_state
setf mapping "/dev/fake-va
"
run_vault vault-status.sh
expect_rc "status: mapping active, not mounted -> partial (exit 0)" 0 "$RUN_RC"
expect_contains "status: partial detail" "$RUN_OUT" "state: partial"

new_state
setf mapping "/dev/fake-va
"
setf mount "/dev/mapper/portable-vault ext4 nodev,nosuid,noexec shared 253:0
"
run_vault vault-status.sh
expect_rc "status: correct unlocked state -> exit 0" 0 "$RUN_RC"
expect_contains "status: final line is state: unlocked" "$RUN_OUT" "state: unlocked"

new_state
setf mount "/dev/mapper/portable-vault ext4 nodev,nosuid,noexec shared 253:0
"
run_vault vault-status.sh
expect_rc "status: mount without active mapping -> unsafe (inconsistent)" 6 "$RUN_RC"
expect_contains "status: mount-without-mapping unsafe" "$RUN_OUT" "state: unsafe"

# --- 6. concurrency: lifecycle serialization -----------------------------------------
new_state
reset_mp
setf OPEN_SLEEP 0.8
printf 'p1' > "$WORK/pass1.txt"
printf 'p1' > "$WORK/pass2.txt"
env FAKE_STATE="$STATE" PATH="$FAKEBIN:$PATH" "$BIN/unlock-vault.sh" --config "$CONF" \
  < "$WORK/pass1.txt" > "$WORK/u1.out" 2>&1 & U1=$!
sleep 0.25
env FAKE_STATE="$STATE" PATH="$FAKEBIN:$PATH" "$BIN/unlock-vault.sh" --config "$CONF" \
  < "$WORK/pass2.txt" > "$WORK/u2.out" 2>&1 & U2=$!
wait "$U1"; U1RC=$?
wait "$U2"; U2RC=$?
expect_rc "concurrency: parallel unlock #1 ok" 0 "$U1RC"
expect_rc "concurrency: parallel unlock #2 ok (serialized)" 0 "$U2RC"
NOPEN="$(cryptsetup_calls open)"
[ "$NOPEN" = 1 ] \
  && ok "concurrency: exactly ONE open for two parallel unlocks (whole-operation serialization)" \
  || bad "concurrency: expected 1 open, saw $NOPEN (race)"
[ "$(tool_calls umount)" = 0 ] && ok "concurrency: no umount raced in" || bad "concurrency: umount during parallel unlocks"

new_state
reset_mp
setf OPEN_SLEEP 0.8
printf 'p1' > "$WORK/pass1.txt"
env FAKE_STATE="$STATE" PATH="$FAKEBIN:$PATH" "$BIN/unlock-vault.sh" --config "$CONF" \
  < "$WORK/pass1.txt" > "$WORK/u1.out" 2>&1 & U1=$!
sleep 0.25
setf FUSER_RC 1
env FAKE_STATE="$STATE" PATH="$FAKEBIN:$PATH" "$BIN/lock-vault.sh" --config "$CONF" \
  > "$WORK/l1.out" 2>&1; LRC=$?
wait "$U1"; U1RC=$?
expect_rc "concurrency: unlock during overlapping lock ok" 0 "$U1RC"
expect_rc "concurrency: lock waits for unlock, then locks" 0 "$LRC"
hasf mapping && bad "concurrency: mapping active after lock" || ok "concurrency: mapping closed after serialized lock"
TMOUNT="$(ts_of mount)"
TUMOUNT="$(ts_of umount)"
python3 -c "import sys; sys.exit(0 if float('$TMOUNT' or 0) < float('$TUMOUNT' or 0) else 1)" \
  && ok "concurrency: lock's umount happened AFTER unlock's mount (serialized order)" \
  || bad "concurrency: umount/mount ordering broken ($TMOUNT vs $TUMOUNT)"

# --- 7. provision: all preflights BEFORE format ---------------------------------------
PROV_ARGS=(--device /dev/fake-va --confirm ERASE-NEW-VAULT-DISK)
prov_run() {
  new_state
  printf 'new-vault-pass' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
  run_vault provision-vault.sh "${PROV_ARGS[@]}"
}

new_state; setf mapping "/dev/fake-va
"
printf 'p' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
run_vault provision-vault.sh "${PROV_ARGS[@]}"
expect_rc "provision: mapper-name collision refused BEFORE format" 6 "$RUN_RC"
[ "$(cryptsetup_calls luksFormat)" = 0 ] && ok "provision: no format on mapper collision" || bad "provision: formatted despite mapper collision"

new_state; setf WIPEFS_OUT 'ext4 filesystem'
prov_run; : # redo with clean wipefs but keep scenario simple below
new_state; setf WIPEFS_OUT 'ext4 filesystem'
printf 'p' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
run_vault provision-vault.sh "${PROV_ARGS[@]}"
expect_rc "provision: existing signature refused" 6 "$RUN_RC"
[ "$(cryptsetup_calls luksFormat)" = 0 ] && ok "provision: no format with existing signature" || bad "provision: formatted over signatures"

new_state; setf WIPEFS_RC 1
printf 'p' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
run_vault provision-vault.sh "${PROV_ARGS[@]}"
expect_rc "provision: wipefs PROBE FAILURE is a refusal (not 'blank')" 6 "$RUN_RC"
[ "$(cryptsetup_calls luksFormat)" = 0 ] && ok "provision: no format on wipefs probe failure" || bad "provision: formatted despite wipefs probe failure"

new_state; setf BLKID_P_RC 1
printf 'p' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
run_vault provision-vault.sh "${PROV_ARGS[@]}"
expect_rc "provision: blkid PROBE FAILURE is a refusal (not 'blank')" 6 "$RUN_RC"
[ "$(cryptsetup_calls luksFormat)" = 0 ] && ok "provision: no format on blkid probe failure" || bad "provision: formatted despite blkid probe failure"

new_state; printf '/run/x\n' > "$STATE/lsblk.mounts"
printf 'p' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
run_vault provision-vault.sh "${PROV_ARGS[@]}"
expect_rc "provision: mounted descendant refused" 6 "$RUN_RC"
[ "$(cryptsetup_calls luksFormat)" = 0 ] && ok "provision: no format on mounted descendant" || bad "provision: formatted a mounted device"

new_state; printf 'part\n' > "$STATE/lsblk.type"
printf 'p' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
run_vault provision-vault.sh "${PROV_ARGS[@]}"
expect_rc "provision: non-disk device refused" 6 "$RUN_RC"

new_state
printf 'p' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
run_vault provision-vault.sh --device /dev/fake-va --confirm WRONG-PHRASE
expect_rc "provision: wrong confirm phrase refused" 2 "$RUN_RC"
[ "$(cryptsetup_calls luksFormat)" = 0 ] && ok "provision: no format on wrong confirm" || bad "provision: formatted despite wrong confirm"

new_state
printf 'p' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
run_vault provision-vault.sh "${PROV_ARGS[@]}" --expect-size-mib 99
expect_rc "provision: size mismatch refused" 6 "$RUN_RC"
[ "$(cryptsetup_calls luksFormat)" = 0 ] && ok "provision: no format on size mismatch" || bad "provision: formatted despite size mismatch"

new_state
printf 'abc
123' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
run_vault provision-vault.sh "${PROV_ARGS[@]}"
expect_rc "provision: happy path" 0 "$RUN_RC"
EXPECT_HEX="$(od -An -v -tx1 "$WORK/pass.txt" | tr -d ' \n')"
F1="$(stdin_hex_of luksFormat 1)"; F2="$(stdin_hex_of open 1)"
[ "$F1" = "$EXPECT_HEX" ] && ok "provision: luksFormat got EXACT stdin bytes" || bad "provision: luksFormat bytes mismatch"
[ "$F2" = "$EXPECT_HEX" ] && ok "provision: verify-open got the SAME EXACT bytes (second feed)" || bad "provision: verify-open bytes mismatch"
hasf mapping && bad "provision: mapping left active" || ok "provision: mapping closed at end"
expect_contains "provision: prints VAULT_LUKS_UUID" "$RUN_OUT" "VAULT_LUKS_UUID=$UUID"
[ "$(tool_calls 'mkfs.ext4')" -ge 1 ] && ok "provision: filesystem created on the mapping" || bad "provision: mkfs not called"

# --- 7b. provision preflights: holders + probe failures + cleanup --------------------
new_state
printf 'fake-va disk\ndm-9 crypt\n' > "$STATE/lsblk.tree"
printf 'p' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
run_vault provision-vault.sh "${PROV_ARGS[@]}"
expect_rc "provision: disk HELD by another device refused BEFORE format" 6 "$RUN_RC"
[ "$(cryptsetup_calls luksFormat)" = 0 ] && ok "provision: no format on held disk" || bad "provision: formatted a held disk"

new_state
printf 'fake-va disk\nfake-va1 part\n' > "$STATE/lsblk.tree"
printf 'p' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
run_vault provision-vault.sh "${PROV_ARGS[@]}"
expect_rc "provision: disk with partitions refused BEFORE format" 6 "$RUN_RC"
[ "$(cryptsetup_calls luksFormat)" = 0 ] && ok "provision: no format on partitioned disk" || bad "provision: formatted a partitioned disk"

new_state
printf 'MOUNTPOINT\n' > "$STATE/lsblk.failcols"
printf 'p' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
run_vault provision-vault.sh "${PROV_ARGS[@]}"
expect_rc "provision: lsblk mount-probe FAILURE is a refusal (not 'no mounts')" 6 "$RUN_RC"
expect_contains "provision: mount-probe failure named" "$RUN_OUT" "probe"
[ "$(cryptsetup_calls luksFormat)" = 0 ] && ok "provision: no format on mount-probe failure" || bad "provision: formatted despite mount-probe failure"

new_state
printf 'NAME,TYPE\n' > "$STATE/lsblk.failcols"
printf 'p' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
run_vault provision-vault.sh "${PROV_ARGS[@]}"
expect_rc "provision: lsblk holder-probe FAILURE is a refusal (not 'bare')" 6 "$RUN_RC"
[ "$(cryptsetup_calls luksFormat)" = 0 ] && ok "provision: no format on holder-probe failure" || bad "provision: formatted despite holder-probe failure"

new_state
setf MKFS_RC 1
printf 'p' > "$WORK/pass.txt"; STDIN_FILE="$WORK/pass.txt"
run_vault provision-vault.sh "${PROV_ARGS[@]}"
expect_rc "provision: mkfs failure -> EX_VAULT with own-mapping cleanup" 4 "$RUN_RC"
[ "$(cryptsetup_calls close)" = 1 ] && ok "provision: mkfs failure closed own mapping" || bad "provision: mkfs failure left own mapping"
hasf mapping && bad "provision: mapping active after mkfs failure" || ok "provision: mapping gone after mkfs failure cleanup"
expect_contains "provision: mkfs failure truthful state" "$RUN_OUT" "state after cleanup: mapping=no"

new_state
setf OPEN_SLEEP 2
printf 'p' > "$WORK/pass.txt"
env FAKE_STATE="$STATE" PATH="$FAKEBIN:$PATH" "$BIN/provision-vault.sh" --config "$CONF" "${PROV_ARGS[@]}" \
  < "$WORK/pass.txt" > "$WORK/sigprov.out" 2>&1 & PROVPID=$!
# the open call here is the verification open (luksFormat does not sleep)
if wait_for_call cryptsetup open 5; then ok "provision signal fixture: verification open started"; else bad "provision signal fixture: open never started"; fi
kill -TERM "$PROVPID" 2>/dev/null
if wait_bounded "$PROVPID" 8; then
  wait "$PROVPID"; PRC=$?
  SIGPROV_OUT="$(cat "$WORK/sigprov.out")"
  expect_rc "provision signal: TERM during verification open -> EX_VAULT with cleanup" 4 "$PRC"
  [ "$(cryptsetup_calls close)" = 1 ] && ok "provision signal: interrupted verification open closed" || bad "provision signal: leftover mapping not closed"
  hasf mapping && bad "provision signal: mapping left active" || ok "provision signal: mapping cleaned up"
  expect_contains "provision signal: truthful state reported" "$SIGPROV_OUT" "state after cleanup: mapping=no"
else
  kill -KILL "$PROVPID" 2>/dev/null; wait "$PROVPID" 2>/dev/null
  bad "provision signal: TERM did not exit within bound"
fi

# --- 8. passphrase channel contract ---------------------------------------------------
new_state
printf 'pa\000ss' > "$WORK/nul.txt"; STDIN_FILE="$WORK/nul.txt"
run_vault provision-vault.sh "${PROV_ARGS[@]}"
expect_rc "passphrase: NUL byte refused BEFORE format" 2 "$RUN_RC"
[ "$(cryptsetup_calls luksFormat)" = 0 ] && ok "passphrase: no cryptsetup call for NUL input" || bad "passphrase: formatted with NUL passphrase"

new_state
: > "$WORK/empty.txt"; STDIN_FILE="$WORK/empty.txt"
run_vault provision-vault.sh "${PROV_ARGS[@]}"
expect_rc "passphrase: empty stdin refused" 2 "$RUN_RC"

new_state
{ head -c 513 /dev/zero | tr '\0' 'a'; } > "$WORK/big.txt"; STDIN_FILE="$WORK/big.txt"
run_vault provision-vault.sh "${PROV_ARGS[@]}"
expect_rc "passphrase: 513 bytes refused (oversize)" 2 "$RUN_RC"
[ "$(cryptsetup_calls luksFormat)" = 0 ] && ok "passphrase: no format for oversize" || bad "passphrase: formatted oversize passphrase"

new_state
reset_mp
{ head -c 512 /dev/zero | tr '\0' 'b'; } > "$WORK/ok512.txt"; STDIN_FILE="$WORK/ok512.txt"
run_vault unlock-vault.sh
expect_rc "passphrase: exactly 512 bytes accepted" 0 "$RUN_RC"
GOT_HEX="$(stdin_hex_of open)"
[ "$GOT_HEX" = "$(printf 'b%.0s' $(seq 512) | od -An -v -tx1 | tr -d ' \n')" ] \
  && ok "passphrase: 512-byte feed is byte-exact" || bad "passphrase: 512-byte feed mismatch"

# --- 9. broker python tests --------------------------------------------------------------
if env PORTABLE_TEST_TRUSTED_DIR="$VBTESTS" python3 "$TESTS/test-broker.py"; then
  ok "broker: python unit tests passed"
else
  bad "broker: python unit tests failed"
fi

# --- 9b. dispatch contract: REAL helpers through Broker.dispatch + fakes -------------
# The broker's own config (validated, root-owned, allowed uids resolvable in
# this namespace) drives the real unlock/lock/status scripts against the fake
# executors; replies are the ones socket clients would receive.
BCONF="$ETC/broker.conf"
sed 's/^BROKER_ALLOWED_UIDS=.*/BROKER_ALLOWED_UIDS=nobody/' "$CONF" > "$BCONF"
chmod 0600 "$BCONF"
if env DISPATCH_BIN_DIR="$BIN" DISPATCH_CONFIG="$BCONF" \
       DISPATCH_STATE="$WORK/dispatch-state" DISPATCH_FAKEBIN="$FAKEBIN" \
       python3 "$TESTS/test-dispatch-contract.py"; then
  ok "broker: dispatch contract tests passed"
else
  bad "broker: dispatch contract tests failed"
fi

# --- 10. static systemd unit verification --------------------------------------------------
if command -v systemd-analyze >/dev/null 2>&1; then
  VDIR="$WORK/units"; mkdir -p "$VDIR"
  cp "$SRC_DIR/units/portable-vault-broker.service" "$VDIR/"
  for t in portable-agent portable-ui portable-credit; do
    cp "$SRC_DIR/units/$t.service.example" "$VDIR/$t.service"
  done
  VOUT="$(systemd-analyze verify "$VDIR/portable-vault-broker.service" 2>&1 || true)"
  BROKER_BASE=portable-vault-broker.service
  OURS="$(printf '%s\n' "$VOUT" | grep -F "$BROKER_BASE" || true)"
  if [ -n "$OURS" ]; then
    bad "systemd: broker unit verify reports: $(printf '%s' "$OURS" | head -n2 | tr '\n' ';')"
  else
    ok "systemd: broker unit passes static verify (no unknown/invalid directives)"
  fi
  if printf '%s\n' "$VOUT" | grep -q "ProtectKernelTunnels"; then
    bad "systemd: ProtectKernelTunnels typo still present somewhere"
  else
    ok "systemd: ProtectKernelTunnels typo gone from all units"
  fi
  # templates carry no ExecStart by design: verify them with a stub ExecStart
  for t in portable-agent portable-ui portable-credit; do
    sed 's|^# ExecStart=... |ExecStart=/bin/true |' "$VDIR/$t.service" > "$VDIR/$t.service.tmp"
    mv "$VDIR/$t.service.tmp" "$VDIR/$t.service"
  done
  TOUT="$(systemd-analyze verify "$VDIR"/*.service 2>&1 || true)"
  TERR="$(printf '%s\n' "$TOUT" | grep -E 'Unknown|Invalid' | grep -v -E 'netplan|snapd|systemd-analyze' || true)"
  if [ -n "$TERR" ]; then
    bad "systemd: template units report: $(printf '%s' "$TERR" | head -n3 | tr '\n' ';')"
  else
    ok "systemd: consumer templates have no unknown/invalid directives"
  fi
else
  skip "systemd-analyze unavailable: static unit verification unqualified"
fi

# --- 11. verify-fs-boundary on a staged + faked sysroot -------------------------------------
SYSROOT="$WORK/sysroot"
mkdir -p "$SYSROOT/etc"
cat > "$SYSROOT/etc/passwd" <<'EOF'
portable-agent:x:900:900::/var/lib/portable/portable-agent:/usr/sbin/nologin
portable-ui:x:901:901::/var/lib/portable/portable-ui:/usr/sbin/nologin
portable-credit:x:902:902::/var/lib/portable/portable-credit:/usr/sbin/nologin
EOF
cat > "$SYSROOT/etc/group" <<'EOF'
portable-agent:x:900:
portable-ui:x:901:
portable-credit:x:902:
portable-operators:x:903:portable-credit
EOF
new_state
VOUT="$(env FAKE_STATE="$STATE" PATH="$FAKEBIN:$PATH" "$BIN/verify-fs-boundary.sh" \
  --prefix "$STAGE" --sysroot "$SYSROOT" --staged 2>&1)"; VRC=$?
if [ "$VRC" = 0 ] && ! printf '%s\n' "$VOUT" | grep -q '^FAIL'; then
  ok "verify-fs-boundary: staged + faked sysroot passes with no FAIL"
else
  bad "verify-fs-boundary: unexpected failures" "$(printf '%s\n' "$VOUT" | grep -E '^FAIL|summary' | head -n5 | tr '\n' ';')"
fi
# negative: break the broker unit's authority model -> must FAIL
BROKEN="$WORK/broken"; mkdir -p "$BROKEN"
cp -r "$STAGE"/* "$BROKEN"/ 2>/dev/null || cp -r "$STAGE"/. "$BROKEN"/
sed -i 's/^NoNewPrivileges=yes$/NoNewPrivileges=yes\nPrivateTmp=yes/' "$BROKEN/systemd/portable-vault-broker.service"
VOUT="$(env FAKE_STATE="$STATE" PATH="$FAKEBIN:$PATH" "$BIN/verify-fs-boundary.sh" \
  --prefix "$BROKEN" --sysroot "$SYSROOT" --staged 2>&1)"; VRC=$?
if [ "$VRC" = 1 ] && printf '%s\n' "$VOUT" | grep -q 'mount-namespace-inducing'; then
  ok "verify-fs-boundary: broker PrivateTmp violation is a FAIL"
else
  bad "verify-fs-boundary: did not reject broker PrivateTmp"
fi

# Independent regression: a failed status probe is never an inactive vault.
for helper in vault-status.sh lock-vault.sh unlock-vault.sh provision-vault.sh; do
  for status_rc in 1 2 3 4 5 127; do
    new_state; reset_mp
    setf mapping /dev/fake-va
    setf STATUS_RC "$status_rc"
    if [ "$helper" = provision-vault.sh ]; then
      run_vault "$helper" "${PROV_ARGS[@]}"
    else
      run_vault "$helper"
    fi
    expect_rc "probe error: $helper status=$status_rc refuses" 6 "$RUN_RC"
    expect_contains "probe error: $helper status=$status_rc unknown" "$RUN_OUT" 'state: unknown'
    [ "$(cryptsetup_calls open)" = 0 ] && [ "$(cryptsetup_calls close)" = 0 ] && [ "$(cryptsetup_calls luksFormat)" = 0 ] && [ "$(tool_calls umount)" = 0 ] \
      && ok "probe error: $helper status=$status_rc no lifecycle mutations" \
      || bad "probe error: $helper status=$status_rc changed state"
  done
done
new_state; reset_mp
setf lsblk.failcols KNAME,NAME
run_vault vault-status.sh
expect_rc "probe error: failed independent kernel inventory refuses" 6 "$RUN_RC"
expect_contains "probe error: failed inventory is unknown" "$RUN_OUT" 'state: unknown'
new_state; reset_mp
setf lsblk.inventory ''
run_vault vault-status.sh
expect_rc "probe error: empty independent kernel inventory refuses" 6 "$RUN_RC"
expect_contains "probe error: empty inventory is unknown" "$RUN_OUT" 'state: unknown'

# --- summary ----------------------------------------------------------------------------------
printf '\nsummary: pass=%d fail=%d skip=%d\n' "$PASS" "$FAIL" "$SKIPPED"
[ "$FAIL" = 0 ]
