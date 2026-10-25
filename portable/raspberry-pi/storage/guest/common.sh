#!/bin/bash
# common.sh — shared helpers for the portable storage guest scripts.
#
# Sourced (never executed) by provision-vault.sh, unlock-vault.sh,
# lock-vault.sh, vault-status.sh, verify-fs-boundary.sh, volatile-root.sh and
# deploy.sh. It is side-effect free: callers set `set -euo pipefail`, umask
# and LC_ALL themselves. IMPORTANT: this file is itself UNTRUSTED code from
# the entrypoints' point of view — every lifecycle entrypoint validates its
# own script tree (root ownership, exact 0755 modes, no symlinks, trusted
# ancestor chain) with an INLINE bootstrap BEFORE the `source` line; that
# verifier deliberately cannot live here.
#
# Configuration is parsed, never sourced or eval'd: vault.conf is untrusted
# text. EVERY key must be an exact literal member of the known-key set below
# before it is used in any way (including associative-array subscripts). There
# is deliberately no eval anywhere in this file.

# Exit codes (documented in portable/raspberry-pi/storage/README.md).
EX_OK=0        # success
EX_USAGE=2     # bad command line or bad passphrase channel input
EX_BUSY=3      # vault busy; it remains unlocked and visible, nothing forced
EX_VAULT=4     # vault operation failed (wrong key, missing filesystem, ...)
EX_CONFIG=5    # vault.conf missing, untrusted, or invalid
EX_PRECOND=6   # precondition failed (not root, missing tool, wrong device ...)

script_name() { basename "${0##*/}"; }

log() { printf '%s: %s\n' "$(script_name)" "$*" >&2; }
out() { printf '%s\n' "$*"; }

die() { # die <exit-code> <message...>  (refusal; message is the last stderr line)
  local code="$1"; shift
  printf '%s: refused: %s\n' "$(script_name)" "$*" >&2
  exit "$code"
}

fail() { # fail <exit-code> <message...>  (operational failure, not a refusal)
  local code="$1"; shift
  printf '%s: error: %s\n' "$(script_name)" "$*" >&2
  exit "$code"
}

usage_error() { # usage_error <message...>
  printf '%s: usage: %s\n' "$(script_name)" "$*" >&2
  exit "$EX_USAGE"
}

require_root() {
  local uid
  uid="$(id -u)" || fail "$EX_PRECOND" 'cannot determine uid'
  [ "$uid" = 0 ] || die "$EX_PRECOND" 'must run as root (EUID 0)'
}

require_command() { # require_command <tool> [purpose]
  command -v "$1" >/dev/null 2>&1 \
    || fail "$EX_PRECOND" "required tool not found: $1${2:+ ($2)}; run check-prereqs.sh"
}

# --- vault.conf parsing ------------------------------------------------------
#
# Schema (see vault.conf.example). Unknown or duplicate keys are refused, so a
# tampered or misunderstood file can never smuggle extra behavior in.
readonly _c_uuid_re='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
readonly _c_account_re='^[a-z_][a-z0-9_-]{0,31}$'
readonly _c_mapper_re='^[A-Za-z0-9][A-Za-z0-9_.-]{0,30}$'
readonly _c_run_path_re='^/run/[a-zA-Z0-9/_-]{0,60}$'

_c_check_no_dotdot() {
  case "$1" in *..*) return 1 ;; esac
  return 0
}

_c_uuid_or_empty() {
  [ -z "$1" ] || printf '%s' "$1" | grep -Eq "$_c_uuid_re"
}

_c_mount_options_ok() { # must contain nodev,nosuid,noexec; only whitelisted words
  local opts="$1" o ok_nodev=0 ok_nosuid=0 ok_noexec=0
  [ -n "$opts" ] || return 1
  local IFS=','
  for o in $opts; do
    case "$o" in
      nodev) ok_nodev=1 ;;
      nosuid) ok_nosuid=1 ;;
      noexec) ok_noexec=1 ;;
      rw) ;;
      *) return 1 ;;
    esac
  done
  [ "$ok_nodev" = 1 ] && [ "$ok_nosuid" = 1 ] && [ "$ok_noexec" = 1 ]
}

