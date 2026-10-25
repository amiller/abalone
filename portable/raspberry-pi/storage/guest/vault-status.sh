#!/bin/bash
# vault-status.sh — print the vault lifecycle state (informational, exit 0).
#
# One line per fact so the broker and humans read the same thing. Never mutates
# anything. Takes the SHARED lifecycle lock so a snapshot never interleaves
# with a concurrent provision/unlock/lock.
#
# The FINAL line is always a structured `state:` line computed from device
# resolution + mapping identity + exact mount identity (kernel major:minor),
# never from a single observed fact:
#   state: unlocked   mapping active, identity-verified, exactly one mount
#                      whose device IS the mapper, fstype/options as configured
#   state: locked     no active mapping and no mount
#   state: partial    consistent but incomplete (e.g. mapping active, not
#                      mounted; or unlocked while the configured device is
#                      unresolvable, so identity cannot be re-verified)
#   state: unsafe     identity or mount MISMATCH (active mapping backs a
#                      DIFFERENT device; unexpected/stacked/wrong mount; mount
#                      without an active mapping). Unsafe exits 6 and the
#                      `state: unsafe …` line is the LAST line the broker can
#                      see, so a mismatch can never be reported as "unlocked".
#
# Usage: vault-status.sh [--config /opt/portable/etc/vault.conf]
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
    -h|--help) sed -n '3,23p' "$0"; exit 0 ;;
    *) usage_error "unknown argument: $1" ;;
  esac
done

require_root
BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
require_trusted_helper_tree "$BIN_DIR" common.sh vault-status.sh
load_trusted_config "$CONFIG"
for tool in cryptsetup findmnt lsblk blkid flock; do require_command "$tool"; done

# --- shared lock: a consistent snapshot, never a mid-operation one ------------
acquire_lifecycle_lock shared "$CONFIG"

MAPPING=inactive
vault_mapping_active && MAPPING=active
MOUNTED=no
MOUNT_LINE='(not mounted)'
if vault_mounted; then
  MOUNTED=yes
  MOUNT_LINE="$(findmnt -rn -o SOURCE,TARGET,FSTYPE,OPTIONS,PROPAGATION,MAJ:MIN "$CONFIG_VAULT_MOUNTPOINT" 2>/dev/null || true)"
fi

# --- identity facts -------------------------------------------------------------
RESOLVED_OK=0
if vault_resolve_device; then
  RESOLVED_OK=1
fi
IDENT='unresolved (configured device absent or ambiguous)'
ID_MATCH=no
if [ "$RESOLVED_OK" = 1 ]; then
  IDENT="resolved: $RESOLVED_DEV"
  if [ "$MAPPING" = active ]; then
    if vault_mapping_matches_device "$RESOLVED_DEV"; then
      ID_MATCH=yes
      IDENT="$IDENT; active mapping backing device MATCHES (identity verified)"
    else
      IDENT="$IDENT; ACTIVE MAPPING BACKS A DIFFERENT DEVICE (unexpected mapper; lifecycle scripts will refuse to touch it)"
    fi
  fi
else
  IDENT="unresolved: $RESOLVE_ERR"
fi
MOUNT_OK=no
if [ "$MOUNTED" = yes ]; then
  if vault_mount_check; then
    MOUNT_OK=yes
    IDENT="$IDENT; mount matches configuration (device identity, fstype, options)"
  else
    IDENT="$IDENT; MOUNT MISMATCH: $MOUNT_MATCH_MSG"
  fi
fi

SOCKET="$CONFIG_BROKER_SOCKET_DIR/$CONFIG_BROKER_SOCKET_NAME"
SOCKET_STATE=absent
[ -S "$SOCKET" ] && SOCKET_STATE=listening-or-stale

out "mapping: $MAPPING ($CONFIG_VAULT_MAPPER_NAME)"
out "luks-uuid-configured: ${CONFIG_VAULT_LUKS_UUID:-<empty>}"
out "identity: $IDENT"
if [ "$MAPPING" = active ]; then
  out "cryptsetup-status-first-lines:"
  cryptsetup status "$CONFIG_VAULT_MAPPER_NAME" 2>/dev/null | sed -n '1,4p' | sed 's/^/  /' || true
fi
out "mounted: $MOUNTED"
out "mount-detail: $MOUNT_LINE"
out "broker-socket: $SOCKET_STATE ($SOCKET)"

# --- final structured state (the line the broker reports) -----------------------
# Computed from ALL facts: device resolution, mapping identity, exact mount
# identity/options. A mismatch is NEVER reported as "unlocked".
STATE_REASON=
if [ "$MAPPING" = inactive ] && [ "$MOUNTED" = no ]; then
  STATE=locked
  STATE_EXIT=0
elif [ "$MOUNTED" = yes ] && [ "$MAPPING" = inactive ]; then
  STATE=unsafe
  STATE_REASON="mount present at $CONFIG_VAULT_MOUNTPOINT but mapping '$CONFIG_VAULT_MAPPER_NAME' is inactive (unexpected mount; lifecycle scripts refuse to touch it)"
  STATE_EXIT=$EX_PRECOND
elif [ "$MAPPING" = active ] && [ "$RESOLVED_OK" = 1 ] && [ "$ID_MATCH" != yes ]; then
  STATE=unsafe
  STATE_REASON="active mapping backs a DIFFERENT device than the configured vault ($RESOLVED_DEV); unexpected mapper; lifecycle scripts refuse to touch it"
  STATE_EXIT=$EX_PRECOND
elif [ "$MOUNTED" = yes ] && [ "$MOUNT_OK" != yes ]; then
  STATE=unsafe
  STATE_REASON="$MOUNT_MATCH_MSG"
  STATE_EXIT=$EX_PRECOND
elif [ "$MAPPING" = active ] && [ "$MOUNTED" = no ]; then
  STATE=partial
  STATE_REASON="mapping active, not mounted"
  STATE_EXIT=0
elif [ "$RESOLVED_OK" != 1 ]; then
  STATE=partial
  STATE_REASON="mapping active and mounted, but the configured device is unresolved ($RESOLVE_ERR); identity cannot be re-verified"
  STATE_EXIT=0
else
  STATE=unlocked
  STATE_EXIT=0
fi

out "state: $STATE${STATE_REASON:+ ($STATE_REASON)}"
if [ "$STATE_EXIT" -ne 0 ]; then
  # die() makes the state line the LAST stderr line too, so the broker's
  # error reply carries the explicit unsafe state.
  die "$STATE_EXIT" "state: $STATE — $STATE_REASON"
fi
exit "$EX_OK"
