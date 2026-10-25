#!/bin/bash
# provision-vault.sh — initialize a FRESH, BLANK vault disk declared by the
# supervisor, and nothing else.
#
# Safety contract (enforced, not advisory — see portable/raspberry-pi/storage/README.md):
#   * The device is never defaulted or guessed. --device is mandatory and is
#     the supervisor's explicit declaration. No /dev/vdb fallback exists.
#   * EVERY preflight (mapper-name collision, whole-disk identity, size,
#     mounted descendants, holders/partitions, signature probes) runs BEFORE
#     cryptsetup luksFormat. Probe FAILURES are refusals too: a wipefs/blkid/
#     lsblk error is never treated as "blank" or "unmounted" or "unheld".
#   * Any existing filesystem/RAID/LUKS/partition signature refuses the run.
#     There is no --force and no wipe: wiping is a separate human decision.
#   * The passphrase travels one private channel only: this script's stdin,
#     valid NUL-free text (1..512 bytes, recommended WITHOUT a trailing
#     newline so interactive cryptsetup prompts match byte-for-byte). It is
#     never an argument, environment variable, log line or key file on disk.
#   * All lifecycle operations (provision/unlock/lock/status) serialize on one
#     exclusive root-owned flock at a FIXED path (see common.sh).
#   * After formatting, the script verifies the passphrase by opening the
#     container, creates the ext4 filesystem, closes the mapping and prints
#     the LUKS UUID for the supervisor to pin into vault.conf. It never
#     writes vault.conf itself.
#   * Truthful failure cleanup: every step after the verification open is
#     guarded, an EXIT-trap safety net catches anything unguarded, and the
#     mapping this operation opened is closed (best effort, identity
#     re-verified) on any failure or interruption — the observed mapping
#     state is always reported. The success path disarms the cleanup.
#
# Usage: provision-vault.sh --device /dev/disk/by-id/<declared-disk>
#                           --confirm ERASE-NEW-VAULT-DISK
#                           [--expect-size-mib N] [--config /opt/portable/etc/vault.conf]
# stdin: the passphrase (NUL-free text, 1..512 bytes).
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

DEVICE=
CONFIRM=
EXPECT_SIZE_MIB=
CONFIG=/opt/portable/etc/vault.conf

while [ $# -gt 0 ]; do
  case "$1" in
    --device) [ $# -ge 2 ] || usage_error '--device requires a value'; DEVICE="$2"; shift 2 ;;
    --device=*) DEVICE="${1#*=}"; shift ;;
    --confirm) [ $# -ge 2 ] || usage_error '--confirm requires a value'; CONFIRM="$2"; shift 2 ;;
    --confirm=*) CONFIRM="${1#*=}"; shift ;;
    --expect-size-mib)
      [ $# -ge 2 ] || usage_error '--expect-size-mib requires a value'
      EXPECT_SIZE_MIB="$2"; shift 2 ;;
    --expect-size-mib=*) EXPECT_SIZE_MIB="${1#*=}"; shift ;;
    --config) [ $# -ge 2 ] || usage_error '--config requires a value'; CONFIG="$2"; shift 2 ;;
    --config=*) CONFIG="${1#*=}"; shift ;;
    -h|--help) sed -n '3,33p' "$0"; exit 0 ;;
    *) usage_error "unknown argument: $1" ;;
  esac
done