_c_uid_list_ok() { # comma separated account names, non-empty, no root
  local list="$1" item
  [ -n "$list" ] || return 1
  local IFS=','
  for item in $list; do
    printf '%s' "$item" | grep -Eq "$_c_account_re" || return 1
    case "$item" in root|portable-ui|portable-agent) return 1 ;; esac
  done
  return 0
}

# _c_known_key <key>: rc 0 only when the key is an EXACT literal member of the
# known-key set. This case statement is the whole authority for key validity:
# no regex prefix matching, no eval, no partial validation. A key is used in
# an associative-array subscript only after passing this check, so subscript
# metacharacters (] @ *) can never reach an expansion.
_c_known_key() {
  case "$1" in
    VAULT_LUKS_UUID|VAULT_MAPPER_NAME|VAULT_FSTYPE|VAULT_MOUNTPOINT|VAULT_MOUNT_OPTIONS|\
VAULT_MOUNT_SUBDIR_CREDIT|VAULT_MOUNT_SUBDIR_AGENT|VAULT_MOUNT_SUBDIR_UI|\
BROKER_SOCKET_DIR|BROKER_SOCKET_NAME|BROKER_GROUP|BROKER_ALLOWED_UIDS)
      return 0 ;;
    *) return 1 ;;
  esac
}

_c_disp() { # bounded display form of unvalidated text (never executed, just shown)
  local s="${1:0:64}"
  printf '%s' "$s"
}

