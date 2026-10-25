#!/bin/bash
# unlock-vault.sh — late unlock of the configured LUKS vault.
#
# The vault is deliberately OUTSIDE /etc/fstab and /etc/crypttab: nothing in
# boot activates it. Unlock happens only here (root shell) or through the root
# broker, after the operator supplies the passphrase. The target device is the
# FIXED configured LUKS UUID — resolved to exactly one canonical device and
# cross-checked with blkid — never a device name guess. An already-active
# mapping is mounted ONLY after its backing device identity (major:minor) is
# verified to be that resolved device; the mount must be exactly one entry at
# the exact mountpoint whose device identity (major:minor) IS the mapper.
# An unexpected mapper or mount is refused and NEVER closed or unmounted here.
#
# All lifecycle operations (provision/unlock/lock/status) serialize on one
# exclusive root-owned flock at a FIXED path (see common.sh): no
# check-before-act races, and config aliases cannot fork the lock.
#
# Passphrase channel: NUL-free text (1..512 bytes) read once from this
# script's stdin and fed byte-exactly to cryptsetup's key input. Never an
# argument, environment variable, log line or key file. A wrong key leaves NO
# mapping and NO mount of this operation's own making; a mapping this
# operation did not create is never closed.
#
# Truthful failure cleanup: every fallible step after this operation starts
# owning kernel state is guarded, and an EXIT-trap safety net catches anything
# unguarded — cleanup then closes/unmounts ONLY what this operation itself
# created (identity re-verified), reports the actual remaining kernel state
# (mapping=… mounted=…) and never forces anything. The success path disarms
# the failure cleanup: a completed unlock is the intended state, not an error.
#
# No autoformat: if the opened container holds no filesystem the script fails,
# cleans up ONLY what it created, reports the actual remaining state and
# exits; it never creates a filesystem.
#
# Usage: unlock-vault.sh [--config /opt/portable/etc/vault.conf]
# stdin: the passphrase (NUL-free text, 1..512 bytes; recommended without
#        trailing newline).
set -euEo pipefail
umask 077
LC_ALL=C
export LC_ALL