[ -n "$DEVICE" ] || usage_error 'missing --device: the supervisor must declare the exact fresh disk (there is deliberately no default device)'
[ -n "$CONFIRM" ] || usage_error 'missing --confirm ERASE-NEW-VAULT-DISK'
[ "$CONFIRM" = ERASE-NEW-VAULT-DISK ] || die "$EX_USAGE" 'wrong confirm phrase: expected --confirm ERASE-NEW-VAULT-DISK'
case "$DEVICE" in
  /dev/*) ;;
  *) die "$EX_USAGE" "--device must be an absolute /dev path (got: $DEVICE)" ;;
esac
if [ -n "$EXPECT_SIZE_MIB" ]; then
  printf '%s' "$EXPECT_SIZE_MIB" | grep -Eq '^[0-9]+$' || die "$EX_USAGE" '--expect-size-mib must be a positive integer'
fi

require_root
BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
require_trusted_helper_tree "$BIN_DIR" common.sh provision-vault.sh
load_trusted_config "$CONFIG"
for tool in lsblk wipefs blkid cryptsetup mkfs.ext4 flock dd; do require_command "$tool"; done

OPENED_BY_US=no
STARTED_OPEN=no
CLEANUP_ARMED=no
CLEANUP_REASON=

arm_cleanup() { CLEANUP_ARMED=yes; }
disarm_cleanup() { CLEANUP_ARMED=no; }

report_state() { # truthful observed mapping state (provision owns no mounts)
  local m=no
  vault_mapping_active && m=active
  STATE_LINE="mapping=$m"
}

prov_fail() { # prov_fail <exit-code> <message...>: close ONLY this operation's
  local code="$1"; shift  # own leftover mapping (identity re-verified), report
  disarm_cleanup           # the observed state, then die
  passphrase_scrub || true
  local own_mapping=no
  if [ "$OPENED_BY_US" = yes ]; then
    own_mapping=yes
  elif [ "$STARTED_OPEN" = yes ] && vault_mapping_active && vault_mapping_matches_device "$DEVICE"; then
    # Under the lifecycle lock (and after the mapper-collision preflight),
    # a mapping that appeared during THIS operation's open and backs the
    # declared device is this operation's leftover.
    own_mapping=yes
    log "failure cleanup: mapping '$CONFIG_VAULT_MAPPER_NAME' appeared during this operation's open; treating it as this operation's leftover"
  fi
  if [ "$own_mapping" = yes ] && vault_mapping_active; then
    if vault_mapping_matches_device "$DEVICE"; then
      if cryptsetup close "$CONFIG_VAULT_MAPPER_NAME" 2>/dev/null; then
        log "failure cleanup: closed mapping '$CONFIG_VAULT_MAPPER_NAME' (this operation had opened it)"
      else
        log "WARNING: failure cleanup could not close mapping '$CONFIG_VAULT_MAPPER_NAME'; it remains active (inspect with vault-status.sh)"
      fi
    else
      log "refusing to close mapping '$CONFIG_VAULT_MAPPER_NAME' in cleanup: its backing device is not the declared device (not this operation's mapping)"
    fi
  fi
  report_state
  die "$code" "$* (state after cleanup: $STATE_LINE)"
}

on_unexpected_exit() { # EXIT-trap safety net: an ordinary unguarded set -e
  local rc=$?            # failure after the verification open still closes
  trap - EXIT INT TERM HUP ERR   # only this operation's own mapping + state
  if [ "$CLEANUP_ARMED" = yes ]; then
    prov_fail "$EX_VAULT" "unexpected failure${CLEANUP_REASON:+ ($CLEANUP_REASON)}; cleaned up only this operation's resources"
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
  prov_fail "$EX_VAULT" "interrupted by signal; cleaned up only this operation's resources"
}
trap on_signal INT TERM HUP

# --- serialize the whole lifecycle interaction BEFORE any device probing ------
acquire_lifecycle_lock exclusive "$CONFIG"

# --- device identity: a whole disk, exactly as declared, nothing else --------
case "$DEVICE" in
  */mapper/*|/dev/dm-*) die "$EX_PRECOND" "refusing device-mapper node: $DEVICE" ;;
esac
if ! DTYPE="$(lsblk -dn -o TYPE "$DEVICE" 2>/dev/null)"; then
  die "$EX_PRECOND" "lsblk type probe FAILED on $DEVICE (a probe error is a refusal, not 'not a disk')"
fi
[ "$DTYPE" = disk ] || die "$EX_PRECOND" "$DEVICE is not a whole disk (lsblk TYPE: ${DTYPE:-not found}); declare the fresh vault disk explicitly"
if ! DSIZE_BYTES="$(lsblk -dbn -o SIZE "$DEVICE" 2>/dev/null)"; then
  die "$EX_PRECOND" "lsblk size probe FAILED on $DEVICE (a probe error is a refusal, not zero)"
fi
printf '%s' "$DSIZE_BYTES" | grep -Eq '^[0-9]+$' || die "$EX_PRECOND" "cannot read size of $DEVICE (probe error is a refusal, not zero)"
[ "$DSIZE_BYTES" -gt 0 ] || die "$EX_PRECOND" "$DEVICE reports size 0"
if [ -n "$EXPECT_SIZE_MIB" ]; then
  EXPECT_BYTES=$((EXPECT_SIZE_MIB * 1024 * 1024))
  [ "$DSIZE_BYTES" -eq "$EXPECT_BYTES" ] \
    || die "$EX_PRECOND" "$DEVICE size ${DSIZE_BYTES} bytes != declared --expect-size-mib ${EXPECT_SIZE_MIB} (${EXPECT_BYTES} bytes); wrong disk?"
fi
# Mounted check covers the disk AND any partition/descendant (lsblk -r walks
# the tree). An lsblk FAILURE is a refusal, never "no mounted descendants":
# the || true pattern hides probe errors and is deliberately not used.
if ! DMOUNTS_OUT="$(lsblk -rn -o MOUNTPOINT "$DEVICE" 2>/dev/null)"; then
  die "$EX_PRECOND" "lsblk mount probe FAILED on $DEVICE (a probe error is not 'no mounted descendants'); refusing to provision"
fi
DMOUNTS="$(printf '%s\n' "$DMOUNTS_OUT" | grep -v '^$' || true)"
[ -z "$DMOUNTS" ] || die "$EX_PRECOND" "$DEVICE (or a partition/descendant) is mounted at:$(printf '\n  %s' $DMOUNTS); refuse to provision a mounted device"
# Holders/partitions: lsblk walks holders (dm/RAID/LVM/multipath) into the
# subtree. A fresh vault disk must be BARE — exactly one row (the disk
# itself). A probe failure is a refusal, never "bare".
if ! DTREE="$(lsblk -rn -o NAME,TYPE "$DEVICE" 2>/dev/null)"; then
  die "$EX_PRECOND" "lsblk holder/descendant probe FAILED on $DEVICE (a probe error is not 'bare disk'); refusing to provision"
fi
DTREE_N="$(printf '%s\n' "$DTREE" | grep -c . || true)"
[ "$DTREE_N" -eq 1 ] \
  || die "$EX_PRECOND" "$DEVICE has partitions or is HELD by other devices (dm/RAID/LVM/multipath; lsblk shows $DTREE_N entries, expected exactly 1: the bare disk); a fresh vault disk must be bare"
log "declared device: $DEVICE (whole disk, ${DSIZE_BYTES} bytes, no mounted descendants, no holders, bare)"

# --- mapper-name collision: BEFORE formatting, not after ----------------------
if vault_mapping_active; then
  die "$EX_PRECOND" "device-mapper name '$CONFIG_VAULT_MAPPER_NAME' is already active; close it (lock-vault.sh) before provisioning — checked BEFORE any disk mutation"
fi

# --- refuse ANY existing signature; probe failures are refusals --------------
# wipefs exit != 0 means the PROBE failed (device error, permissions): that is
# not evidence of a blank disk. Only exit 0 with empty output is "no signature".
SIGS_RC=0
SIGS="$(wipefs "$DEVICE" 2>/dev/null)" || SIGS_RC=$?
if [ "$SIGS_RC" -ne 0 ]; then
  die "$EX_PRECOND" "wipefs probe FAILED on $DEVICE (exit $SIGS_RC) — a probe error is not 'blank'; refusing to format"
fi
# blkid -p: 0 = signature found, 2 = no usable signature, other = probe error.
BLKID_RC=0
blkid -p "$DEVICE" >/dev/null 2>&1 || BLKID_RC=$?
case "$BLKID_RC" in
  0) die "$EX_PRECOND" "blkid -p reports a signature on $DEVICE" ;;
  2) : ;; # clean: no signature
  *) die "$EX_PRECOND" "blkid -p probe FAILED on $DEVICE (exit $BLKID_RC) — a probe error is not 'blank'; refusing to format" ;;
esac
if [ -n "$SIGS" ]; then
  log "existing signatures on $DEVICE:"
  printf '%s\n' "$SIGS" >&2
  die "$EX_PRECOND" "$DEVICE is not blank: provisioning only initializes a fresh disk. If this disk is intentionally being retired, wipe it in a separate, reviewed human step — this script never wipes"
fi

# --- passphrase: NUL-free text from stdin only, held briefly as hex ----------
passphrase_read_stdin

# --- format, then verify by opening (single passphrase read, used twice) -----
log "creating LUKS2 container on $DEVICE (key from stdin, never argv/env/log/keyfile)"
passphrase_feed | cryptsetup luksFormat --type luks2 --batch-mode --key-file=- "$DEVICE" \
  || prov_fail "$EX_VAULT" 'luksFormat failed; the disk may hold a partial container. The next run will detect any leftover signature and refuse — do not wipe blindly'

log 'verifying passphrase by opening the fresh container'
STARTED_OPEN=yes
if ! passphrase_feed | cryptsetup open --key-file=- "$DEVICE" "$CONFIG_VAULT_MAPPER_NAME"; then
  prov_fail "$EX_VAULT" 'verification open failed right after format (passphrase channel mismatch or damaged header); the disk now holds an unverified fresh LUKS2 container — re-provision on a blank disk rather than trusting this one'
fi
OPENED_BY_US=yes
STARTED_OPEN=no
arm_cleanup
passphrase_scrub

log 'creating ext4 filesystem on the opened container'
# -F only suppresses mke2fs's interactive confirmation prompts for headless
# use; the device itself was verified blank above and is a fresh LUKS mapping.
if ! mkfs.ext4 -q -F -L portable-vault "/dev/mapper/$CONFIG_VAULT_MAPPER_NAME"; then
  prov_fail "$EX_VAULT" 'mkfs.ext4 failed; closing the mapping, leaving the LUKS2 container on disk for a human decision'
fi

log 'closing the verified mapping'
if ! cryptsetup close "$CONFIG_VAULT_MAPPER_NAME"; then
  prov_fail "$EX_VAULT" 'cryptsetup close failed after mkfs (mapping may remain: inspect with vault-status.sh)'
fi
if vault_mapping_active; then
  prov_fail "$EX_VAULT" 'mapping still active after close; inspect with vault-status.sh'
fi
disarm_cleanup

NEW_UUID="$(cryptsetup luksUUID "$DEVICE" 2>/dev/null || true)"
printf '%s' "$NEW_UUID" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' \
  || prov_fail "$EX_VAULT" 'cannot read back the LUKS UUID of the new container'

out "provisioned: $DEVICE"
out "VAULT_LUKS_UUID=$NEW_UUID"
out "next: pin VAULT_LUKS_UUID=$NEW_UUID into $CONFIG (by the supervisor), then unlock with unlock-vault.sh"
exit "$EX_OK"