# load_config <file>
# Sets CONFIG_* globals. Refuses (EX_CONFIG) on any deviation from the schema.
# This function only PARSES; production entry points use load_trusted_config
# (trust chain + parse). Parser-level tests may call load_config directly.
load_config() {
  local file="$1"
  [ -f "$file" ] || die "$EX_CONFIG" "vault configuration not found: $file (deploy with deploy.sh first)"
  local size
  size="$(wc -c < "$file")" || fail "$EX_PRECOND" "cannot stat $file"
  [ "$size" -le 4096 ] || die "$EX_CONFIG" "vault configuration too large (${size} bytes, max 4096): $file"

  # Defaults (everything except the UUID, which is pinned after provisioning).
  CONFIG_VAULT_LUKS_UUID=
  CONFIG_VAULT_MAPPER_NAME=portable-vault
  CONFIG_VAULT_FSTYPE=ext4
  CONFIG_VAULT_MOUNTPOINT=/run/portable-vault
  CONFIG_VAULT_MOUNT_OPTIONS=nodev,nosuid,noexec
  CONFIG_VAULT_MOUNT_SUBDIR_CREDIT=credit
  CONFIG_VAULT_MOUNT_SUBDIR_AGENT=agent
  CONFIG_VAULT_MOUNT_SUBDIR_UI=ui
  CONFIG_BROKER_SOCKET_DIR=/run/portable-control
  CONFIG_BROKER_SOCKET_NAME=broker.sock
  CONFIG_BROKER_GROUP=portable-operators
  CONFIG_BROKER_ALLOWED_UIDS=portable-credit

  local -A seen=()
  local line key value lineno=0
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    case "$line" in
      ''|'#'*) continue ;;
    esac
    case "$line" in
      *=*) ;;
      *) die "$EX_CONFIG" "$file:$lineno: expected KEY=VALUE, got unparsable line ($(_c_disp "$line"))" ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    # Unknown keys are refused BEFORE any other use of the key text
    # (including subscripts): injection via key text is impossible.
    _c_known_key "$key" \
      || die "$EX_CONFIG" "$file:$lineno: unknown key: $(_c_disp "$key")"
    if [ -n "${seen[$key]+x}" ]; then
      die "$EX_CONFIG" "$file:$lineno: duplicate key: $key"
    fi
    seen["$key"]=1
    case "$key" in
      VAULT_LUKS_UUID)
        _c_uuid_or_empty "$value" || die "$EX_CONFIG" "$file:$lineno: VAULT_LUKS_UUID must be empty or a lowercase canonical UUID"
        CONFIG_VAULT_LUKS_UUID="$value"
        ;;
      VAULT_MAPPER_NAME)
        printf '%s' "$value" | grep -Eq "$_c_mapper_re" || die "$EX_CONFIG" "$file:$lineno: invalid VAULT_MAPPER_NAME"
        CONFIG_VAULT_MAPPER_NAME="$value"
        ;;
      VAULT_FSTYPE)
        [ "$value" = ext4 ] || die "$EX_CONFIG" "$file:$lineno: VAULT_FSTYPE must be ext4"
        CONFIG_VAULT_FSTYPE="$value"
        ;;
      VAULT_MOUNTPOINT)
        printf '%s' "$value" | grep -Eq "$_c_run_path_re" || die "$EX_CONFIG" "$file:$lineno: VAULT_MOUNTPOINT must be an absolute /run/... path"
        _c_check_no_dotdot "$value" || die "$EX_CONFIG" "$file:$lineno: VAULT_MOUNTPOINT must not contain '..'"
        CONFIG_VAULT_MOUNTPOINT="$value"
        ;;
      VAULT_MOUNT_OPTIONS)
        _c_mount_options_ok "$value" || die "$EX_CONFIG" "$file:$lineno: VAULT_MOUNT_OPTIONS must be nodev,nosuid,noexec (optionally rw; nothing else)"
        CONFIG_VAULT_MOUNT_OPTIONS="$value"
        ;;
      VAULT_MOUNT_SUBDIR_CREDIT|VAULT_MOUNT_SUBDIR_AGENT|VAULT_MOUNT_SUBDIR_UI)
        printf '%s' "$value" | grep -Eq '^[a-z][a-z0-9_-]{0,15}$' || die "$EX_CONFIG" "$file:$lineno: $key must be a simple directory name"
        case "$key" in
          VAULT_MOUNT_SUBDIR_CREDIT) CONFIG_VAULT_MOUNT_SUBDIR_CREDIT="$value" ;;
          VAULT_MOUNT_SUBDIR_AGENT) CONFIG_VAULT_MOUNT_SUBDIR_AGENT="$value" ;;
          VAULT_MOUNT_SUBDIR_UI) CONFIG_VAULT_MOUNT_SUBDIR_UI="$value" ;;
        esac
        ;;
      BROKER_SOCKET_DIR)
        printf '%s' "$value" | grep -Eq "$_c_run_path_re" || die "$EX_CONFIG" "$file:$lineno: BROKER_SOCKET_DIR must be an absolute /run/... path"
        _c_check_no_dotdot "$value" || die "$EX_CONFIG" "$file:$lineno: BROKER_SOCKET_DIR must not contain '..'"
        CONFIG_BROKER_SOCKET_DIR="$value"
        ;;
      BROKER_SOCKET_NAME)
        printf '%s' "$value" | grep -Eq '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$' || die "$EX_CONFIG" "$file:$lineno: invalid BROKER_SOCKET_NAME"
        CONFIG_BROKER_SOCKET_NAME="$value"
        ;;
      BROKER_GROUP)
        printf '%s' "$value" | grep -Eq "$_c_account_re" || die "$EX_CONFIG" "$file:$lineno: invalid BROKER_GROUP"
        CONFIG_BROKER_GROUP="$value"
        ;;
      BROKER_ALLOWED_UIDS)
        _c_uid_list_ok "$value" || die "$EX_CONFIG" "$file:$lineno: BROKER_ALLOWED_UIDS must be comma-separated account names, excluding root/portable-ui/portable-agent, non-empty"
        CONFIG_BROKER_ALLOWED_UIDS="$value"
        ;;
      *)
        # Unreachable: _c_known_key already refused everything else.
        die "$EX_CONFIG" "$file:$lineno: unknown key: $(_c_disp "$key")"
        ;;
    esac
  done < "$file"

  # Distinct subdirectories and a socket directory distinct from the vault
  # mount (mounting the vault would bury the socket).
  local a="$CONFIG_VAULT_MOUNTPOINT/$CONFIG_VAULT_MOUNT_SUBDIR_CREDIT"
  local b="$CONFIG_VAULT_MOUNTPOINT/$CONFIG_VAULT_MOUNT_SUBDIR_AGENT"
  local c="$CONFIG_VAULT_MOUNTPOINT/$CONFIG_VAULT_MOUNT_SUBDIR_UI"
  [ "$a" != "$b" ] && [ "$a" != "$c" ] && [ "$b" != "$c" ] \
    || die "$EX_CONFIG" "vault subdirectories must be distinct"
  [ "$CONFIG_BROKER_SOCKET_DIR" != "$CONFIG_VAULT_MOUNTPOINT" ] \
    && [ "${CONFIG_BROKER_SOCKET_DIR#"$CONFIG_VAULT_MOUNTPOINT"/}" = "$CONFIG_BROKER_SOCKET_DIR" ] \
    || die "$EX_CONFIG" "BROKER_SOCKET_DIR must be outside the vault mountpoint"
  [ "$CONFIG_VAULT_MAPPER_NAME" != control ] \
    || die "$EX_CONFIG" "VAULT_MAPPER_NAME 'control' is reserved"
}