# --- trust bootstrap (inline, BEFORE sourcing any shared code) -----------------
# common.sh is UNTRUSTED until proven otherwise: a writable, replaced or
# symlinked leaf in an otherwise root-owned tree must never execute. This
# check deliberately lives INLINE in the entrypoint — a verifier shipped
# inside the file it validates would itself only run after the payload.
# Refusals exit 5 (EX_CONFIG). Only a root-deployed tree (deploy.sh) passes.
_tb_refuse() { printf '%s: refused: trust: %s\n' "$(basename "$0")" "$1" >&2; exit 5; }
_tb_stat() { stat -c "$1" "$2" 2>/dev/null || _tb_refuse "cannot stat $2"; }
_tb_dir_ok() { # <dir>: real dir, root-owned, not group/world-writable, no symlink
  [ -d "$1" ] || _tb_refuse "not a directory: $1"
  [ ! -L "$1" ] || _tb_refuse "refusing symlinked directory: $1"
  [ "$(_tb_stat '%u' "$1")" = 0 ] || _tb_refuse "$1 is owned by uid $(_tb_stat '%u' "$1"), not root"
  [ $(( 0$(_tb_stat '%a' "$1") & 022 )) -eq 0 ] || _tb_refuse "$1 (mode $(_tb_stat '%a' "$1")) is group- or world-writable"
}
_tb_file_ok() { # <file>: regular, root-owned, exact mode 0755, no symlink
  [ -f "$1" ] || _tb_refuse "not a regular file: $1"
  [ ! -L "$1" ] || _tb_refuse "refusing symlinked file: $1"
  [ "$(_tb_stat '%u' "$1")" = 0 ] || _tb_refuse "$1 is owned by uid $(_tb_stat '%u' "$1"), not root"
  [ "$(_tb_stat '%a' "$1")" = 755 ] || _tb_refuse "$1 mode is $(_tb_stat '%a' "$1") (must be 0755)"
}
_tb_tree_ok() { # <dir> <file-basename>...: full symlink-free root-owned ancestor
  local dir="$1" rest comp acc=/ f   # chain, then each named file — BEFORE source
  shift
  case "$dir" in
    /*) ;;
    *) _tb_refuse "script directory is not absolute: $dir" ;;
  esac
  rest="${dir#/}"
  while [ -n "$rest" ]; do
    comp="${rest%%/*}"
    if [ "$comp" = "$rest" ]; then rest=; else rest="${rest#*/}"; fi
    [ -n "$comp" ] || continue
    acc="$acc$comp"
    _tb_dir_ok "$acc"
    acc="$acc/"
  done
  for f in "$@"; do _tb_file_ok "$dir/$f"; done
}
_tb_dir="$(dirname "${BASH_SOURCE[0]}")"
case "$_tb_dir" in /*) ;; *) _tb_dir="$PWD/$_tb_dir" ;; esac
_tb_tree_ok "$_tb_dir" "$(basename "${BASH_SOURCE[0]}")" common.sh
source "$_tb_dir/common.sh"

CONFIG=/opt/portable/etc/vault.conf
while [ $# -gt 0 ]; do
  case "$1" in
    --config) [ $# -ge 2 ] || usage_error '--config requires a value'; CONFIG="$2"; shift 2 ;;
    --config=*) CONFIG="${1#*=}"; shift ;;
    -h|--help) sed -n '3,37p' "$0"; exit 0 ;;
    *) usage_error "unknown argument: $1" ;;
  esac
done

require_root
BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
require_trusted_helper_tree "$BIN_DIR" common.sh unlock-vault.sh
load_trusted_config "$CONFIG"
require_config_uuid
for tool in cryptsetup mount findmnt lsblk blkid chown id flock dd; do require_command "$tool"; done

OPENED_BY_US=no
STARTED_OPEN=no
MOUNTED_BY_US=no
CREATED_MP_DIR=no
CLEANUP_ARMED=no
CLEANUP_REASON=
RESOLVED_DEV=

arm_cleanup() { CLEANUP_ARMED=yes; }
disarm_cleanup() { CLEANUP_ARMED=no; }

report_state() { # one truthful line about the actual kernel-visible state
  local m=no v=no
  vault_mapping_active && m=active
  vault_mounted && v=yes
  STATE_LINE="mapping=$m mounted=$v"
}

vault_fail() { # vault_fail <exit-code> <message...>: clean up ONLY this
  local code="$1"; shift   # operation's resources, report real state, then die
  disarm_cleanup
  passphrase_scrub || true
  if [ "$MOUNTED_BY_US" = yes ] && vault_mounted; then
    if umount "$CONFIG_VAULT_MOUNTPOINT" 2>/dev/null; then
      log "failure cleanup: unmounted $CONFIG_VAULT_MOUNTPOINT (this operation had mounted it)"
      if [ "$CREATED_MP_DIR" = yes ] && [ -d "$CONFIG_VAULT_MOUNTPOINT" ]; then
        rmdir "$CONFIG_VAULT_MOUNTPOINT" 2>/dev/null || true
      fi
    else
      log "WARNING: failure cleanup could not unmount $CONFIG_VAULT_MOUNTPOINT; it remains mounted and visible (nothing forced)"
    fi
  fi
  local own_mapping=no
  if [ "$OPENED_BY_US" = yes ]; then
    own_mapping=yes
  elif [ "$STARTED_OPEN" = yes ] && [ -n "$RESOLVED_DEV" ] \
    && vault_mapping_active && vault_mapping_matches_device "$RESOLVED_DEV"; then
    # An interrupted open can complete while the signal is pending: under the
    # lifecycle lock, a mapping that appeared during THIS operation's open and
    # backs OUR resolved device is this operation's leftover — never a
    # pre-existing mapping (those are refused before STARTED_OPEN is set).
    own_mapping=yes
    log "failure cleanup: mapping '$CONFIG_VAULT_MAPPER_NAME' appeared during this operation's open; treating it as this operation's leftover"
  fi
  if [ "$own_mapping" = yes ] && vault_mapping_active; then
    if [ -n "$RESOLVED_DEV" ] && vault_mapping_matches_device "$RESOLVED_DEV"; then
      if cryptsetup close "$CONFIG_VAULT_MAPPER_NAME" 2>/dev/null; then
        log "failure cleanup: closed mapping '$CONFIG_VAULT_MAPPER_NAME' (this operation had opened it)"
      else
        log "WARNING: failure cleanup could not close mapping '$CONFIG_VAULT_MAPPER_NAME'; it remains active (inspect with vault-status.sh)"
      fi
    else
      log "refusing to close mapping '$CONFIG_VAULT_MAPPER_NAME' in cleanup: its backing device no longer matches the configured vault (not this operation's mapping)"
    fi
  fi
  report_state
  die "$code" "$* (state after cleanup: $STATE_LINE)"
}

on_unexpected_exit() { # EXIT-trap safety net: an ordinary unguarded set -e
  local rc=$?            # failure after this operation owns state still gets
  trap - EXIT INT TERM HUP ERR   # bounded cleanup + a truthful state line
  if [ "$CLEANUP_ARMED" = yes ]; then
    vault_fail "$EX_VAULT" "unexpected failure${CLEANUP_REASON:+ ($CLEANUP_REASON)}; cleaned up only this operation's resources"
  fi
  exit "$rc"
}
trap on_unexpected_exit EXIT

on_error() { # ERR trap: record WHERE the unexpected failure happened; the
  CLEANUP_REASON="unexpected command failure near line $1"  # EXIT trap cleans
  return 0
}
trap 'on_error $LINENO' ERR

on_signal() {
  trap - INT TERM HUP
  vault_fail "$EX_VAULT" "interrupted by signal; cleaned up only this operation's resources"
}
trap on_signal INT TERM HUP

# --- serialize the whole lifecycle interaction --------------------------------
acquire_lifecycle_lock exclusive "$CONFIG"

# --- resolve the device by the fixed configured UUID, never by name ----------
require_resolved_device
SRC="$RESOLVED_DEV"
log "resolved configured VAULT_LUKS_UUID $CONFIG_VAULT_LUKS_UUID to $SRC (blkid-verified crypto_LUKS)"

# --- preflight EVERYTHING checkable before any dangerous step -----------------
for account in portable-credit portable-agent portable-ui; do
  id "$account" >/dev/null 2>&1 \
    || die "$EX_PRECOND" "account $account missing; run deploy.sh (accounts milestone) first — checked BEFORE opening the vault"
done
if [ -e "$CONFIG_VAULT_MOUNTPOINT" ] || [ -L "$CONFIG_VAULT_MOUNTPOINT" ]; then
  [ ! -L "$CONFIG_VAULT_MOUNTPOINT" ] \
    || die "$EX_PRECOND" "mountpoint $CONFIG_VAULT_MOUNTPOINT is a symlink; refusing (inspect manually)"
  [ -d "$CONFIG_VAULT_MOUNTPOINT" ] \
    || die "$EX_PRECOND" "mountpoint $CONFIG_VAULT_MOUNTPOINT exists but is not a directory; refusing"
fi

# --- existing state: verify identity, never touch the unexpected --------------
if vault_mounted; then
  if ! vault_mapping_active; then
    die "$EX_PRECOND" "$CONFIG_VAULT_MOUNTPOINT is mounted but mapping '$CONFIG_VAULT_MAPPER_NAME' is inactive; inspect manually (vault-status.sh) — refusing to touch an inconsistent state"
  fi
  if ! vault_mapping_matches_device "$SRC"; then
    die "$EX_PRECOND" "mapping '$CONFIG_VAULT_MAPPER_NAME' is active but its backing device is NOT the configured vault device $SRC; unexpected mapper — refusing to mount or close it (inspect with vault-status.sh)"
  fi
  vault_mount_check \
    || die "$EX_PRECOND" "$MOUNT_MATCH_MSG — refusing; nothing was unmounted or closed"
  log "already unlocked and mounted at $CONFIG_VAULT_MOUNTPOINT (idempotent no-op)"
  out "unlocked: /dev/mapper/$CONFIG_VAULT_MAPPER_NAME -> $CONFIG_VAULT_MOUNTPOINT (idempotent)"
  exit "$EX_OK"
fi
if vault_mapping_active; then
  if ! vault_mapping_matches_device "$SRC"; then
    die "$EX_PRECOND" "mapping '$CONFIG_VAULT_MAPPER_NAME' is already active with a DIFFERENT backing device than the configured vault device $SRC; refusing to mount, close or otherwise touch it (inspect with vault-status.sh)"
  fi
  log "mapping '$CONFIG_VAULT_MAPPER_NAME' already active and identity-verified; mounting only"
else
  # --- open (passphrase: stdin, NUL-free text, byte-exact) --------------------
  passphrase_read_stdin
  log "opening LUKS UUID $CONFIG_VAULT_LUKS_UUID ($SRC) as $CONFIG_VAULT_MAPPER_NAME (passphrase from stdin, never argv/env/log)"
  STARTED_OPEN=yes
  if ! passphrase_feed | cryptsetup open --key-file=- "$SRC" "$CONFIG_VAULT_MAPPER_NAME"; then
    # Wrong key or damaged header. Under the lifecycle lock nothing else can
    # have created a mapping meanwhile; close ONLY a leftover that is provably
    # ours (active AND backed by the device we just tried to open).
    if vault_mapping_active; then
      if vault_mapping_matches_device "$SRC"; then
        if cryptsetup close "$CONFIG_VAULT_MAPPER_NAME" 2>/dev/null; then
          log "closed this operation's own leftover mapping after failed open"
        else
          log "WARNING: could not close leftover mapping after failed open; it remains active (inspect with vault-status.sh)"
        fi
      else
        log "mapping appeared after failed open with an unexpected backing device; NOT closing it (not ours)"
      fi
    fi
    report_state
    if vault_mounted; then
      die "$EX_VAULT" "unlock failed and $CONFIG_VAULT_MOUNTPOINT is unexpectedly mounted; stop and inspect manually (state: $STATE_LINE)"
    fi
    die "$EX_VAULT" "wrong key or damaged header: open failed (state: $STATE_LINE)"
  fi
  OPENED_BY_US=yes
  STARTED_OPEN=no
  arm_cleanup
fi
passphrase_scrub

# --- mount with the fixed options ---------------------------------------------
if [ ! -d "$CONFIG_VAULT_MOUNTPOINT" ]; then
  log "creating mountpoint directory $CONFIG_VAULT_MOUNTPOINT"
  CREATED_MP_DIR=yes
  if ! mkdir -p "$CONFIG_VAULT_MOUNTPOINT"; then
    vault_fail "$EX_VAULT" "cannot create mountpoint directory $CONFIG_VAULT_MOUNTPOINT"
  fi
  if ! chmod 0755 "$CONFIG_VAULT_MOUNTPOINT"; then
    vault_fail "$EX_VAULT" "cannot set mode 0755 on $CONFIG_VAULT_MOUNTPOINT"
  fi
fi
log "mounting /dev/mapper/$CONFIG_VAULT_MAPPER_NAME at $CONFIG_VAULT_MOUNTPOINT with $CONFIG_VAULT_MOUNT_OPTIONS"
# The ownership flag is set BEFORE the fallible step and cleanup re-verifies
# the OBSERVED state: a mount that fails cleans nothing (no mount exists),
# while a signal-interrupted mount that still completes IS unmounted.
MOUNTED_BY_US=yes
if ! mount -t "$CONFIG_VAULT_FSTYPE" -o "$CONFIG_VAULT_MOUNT_OPTIONS" \
     "/dev/mapper/$CONFIG_VAULT_MAPPER_NAME" "$CONFIG_VAULT_MOUNTPOINT"; then
  vault_fail "$EX_VAULT" "mount failed (no filesystem on the vault? there is NO autoformat)"
fi

# --- verify what the kernel actually did, not what we asked for ---------------
vault_mount_check || vault_fail "$EX_VAULT" "$MOUNT_MATCH_MSG"
PROP="$(findmnt -rn -o PROPAGATION "$CONFIG_VAULT_MOUNTPOINT" 2>/dev/null || true)"
case ",$PROP," in
  *,shared,*) ;;
  *) log "WARNING: mount propagation is '$PROP' (expected shared): services with private mount namespaces may not see the vault; see portable/raspberry-pi/storage/README.md (mount authority model)" ;;
esac

# --- per-account subdirectories on the freshly mounted vault ------------------
ensure_dir() { # ensure_dir <path> <owner> <group>: create 0700 or VERIFY existing
  local path="$1" owner="$2" group="$3" mode og
  if [ -e "$path" ] || [ -L "$path" ]; then
    [ ! -L "$path" ] || vault_fail "$EX_PRECOND" "$path is a symlink; refusing (per-account 0700 protection cannot be claimed)"
    [ -d "$path" ] || vault_fail "$EX_PRECOND" "$path exists but is not a directory; refusing"
    if ! mode="$(stat -c '%a' "$path")"; then
      vault_fail "$EX_PRECOND" "cannot stat $path (I/O error on the vault?)"
    fi
    [ "$mode" = 700 ] || vault_fail "$EX_PRECOND" "$path mode is $mode (expected 0700); refusing to claim per-account protection"
    if ! og="$(stat -c '%U:%G' "$path")"; then
      vault_fail "$EX_PRECOND" "cannot stat owner of $path (I/O error on the vault?)"
    fi
    [ "$og" = "$owner:$group" ] || vault_fail "$EX_PRECOND" "$path is owned by $og (expected $owner:$group); refusing"
    return 0
  fi
  if ! mkdir -m 0700 "$path"; then
    vault_fail "$EX_VAULT" "cannot create $path (I/O or space error on the vault?)"
  fi
  if ! chown "$owner:$group" "$path"; then
    vault_fail "$EX_PRECOND" "cannot chown $path to $owner:$group"
  fi
}
CREDIT_DIR="$CONFIG_VAULT_MOUNTPOINT/$CONFIG_VAULT_MOUNT_SUBDIR_CREDIT"
AGENT_DIR="$CONFIG_VAULT_MOUNTPOINT/$CONFIG_VAULT_MOUNT_SUBDIR_AGENT"
UI_DIR="$CONFIG_VAULT_MOUNTPOINT/$CONFIG_VAULT_MOUNT_SUBDIR_UI"
ensure_dir "$CREDIT_DIR" portable-credit portable-credit
ensure_dir "$AGENT_DIR" portable-agent portable-agent
ensure_dir "$UI_DIR" portable-ui portable-ui

# Success: the open mapping and verified mount are the INTENDED final state;
# disable the failure cleanup (a later reporting error must not unmount it).
disarm_cleanup
report_state
out "unlocked: /dev/mapper/$CONFIG_VAULT_MAPPER_NAME -> $CONFIG_VAULT_MOUNTPOINT (options ok, propagation ${PROP:-unknown})"
out "subdirectories: $CREDIT_DIR $AGENT_DIR $UI_DIR (0700, per-account)"
out "state: $STATE_LINE"
exit "$EX_OK"
