#!/bin/bash
# lock-vault.sh — ordinary, non-forced vault lock.
#
# Lock requires stopped writers. If any process holds the mount open the
# script REFUSES (exit 3): the vault stays unlocked and VISIBLE, the holder
# PIDs are printed, and nothing is killed, detached or forced. There is no
# lazy unmount (-l), no force (-f) and no recursive remount trick anywhere in
# this script — a busy vault is a human decision, not a flag.
#
# Before unmounting or closing anything, the script verifies IDENTITY: the
# active mapping's backing device must be the one resolved from the
# configured LUKS UUID, and the mount must be exactly the configured mount.
# An unexpected mapper or mount at these names is refused, never closed.
# All lifecycle operations serialize on one exclusive root-owned flock.
#
# Locking when already locked is an idempotent no-op (exit 0).
#
# Interruption (INT/TERM/HUP) never forces anything: the script reports the
# state it actually reached (mapping=… mounted=…) and leaves whatever it did
# not yet finish visibly in place for a human decision.
#
# Usage: lock-vault.sh [--config /opt/portable/etc/vault.conf]
set -euo pipefail
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
    -h|--help) sed -n '3,22p' "$0"; exit 0 ;;
    *) usage_error "unknown argument: $1" ;;
  esac
done

require_root
BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
require_trusted_helper_tree "$BIN_DIR" common.sh lock-vault.sh
load_trusted_config "$CONFIG"
for tool in cryptsetup umount findmnt lsblk blkid fuser flock; do require_command "$tool"; done

report_state() {
  local m=no v=no
  vault_mapping_active && m=active
  vault_mounted && v=yes
  STATE_LINE="mapping=$m mounted=$v"
}

on_signal() { # interruption never forces anything: report what was actually
  trap - INT TERM HUP   # reached and leave the rest visibly in place
  report_state
  die "$EX_VAULT" "interrupted by signal after state: $STATE_LINE (nothing was forced; inspect and re-run)"
}
trap on_signal INT TERM HUP

# --- serialize the whole lifecycle interaction --------------------------------
acquire_lifecycle_lock exclusive "$CONFIG"

# --- identity before any mutation ---------------------------------------------
# Locking may only close a mapping that is provably the configured vault.
# If the configured device is absent, identity cannot be established and the
# mapping is left untouched (a human inspects vault-status.sh).
if ! vault_resolve_device; then
  if vault_mapping_active; then
    report_state
    die "$EX_PRECOND" "cannot verify identity of active mapping '$CONFIG_VAULT_MAPPER_NAME' ($RESOLVE_ERR); refusing to close it — inspect with vault-status.sh (state: $STATE_LINE)"
  fi
  if vault_mounted; then
    die "$EX_PRECOND" "$CONFIG_VAULT_MOUNTPOINT is mounted but the configured vault device is unresolvable ($RESOLVE_ERR); refusing to touch the mount"
  fi
  log "already locked (no active mapping '$CONFIG_VAULT_MAPPER_NAME'; configured device not attached)"
  exit "$EX_OK"
fi
SRC="$RESOLVED_DEV"

if ! vault_mapping_active; then
  if vault_mounted; then
    die "$EX_PRECOND" "$CONFIG_VAULT_MOUNTPOINT is mounted but mapping '$CONFIG_VAULT_MAPPER_NAME' is inactive; inconsistent state — inspect with vault-status.sh, refusing to act"
  fi
  log "already locked (no active mapping '$CONFIG_VAULT_MAPPER_NAME')"
  exit "$EX_OK"
fi

if ! vault_mapping_matches_device "$SRC"; then
  report_state
  die "$EX_PRECOND" "mapping '$CONFIG_VAULT_MAPPER_NAME' is active but its backing device is NOT the configured vault device $SRC; refusing to unmount or close it (state: $STATE_LINE)"
fi

if vault_mounted; then
  vault_mount_check || die "$EX_PRECOND" "$MOUNT_MATCH_MSG — refusing to unmount it"

  # --- stopped-writers requirement ------------------------------------------
  # fuser -m lists processes with any file, cwd or mmap under the mount.
  # Exit 0 means somebody still holds it: refuse, stay unlocked, stay visible.
  if BUSY="$(fuser -m "$CONFIG_VAULT_MOUNTPOINT" 2>&1)"; then
    log "vault is BUSY; holder output from fuser -m:"
    printf '%s\n' "$BUSY" >&2
    log "mount remains (still unlocked, deliberately visible):"
    findmnt "$CONFIG_VAULT_MOUNTPOINT" >&2 || true
    report_state
    die "$EX_BUSY" "writers still active — stop them (broker clients, agent/UI/credit services) and retry; this script never kills, lazily unmounts or forces (state: $STATE_LINE)"
  fi

  # --- ordinary unmount only --------------------------------------------------
  log "unmounting $CONFIG_VAULT_MOUNTPOINT (ordinary umount; no -l/-f/-R exists in this script)"
  if ! umount "$CONFIG_VAULT_MOUNTPOINT"; then
    log "umount returned an error; current state (still unlocked, deliberately visible):"
    findmnt "$CONFIG_VAULT_MOUNTPOINT" >&2 || true
    report_state
    die "$EX_BUSY" "umount failed (late writer or kernel holder?); nothing forced, vault left mounted for inspection (state: $STATE_LINE)"
  fi
  if vault_mounted; then
    report_state
    die "$EX_VAULT" "umount reported success but the mount is still present; inspect manually (vault-status.sh) (state: $STATE_LINE)"
  fi
  # The empty mountpoint directory is removed when possible (best effort).
  rmdir "$CONFIG_VAULT_MOUNTPOINT" 2>/dev/null || true
fi

log "closing mapping '$CONFIG_VAULT_MAPPER_NAME' (identity verified: backing device $SRC)"
if ! cryptsetup close "$CONFIG_VAULT_MAPPER_NAME"; then
  report_state
  die "$EX_VAULT" "cryptsetup close failed; mapping may remain — inspect with vault-status.sh (no forcing here either) (state: $STATE_LINE)"
fi
if vault_mapping_active; then
  report_state
  die "$EX_VAULT" "mapping still active after close; inspect with vault-status.sh (state: $STATE_LINE)"
fi

report_state
out "locked: no mapping, no mount"
out "state: $STATE_LINE"
exit "$EX_OK"