require_config_uuid() {
  [ -n "$CONFIG_VAULT_LUKS_UUID" ] \
    || die "$EX_CONFIG" 'VAULT_LUKS_UUID is empty in vault.conf: provision a fresh vault disk first (provision-vault.sh), then pin the printed UUID into the configuration'
}

# --- trust chain (production authority model) --------------------------------
#
# Production scripts and the broker only act on files inside a root-owned,
# non-group/world-writable, symlink-free ancestor chain. The checks are plain
# stat/lstat facts; they never confer privilege and there is no "test mode"
# flag that disables them. Offline/staged trees simply fail these checks until
# actually deployed as root (that is the point).

require_trusted_dir() { # <dir>: real directory, root-owned, not group/world-writable
  local d="$1" owner mode
  [ -e "$d" ] || die "$EX_CONFIG" "trust: missing directory: $d"
  [ -d "$d" ] || die "$EX_CONFIG" "trust: not a directory: $d"
  [ ! -L "$d" ] || die "$EX_CONFIG" "trust: refusing symlinked directory: $d"
  owner="$(stat -c '%u' "$d")"
  [ "$owner" = 0 ] || die "$EX_CONFIG" "trust: $d is owned by uid $owner, not root"
  mode="$(stat -c '%a' "$d")"
  [ $(( 0$mode & 022 )) -eq 0 ] \
    || die "$EX_CONFIG" "trust: $d (mode $mode) is group- or world-writable"
}

require_trusted_dir_chain() { # <absolute-path>: every ancestor from / down
  local p="$1" acc=/ rest comp
  case "$p" in
    /*) ;;
    *) die "$EX_CONFIG" "trust: not an absolute path: $p" ;;
  esac
  rest="${p#/}"
  while [ -n "$rest" ]; do
    comp="${rest%%/*}"
    if [ "$comp" = "$rest" ]; then rest=; else rest="${rest#*/}"; fi
    [ -n "$comp" ] || continue
    acc="$acc$comp"
    require_trusted_dir "$acc"
    acc="$acc/"
  done
}

require_trusted_file() { # <file> <exact-mode-octal>: regular, not a symlink,
  local f="$1" mode_want="$2" owner mode   # root-owned, exact mode, safe chain
  [ -e "$f" ] || die "$EX_CONFIG" "trust: missing file: $f"
  [ -f "$f" ] || die "$EX_CONFIG" "trust: not a regular file: $f"
  [ ! -L "$f" ] || die "$EX_CONFIG" "trust: refusing symlinked file: $f"
  owner="$(stat -c '%u' "$f")"
  [ "$owner" = 0 ] || die "$EX_CONFIG" "trust: $f is owned by uid $owner, not root"
  mode="$(stat -c '%a' "$f")"
  [ "$mode" = "$mode_want" ] \
    || die "$EX_CONFIG" "trust: $f mode is $mode (must be $mode_want)"
  require_trusted_dir_chain "$(dirname "$f")"
}

require_trusted_config() { # <file>
  require_trusted_file "$1" 600
}

# require_trusted_helper_tree <dir> <file-basename>...: the directory holding
# the sourced/invoked helper scripts must itself be a trusted tree with each
# named file root-owned, mode 0755 and not a symlink.
require_trusted_helper_tree() {
  local dir="$1"; shift
  require_trusted_dir_chain "$dir"
  local f
  for f in "$@"; do
    require_trusted_file "$dir/$f" 755
  done
}

load_trusted_config() { # <file>: production config authority = trust + parse
  require_trusted_config "$1"
  load_config "$1"
}

# --- lifecycle lock -----------------------------------------------------------
#
# ALL provision/unlock/lock/status interactions serialize on ONE exclusive
# flock held for the whole operation (status takes a shared lock). The lock
# lives at ONE FIXED PATH, deliberately NOT derived from the config path:
# two supported root-owned configs in different directories can name the
# same mapper, and a per-config lock would let lifecycle operations on those
# aliases race each other (check-before-act on the same kernel state). The
# schema for VAULT_MOUNTPOINT and BROKER_SOCKET_DIR (^[a-zA-Z0-9/_-]+$ under
# /run) can never contain this dot-file name, so no configured mount or
# socket directory can bury it. /run itself must be a trusted directory
# (root-owned, not group/world-writable) — checked below like every other
# trust fact. A check-before-act race between lifecycle entry points is
# therefore impossible: the check and the act happen under one lock.
LIFECYCLE_LOCK_FD=9
LIFECYCLE_LOCK_WAIT_S=600
LIFECYCLE_LOCK_PATH=/run/.portable-vault-lifecycle.lock

lifecycle_lock_file() { # <config-path> (argument unused: the lock is at one
  printf '%s' "$LIFECYCLE_LOCK_PATH"  # fixed path for ALL configs/aliases)
}

acquire_lifecycle_lock() { # <exclusive|shared> <config-path>
  local mode="$1" cfg="$2" lf fd_stat path_stat
  require_trusted_dir /run
  lf="$(lifecycle_lock_file "$cfg")"
  if [ -e "$lf" ] && [ -L "$lf" ]; then
    die "$EX_PRECOND" "lifecycle lock $lf is a symlink; refusing (inspect manually)"
  fi
  exec 9>"$lf" || die "$EX_PRECOND" "cannot open lifecycle lock $lf"
  # The open descriptor and the path must agree (no replacement race), be
  # root:root and mode 0600. A pre-existing lock with drifted ownership or
  # mode is a refusal, not something to fix silently.
  fd_stat="$(stat -Lc '%u:%g:%a:%d:%i' /proc/self/fd/9 2>/dev/null)" \
    || die "$EX_PRECOND" "cannot stat lifecycle lock descriptor"
  path_stat="$(stat -Lc '%u:%g:%a:%d:%i' "$lf" 2>/dev/null)" \
    || die "$EX_PRECOND" "cannot stat lifecycle lock $lf"
  case "$fd_stat" in
    0:0:600:*) ;;
    *) die "$EX_PRECOND" "lifecycle lock $lf must be root:root mode 0600 (observed $fd_stat); refusing" ;;
  esac
  [ "$fd_stat" = "$path_stat" ] \
    || die "$EX_PRECOND" "lifecycle lock $lf changed while opening (observed $path_stat vs $fd_stat); refusing"
  if [ "$mode" = shared ]; then
    flock -s -w "$LIFECYCLE_LOCK_WAIT_S" "$LIFECYCLE_LOCK_FD" \
      || die "$EX_BUSY" "another vault lifecycle operation holds the lock; no state was changed"
  else
    flock -x -w "$LIFECYCLE_LOCK_WAIT_S" "$LIFECYCLE_LOCK_FD" \
      || die "$EX_BUSY" "another vault lifecycle operation holds the lock; no state was changed"
  fi
  LIFECYCLE_LOCK_HELD="$mode"
}

# --- vault state helpers (all external probes; stub-friendly for tests) ------

vault_mapping_active() {
  # Boolean only when known: 0=active, 1=independently confirmed absent.
  # Operational errors terminate the helper with explicit UNKNOWN state;
  # callers must never interpret a broken probe as permission to open/format.
  local rc inventory kname name extra rows=0
  if cryptsetup status "$CONFIG_VAULT_MAPPER_NAME" >/dev/null 2>&1; then
    return 0
  else
    rc=$?
  fi
  # cryptsetup documents 4 as wrong/nonexistent device, NOT general failure.
  # Even that code alone is insufficient evidence that a mapper is absent.
  [ "$rc" = 4 ] || die "$EX_PRECOND" "state: unknown — cryptsetup status probe failed (exit $rc); refusing lifecycle changes"
  # lsblk inventories kernel block devices via sysfs, independently of the
  # cryptsetup status command. Include all devices, without a device filter.
  # Raw NAME is the dm name; KNAME identifies every dm-* kernel node. A
  # successful, nonempty, well-formed inventory must contain no matching name.
  if ! inventory="$(lsblk -arn -o KNAME,NAME 2>/dev/null)"; then
    die "$EX_PRECOND" 'state: unknown — kernel mapper inventory failed; refusing lifecycle changes'
  fi
  while read -r kname name extra; do
    [ -n "$kname" ] && [ -n "$name" ] && [ -z "$extra" ] \
      || die "$EX_PRECOND" 'state: unknown — incomplete kernel mapper inventory; refusing lifecycle changes'
    rows=$((rows + 1))
    case "$kname" in
      dm-*)
        [ "$name" != "$CONFIG_VAULT_MAPPER_NAME" ] \
          || die "$EX_PRECOND" 'state: unknown — kernel mapper exists but cryptsetup status failed; refusing lifecycle changes'
        ;;
    esac
  done <<< "$inventory"
  [ "$rows" -gt 0 ] || die "$EX_PRECOND" 'state: unknown — empty kernel mapper inventory; refusing lifecycle changes'
  return 1
}

vault_backing_device() { # prints the backing device path of the ACTIVE mapping
  cryptsetup status "$CONFIG_VAULT_MAPPER_NAME" 2>/dev/null \
    | sed -n 's/^[[:space:]]*device:[[:space:]]*//p' | head -n 1
}

dev_id() { # dev_id <device-path>: canonical kernel identity "major:minor"
  lsblk -dn -o MAJ:MIN "$1" 2>/dev/null | tr -d ' '
}

vault_mapping_matches_device() { # <device>: rc 0 when the ACTIVE mapping's
  local back="$1"            # backing device IS <device> (major:minor compare)
  back="$(vault_backing_device)"
  [ -n "$back" ] || return 1
  local a b
  a="$(dev_id "$back")"
  b="$(dev_id "$1")"
  [ -n "$a" ] && [ -n "$b" ] && [ "$a" = "$b" ]
}

vault_mounted() {
  findmnt -rn -o TARGET "$CONFIG_VAULT_MOUNTPOINT" 2>/dev/null \
    | grep -Fxq "$CONFIG_VAULT_MOUNTPOINT"
}

vault_mount_options() { # prints mount options or fails when not mounted
  findmnt -rn -o OPTIONS "$CONFIG_VAULT_MOUNTPOINT" 2>/dev/null
}

# vault_mount_check: rc 0 when the mount at the configured mountpoint is
# EXACTLY the configured mount: ONE single mount entry, at the exact
# mountpoint, whose mounted device identity (kernel major:minor, not the
# SOURCE string — a same-named, same-labeled or stacked mount can report an
# identical string while sitting on a different device) IS the mapper block
# device, with the configured fstype and all configured mount options.
# On mismatch sets MOUNT_MATCH_MSG (bounded) and returns 1. Never mutates.
vault_mount_check() {
  local lines n src tgt fstype opts majmin want_mm want missing=
  MOUNT_MATCH_MSG=
  if ! lines="$(findmnt -rn -o SOURCE,TARGET,FSTYPE,OPTIONS,MAJ:MIN "$CONFIG_VAULT_MOUNTPOINT" 2>/dev/null)"; then
    MOUNT_MATCH_MSG="no mount at $CONFIG_VAULT_MOUNTPOINT"
    return 1
  fi
  n="$(printf '%s\n' "$lines" | grep -c . || true)"
  if [ "$n" != 1 ]; then
    MOUNT_MATCH_MSG="$n mount entries at $CONFIG_VAULT_MOUNTPOINT (stacked or overmounted state?); exactly one is required"
    return 1
  fi
  read -r src tgt fstype opts majmin <<EOF
$lines
EOF
  if [ "$tgt" != "$CONFIG_VAULT_MOUNTPOINT" ]; then
    MOUNT_MATCH_MSG="unexpected mount target '$(_c_disp "$tgt")' at $CONFIG_VAULT_MOUNTPOINT (expected the exact mountpoint; source string '$(_c_disp "$src")')"
    return 1
  fi
  want_mm="$(dev_id "/dev/mapper/$CONFIG_VAULT_MAPPER_NAME")"
  if [ -z "$want_mm" ]; then
    MOUNT_MATCH_MSG="cannot determine the device identity (major:minor) of /dev/mapper/$CONFIG_VAULT_MAPPER_NAME; refusing to claim the mount matches"
    return 1
  fi
  if [ "$majmin" != "$want_mm" ]; then
    MOUNT_MATCH_MSG="mounted device $majmin is NOT the mapper device ($want_mm): unexpected mount at $CONFIG_VAULT_MOUNTPOINT (source string '$(_c_disp "$src")'; same-string/same-label mounts are rejected by device identity)"
    return 1
  fi
  if [ "$fstype" != "$CONFIG_VAULT_FSTYPE" ]; then
    MOUNT_MATCH_MSG="mount fstype is $fstype (expected $CONFIG_VAULT_FSTYPE)"
    return 1
  fi
  local IFS=','
  for want in $CONFIG_VAULT_MOUNT_OPTIONS; do
    case ",$opts," in
      *",$want,"*) ;;
      *) missing="$missing $want" ;;
    esac
  done
  if [ -n "$missing" ]; then
    MOUNT_MATCH_MSG="mount options missing$missing (kernel reported: $opts)"
    return 1
  fi
  return 0
}

vault_find_devices_by_uuid() { # prints EVERY block device carrying the UUID
  lsblk -rn -o PATH,UUID 2>/dev/null \
    | awk -v u="$CONFIG_VAULT_LUKS_UUID" '$2 == u { print $1 }'
}

# vault_resolve_device: resolves the configured LUKS UUID to exactly ONE
# canonical device, cross-checked with blkid (type crypto_LUKS, same UUID).
# Sets RESOLVED_DEV / RESOLVE_ERR; rc 0 on success. Never dies, never mutates:
# status reporting uses it informationally, mutating paths wrap it with
# require_resolved_device.
vault_resolve_device() {
  RESOLVED_DEV=
  RESOLVE_ERR=
  local matches n first btype buuid
  matches="$(vault_find_devices_by_uuid)"
  n="$(printf '%s' "$matches" | grep -c . || true)"
  if [ "$n" -eq 0 ]; then
    RESOLVE_ERR="no block device with configured VAULT_LUKS_UUID $CONFIG_VAULT_LUKS_UUID is attached (checked via lsblk; refusing to guess device names)"
    return 1
  fi
  if [ "$n" -gt 1 ]; then
    RESOLVE_ERR="duplicate devices carry VAULT_LUKS_UUID $CONFIG_VAULT_LUKS_UUID ($(printf '%s ' $matches)); resolve the duplicate before any vault operation"
    return 1
  fi
  first="$(printf '%s' "$matches" | head -n 1)"
  if ! btype="$(blkid -s TYPE -o value "$first" 2>/dev/null)"; then
    RESOLVE_ERR="blkid probe failed on $first (probe errors are refusals, not 'blank')"
    return 1
  fi
  if ! buuid="$(blkid -s UUID -o value "$first" 2>/dev/null)"; then
    RESOLVE_ERR="blkid UUID probe failed on $first"
    return 1
  fi
  if [ "$btype" != crypto_LUKS ]; then
    RESOLVE_ERR="$first carries UUID $CONFIG_VAULT_LUKS_UUID but blkid reports TYPE=$btype (expected crypto_LUKS)"
    return 1
  fi
  if [ "$buuid" != "$CONFIG_VAULT_LUKS_UUID" ]; then
    RESOLVE_ERR="$first blkid UUID $buuid disagrees with the configured UUID"
    return 1
  fi
  RESOLVED_DEV="$first"
  return 0
}

require_resolved_device() {
  vault_resolve_device || die "$EX_PRECOND" "$RESOLVE_ERR"
}

# --- passphrase channel -------------------------------------------------------
#
# Contract (provision AND unlock, enforced identically): the passphrase is
# NUL-free text, 1..512 bytes, read once from this script's stdin, held as
# hex text in shell memory only, and fed byte-exactly to cryptsetup via a
# pipe (--key-file=-). It is never an argument, environment variable, log
# line or key file. Bash variables cannot hold NUL bytes, so NUL is REFUSED
# up front on both paths: whatever provision wrote is byte-identical to what
# unlock later feeds, with no NUL ambiguity.
PASS_HEX=
PASS_BYTES=0

passphrase_read_stdin() { # reads bounded stdin into PASS_HEX; dies on contract violations
  local hex n
  # dd caps the read at 514 bytes: 512 for the passphrase, plus a 514th-byte
  # probe so oversize input is detected rather than silently truncated.
  hex="$(dd bs=514 count=1 iflag=fullblock status=none 2>/dev/null | od -An -v -tx1 | tr -d ' \n')"
  n=$(( ${#hex} / 2 ))
  [ "$n" -ge 1 ] || die "$EX_USAGE" 'empty passphrase on stdin; pipe the passphrase bytes (private channel only)'
  [ "$n" -le 512 ] || die "$EX_USAGE" "passphrase longer than 512 bytes ($n)"
  if printf '%s' "$hex" | fold -w 2 | grep -qx 00; then
    die "$EX_USAGE" 'passphrase contains a NUL byte: the passphrase channel is valid NUL-free text (1..512 bytes)'
  fi
  PASS_HEX="$hex"
  PASS_BYTES="$n"
}

passphrase_feed() { # prints the EXACT stdin bytes for cryptsetup --key-file=-
  local i=0 esc=
  while [ "$i" -lt "${#PASS_HEX}" ]; do
    esc="$esc\\$(printf '%03o' "$(( 0x${PASS_HEX:$i:2} ))")"
    i=$((i + 2))
  done
  printf '%b' "$esc"
}

passphrase_scrub() { # best-effort overwrite of the in-memory copy
  PASS_HEX="$(head -c 128 /dev/urandom 2>/dev/null | od -An -tx1 | tr -d ' \n' || true)"
  PASS_BYTES=0
}
