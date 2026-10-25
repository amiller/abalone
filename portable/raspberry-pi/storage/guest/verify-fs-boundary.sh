#!/bin/bash
# verify-fs-boundary.sh — verify the storage slice's security boundaries on a
# live guest (or, with --sysroot, on a mounted/offline image; with --staged,
# owner checks that need root downgrade to warnings).
#
# Every check prints PASS/FAIL/WARN with the observed fact. Exit 1 on any
# FAIL, 0 otherwise. This script only reads: it mutates nothing.
#
# Checks (milestone vault): config schema + UUID pinned + trust chain; late
# unlock really outside fstab/crypttab; mapping active for the configured
# UUID AND identity-matched to the resolved device; single mount with exact
# source/fstype at the exact mountpoint, nodev,nosuid,noexec, shared
# propagation; per-account subdirectory modes/owners; account/group
# membership from passwd/group files; root-owned /opt/portable with no
# group- or world-writable files; vault.conf mode 0600 + root-owned + not a
# symlink; lifecycle lock file root:root 0600; broker socket mode AND GROUP;
# unit hardening per the mount authority model (broker: NO
# mount-namespace-inducing directives; consumers: vault visible, UI
# vault-independent), statically checked with systemd-analyze verify when
# available (absence is a labelled WARN, never a pass).
#
# milestone volatile-root: CONFIGURATION-LEVEL checks only. Live volatile-root
# qualification (findmnt/mountinfo root-upper/lower audit, tmpfs backing of
# upperdir/workdir, read-only lower/boot, swap, reboot canaries) is DEFERRED
# and explicitly NOT claimed here — see portable/raspberry-pi/storage/README.md.
#
# Usage: verify-fs-boundary.sh [--milestone vault|volatile-root]
#                              [--prefix /opt/portable] [--sysroot /]
#                              [--staged]
set -euo pipefail
umask 077
LC_ALL=C
export LC_ALL
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

MILESTONE=vault
PREFIX=/opt/portable
SYSROOT=
STAGED=no
while [ $# -gt 0 ]; do
  case "$1" in
    --milestone) [ $# -ge 2 ] || usage_error '--milestone requires a value'; MILESTONE="$2"; shift 2 ;;
    --milestone=*) MILESTONE="${1#*=}"; shift ;;
    --prefix) [ $# -ge 2 ] || usage_error '--prefix requires a value'; PREFIX="$2"; shift 2 ;;
    --prefix=*) PREFIX="${1#*=}"; shift ;;
    --sysroot) [ $# -ge 2 ] || usage_error '--sysroot requires a value'; SYSROOT="$2"; shift 2 ;;
    --sysroot=*) SYSROOT="${1#*=}"; shift ;;
    --staged) STAGED=yes; shift ;;
    -h|--help) sed -n '3,28p' "$0"; exit 0 ;;
    *) usage_error "unknown argument: $1" ;;
  esac
done
case "$MILESTONE" in vault|volatile-root) ;; *) usage_error "bad milestone: $MILESTONE" ;; esac
[ -z "$SYSROOT" ] && SYSROOT=/
case "$SYSROOT" in /*) ;; *) usage_error '--sysroot must be an absolute path' ;; esac
case "$PREFIX" in /*) ;; *) usage_error '--prefix must be an absolute path' ;; esac

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0
pass() { printf 'PASS %s\n' "$1"; PASS_COUNT=$((PASS_COUNT + 1)); }
failc() { printf 'FAIL %s\n' "$1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
warn() { printf 'WARN %s\n' "$1"; WARN_COUNT=$((WARN_COUNT + 1)); }
check_bool() { # check_bool <description> <0 ok|1 fail>
  if [ "$2" = 0 ]; then pass "$1"; else failc "$1"; fi
}
owner_check() { # owner_check <description> <path> <expected-owner>
  local got
  got="$(stat -c '%U' "$2" 2>/dev/null || echo '<missing>')"
  if [ "$got" = "$3" ]; then
    pass "$1"
  elif [ "$STAGED" = yes ] && [ "$(id -u)" != 0 ]; then
    warn "$1 (staged mode, not root: owner is '$got', expected '$3')"
  else
    failc "$1 (owner is '$got', expected '$3')"
  fi
}
group_check() { # group_check <description> <path> <expected-group>
  local got
  got="$(stat -c '%G' "$2" 2>/dev/null || echo '<missing>')"
  if [ "$got" = "$3" ]; then
    pass "$1"
  elif [ "$STAGED" = yes ] && [ "$(id -u)" != 0 ]; then
    warn "$1 (staged mode, not root: group is '$got', expected '$3')"
  else
    failc "$1 (group is '$got', expected '$3')"
  fi
}

# The verifier only PARSES the config (trust facts are checked explicitly
# below so they can be reported as PASS/FAIL instead of aborting).
load_config "$PREFIX/etc/vault.conf"
pass "vault.conf parses against the strict schema (no-eval known-key parser)"

# sr <absolute-path>: join with --sysroot for offline image checks.
sr() {
  if [ "$SYSROOT" = / ]; then printf '%s' "$1"
  else printf '%s%s' "$SYSROOT" "$1"
  fi
}
LIVE=yes
[ "$SYSROOT" = / ] || LIVE=no

check_bool "VAULT_LUKS_UUID pinned (non-empty)" $([ -n "$CONFIG_VAULT_LUKS_UUID" ]; echo $?)

# --- late unlock is OUTSIDE fstab and crypttab ---------------------------------
FSTAB="$SYSROOT/etc/fstab"
CRYPTTAB="$SYSROOT/etc/crypttab"
if [ -f "$FSTAB" ] && grep -vE '^\s*(#|$)' "$FSTAB" | grep -Eq "($CONFIG_VAULT_MOUNTPOINT|/dev/mapper/$CONFIG_VAULT_MAPPER_NAME)"; then
  failc "fstab has an automatic mount entry for the vault (late unlock means none)"
else
  pass "fstab has no vault mount entry"
fi
if [ -f "$CRYPTTAB" ] && grep -vE '^\s*(#|$)' "$CRYPTTAB" | grep -Eq "($CONFIG_VAULT_LUKS_UUID|UUID=|/dev/mapper/$CONFIG_VAULT_MAPPER_NAME)"; then
  failc "crypttab has an automatic activation entry (late unlock means none)"
else
  pass "crypttab has no automatic vault activation entry"
fi

# --- live mapping/mount state (live guest only; skipped offline) --------------
if [ "$LIVE" = no ]; then
  warn "offline sysroot: live mapping/mount checks skipped (fstab/passwd/unit checks still run)"
elif vault_mapping_active; then
  pass "mapping '$CONFIG_VAULT_MAPPER_NAME' active"
  if vault_resolve_device; then
    pass "configured LUKS UUID resolves to exactly one device ($RESOLVED_DEV, blkid-verified)"
    if vault_mapping_matches_device "$RESOLVED_DEV"; then
      pass "active mapping backing device identity-matches $RESOLVED_DEV (major:minor)"
    else
      failc "active mapping backs a DIFFERENT device than $RESOLVED_DEV (unexpected mapper; lifecycle scripts refuse to touch it)"
    fi
  else
    failc "cannot resolve configured VAULT_LUKS_UUID ($RESOLVE_ERR)"
  fi
else
  warn "mapping inactive (locked or never unlocked): mount checks skipped"
fi

if [ "$LIVE" = yes ] && vault_mounted; then
  if vault_mount_check; then
    pass "mount is exactly /dev/mapper/$CONFIG_VAULT_MAPPER_NAME at $CONFIG_VAULT_MOUNTPOINT, fstype $CONFIG_VAULT_FSTYPE, nodev,nosuid,noexec"
  else
    failc "$MOUNT_MATCH_MSG"
  fi
  PROP="$(findmnt -rn -o PROPAGATION "$CONFIG_VAULT_MOUNTPOINT" 2>/dev/null || true)"
  case ",$PROP," in
    *,shared,*) pass "mount propagation is shared ($PROP)" ;;
    *) failc "mount propagation is not shared ($PROP): services in private namespaces would lose the vault" ;;
  esac
  N_MOUNTS="$(findmnt -rn -S "/dev/mapper/$CONFIG_VAULT_MAPPER_NAME" | wc -l)"
  check_bool "vault device mounted exactly once (found $N_MOUNTS)" $([ "$N_MOUNTS" = 1 ]; echo $?)
  for pair in "$CONFIG_VAULT_MOUNT_SUBDIR_CREDIT:portable-credit" "$CONFIG_VAULT_MOUNT_SUBDIR_AGENT:portable-agent" "$CONFIG_VAULT_MOUNT_SUBDIR_UI:portable-ui"; do
    SUB="${pair%%:*}"
    ACCT="${pair##*:}"
    DIR="$CONFIG_VAULT_MOUNTPOINT/$SUB"
    MODE="$(stat -c '%a' "$DIR" 2>/dev/null || echo missing)"
    check_bool "$DIR exists mode 0700 (got $MODE)" $([ "$MODE" = 700 ]; echo $?)
    owner_check "$DIR owned by $ACCT" "$DIR" "$ACCT"
    group_check "$DIR group $ACCT" "$DIR" "$ACCT"
  done
else
  warn "vault not mounted (locked or never unlocked): mount checks skipped"
fi

# --- accounts and groups from the guest's own passwd/group ----------------------
PASSWD="$SYSROOT/etc/passwd"
GROUP="$SYSROOT/etc/group"
for account in portable-agent portable-ui portable-credit; do
  if [ -f "$PASSWD" ] && grep -q "^$account:" "$PASSWD"; then
    pass "account $account exists in $PASSWD"
    SHELL="$(grep "^$account:" "$PASSWD" | cut -d: -f7)"
    case "$SHELL" in
      /usr/sbin/nologin|/sbin/nologin|/bin/false|/usr/bin/false) pass "account $account shell is nologin ($SHELL)" ;;
      *) failc "account $account shell is $SHELL (expected nologin)" ;;
    esac
  else
    failc "account $account missing from $PASSWD"
  fi
done
if [ -f "$GROUP" ] && grep -q "^portable-operators:" "$GROUP"; then
  pass "group portable-operators exists"
  MEMBERS="$(grep '^portable-operators:' "$GROUP" | cut -d: -f4 | tr ',' ' ')"
  for account in portable-agent portable-ui; do
    case " $MEMBERS " in
      *" $account "*) failc "$account IS in portable-operators (must never be)" ;;
      *) pass "$account not in portable-operators" ;;
    esac
  done
  case " $MEMBERS " in
    *' portable-credit '*) pass 'portable-credit in portable-operators' ;;
    *) failc 'portable-credit missing from portable-operators' ;;
  esac
  case " $MEMBERS " in
    *' root '*) failc "root listed in portable-operators members (must not be)" ;;
    *) pass "root not listed in portable-operators" ;;
  esac
else
  failc "group portable-operators missing from $GROUP"
fi
if [ -f "$GROUP" ] && grep -qE '^(sudo|wheel):.*portable-(agent|ui)' "$GROUP"; then
  failc "workspace account appears in sudo/wheel"
else
  pass "workspace accounts not in sudo/wheel"
fi

# --- deployed tree --------------------------------------------------------------
if [ -d "$PREFIX" ]; then
  WWRITES="$(find "$PREFIX" -perm /022 2>/dev/null | head -n1)"
  check_bool "no group- or world-writable files under $PREFIX" $([ -z "$WWRITES" ]; echo $?)
  CONF="$PREFIX/etc/vault.conf"
  if [ -L "$CONF" ]; then
    failc "vault.conf is a SYMLINK (must be a regular file)"
  else
    pass "vault.conf is not a symlink"
  fi
  CONF_MODE="$(stat -c '%a' "$CONF" 2>/dev/null || echo missing)"
  check_bool "vault.conf mode 0600 (got $CONF_MODE)" $([ "$CONF_MODE" = 600 ]; echo $?)
  owner_check "$PREFIX tree owner" "$PREFIX" root
  owner_check "vault.conf owner root" "$CONF" root
  if [ "$(id -u)" = 0 ]; then
    NONROOT="$(find "$PREFIX" \! -user root 2>/dev/null | head -n1)"
    check_bool "every file under $PREFIX owned by root" $([ -z "$NONROOT" ]; echo $?)
  elif [ "$STAGED" = yes ]; then
    warn "root-ownership check needs root (staged mode)"
  fi
  # The lifecycle lock is at ONE fixed path for every entrypoint and every
  # config alias (see common.sh); check it through the sysroot when offline.
  LOCKFILE="$(sr "$LIFECYCLE_LOCK_PATH")"
  if [ -e "$LOCKFILE" ]; then
    if [ -L "$LOCKFILE" ]; then
      failc "lifecycle lock is a SYMLINK (must be a regular file)"
    else
      LM="$(stat -c '%U:%G %a' "$LOCKFILE")"
      check_bool "lifecycle lock root:root 0600 (got $LM)" $([ "$LM" = "root:root 600" ]; echo $?)
    fi
  else
    warn "lifecycle lock absent (no lifecycle operation has run yet)"
  fi
else
  failc "$PREFIX missing (deploy.sh not run?)"
fi

# --- broker socket (path joined with --sysroot when offline) ----------------------
SOCKET_HOST_PATH="$CONFIG_BROKER_SOCKET_DIR/$CONFIG_BROKER_SOCKET_NAME"
SOCKET="$(sr "$SOCKET_HOST_PATH")"
if [ -S "$SOCKET" ]; then
  MODE="$(stat -c '%a' "$SOCKET")"
  check_bool "broker socket mode 0660 (got $MODE)" $([ "$MODE" = 660 ]; echo $?)
  owner_check "broker socket owner root" "$SOCKET" root
  group_check "broker socket GROUP $CONFIG_BROKER_GROUP" "$SOCKET" "$CONFIG_BROKER_GROUP"
  SOCKDIR="$(stat -c '%a' "$(sr "$CONFIG_BROKER_SOCKET_DIR")" 2>/dev/null || echo missing)"
  check_bool "broker socket dir mode 0750 (got $SOCKDIR)" $([ "$SOCKDIR" = 750 ]; echo $?)
  group_check "broker socket dir GROUP $CONFIG_BROKER_GROUP" "$(sr "$CONFIG_BROKER_SOCKET_DIR")" "$CONFIG_BROKER_GROUP"
else
  warn "broker socket not present at $SOCKET (broker not running?)"
fi

# --- unit hardening: the MOUNT AUTHORITY MODEL, checked on effective directives ---
# Mount-namespace-inducing directives: any of these on the BROKER unit would
# hide the late vault mount from the host namespace (see README). Consumer
# templates MAY use them (their namespace is a slave that receives late host
# mounts) but must not set PrivateMounts or private MountFlags.
UNIT_DIR="$PREFIX/systemd"
BROKER_UNIT="$UNIT_DIR/portable-vault-broker.service"
NS_DIRECTIVES='^(PrivateTmp|PrivateDevices|PrivateMounts|PrivateUsers|ProtectSystem|ProtectHome|ProtectKernelTunables|ProtectKernelModules|ProtectControlGroups|ReadOnlyPaths|ReadWritePaths|InaccessiblePaths|BindPaths|BindReadOnlyPaths|MountAPIVFS|RootDirectory|PivotRoot|MountFlags)='
if [ -d "$UNIT_DIR" ]; then
  if [ -f "$BROKER_UNIT" ]; then
    VIOL=''
    while IFS= read -r line; do
      case "$line" in
        '#'*|'') ;; # comments and blanks are documentation, not directives
        *) if printf '%s' "$line" | grep -Eq "$NS_DIRECTIVES"; then VIOL="$VIOL $line"; fi ;;
      esac
    done < "$BROKER_UNIT"
    check_bool "broker unit: NO mount-namespace-inducing directives (host mount namespace by design)" $([ -z "$VIOL" ]; echo $?)
    [ -n "$VIOL" ] && failc "broker unit violating directives:$VIOL"
    grep -q '^NoNewPrivileges=yes' "$BROKER_UNIT" \
      && pass "broker unit: NoNewPrivileges=yes" \
      || failc "broker unit: missing NoNewPrivileges=yes"
    CAPS_LINE="$(grep -E '^CapabilityBoundingSet=' "$BROKER_UNIT" | head -n1)"
    GOT_CAPS="$(printf '%s' "$CAPS_LINE" | cut -d= -f2 | tr -s ' \t' ' ' | sed 's/^ //;s/ $//' | tr ' ' '\n' | sort | tr '\n' ' ' | sed 's/ $//')"
    WANT_CAPS='CAP_CHOWN CAP_SYS_ADMIN'
    check_bool "broker unit: CapabilityBoundingSet exactly CAP_SYS_ADMIN CAP_CHOWN (got: ${GOT_CAPS:-none})" \
      $([ "$GOT_CAPS" = "$WANT_CAPS" ]; echo $?)
    grep -q '^RuntimeDirectory=portable-control' "$BROKER_UNIT" \
      && pass "broker unit: RuntimeDirectory=portable-control (runtime path created before the process starts)" \
      || failc "broker unit: RuntimeDirectory=portable-control missing"
    grep -q -- '--config /opt/portable/etc/vault.conf' "$BROKER_UNIT" \
      && pass "broker unit: ExecStart pins --config explicitly" \
      || failc "broker unit: ExecStart must pass --config explicitly"
  else
    warn "broker unit not deployed under $UNIT_DIR"
  fi
  for unit in "$UNIT_DIR"/*; do
    [ -f "$unit" ] || continue
    base="$(basename "$unit")"
    grep -q '^NoNewPrivileges=yes' "$unit" \
      && pass "$base: NoNewPrivileges=yes" \
      || failc "$base: missing NoNewPrivileges=yes"
    if [ "$unit" = "$BROKER_UNIT" ]; then continue; fi
    if grep -q '^PrivateMounts=' "$unit"; then
      failc "$base: PrivateMounts would decouple the unit from the late vault mount"
    else
      pass "$base: no PrivateMounts"
    fi
    if grep -Eq '^MountFlags=(slave|private)' "$unit"; then
      failc "$base: MountFlags slave/private would hide the vault"
    else
      pass "$base: no private MountFlags"
    fi
    if grep -q '^ProtectKernelTunnels' "$unit"; then
      failc "$base: unknown directive ProtectKernelTunnels (typo for ProtectKernelTunables; systemd ignores it)"
    fi
  done
  for template in portable-agent.service.example portable-ui.service.example portable-credit.service.example; do
    if [ -f "$UNIT_DIR/$template" ]; then
      grep -q '^CapabilityBoundingSet=$' "$UNIT_DIR/$template" \
        && pass "$template: empty CapabilityBoundingSet" \
        || failc "$template: CapabilityBoundingSet must be empty"
      grep -Eq '^ReadWritePaths=|^StateDirectory=' "$UNIT_DIR/$template" \
        && pass "$template: explicit writable directories" \
        || failc "$template: needs ReadWritePaths/StateDirectory"
    fi
  done
  # UI must be vault-INDEPENDENT: it starts in locked state.
  if [ -f "$UNIT_DIR/portable-ui.service.example" ]; then
    if grep -Eq '(ReadWritePaths|BindReadOnlyPaths|ConditionPathIsMountPoint)=.*'"$CONFIG_VAULT_MOUNTPOINT" "$UNIT_DIR/portable-ui.service.example"; then
      failc "portable-ui template depends on $CONFIG_VAULT_MOUNTPOINT (UI must start while the vault is locked)"
    else
      pass "portable-ui template is vault-independent (locked-state capable)"
    fi
  fi
  # Static systemd verification (text greps above do not substitute for it;
  # absence of the tool is a labelled unqualified WARN, never a pass). The
  # broker unit is fully specified by this slice. The *.example templates
  # carry a commented ExecStart (the owning slice provides the command), so
  # full verify on them is the owning slice's step and is labelled here,
  # never silently passed.
  if command -v systemd-analyze >/dev/null 2>&1; then
    if [ -f "$BROKER_UNIT" ]; then
      VOUT="$(systemd-analyze verify "$BROKER_UNIT" 2>&1 || true)"
      # Only lines about OUR unit decide pass/fail; the host's own unit noise
      # (snapd/netplan warnings etc.) is reported as notes, never a pass or
      # fail attributed to this slice.
      OURS="$(printf '%s\n' "$VOUT" | grep -F "$(basename "$BROKER_UNIT")" || true)"
      if [ -n "$OURS" ]; then
        failc "systemd-analyze verify reports broker unit problems: $(printf '%s' "$OURS" | head -n3 | tr '\n' ';')"
      else
        pass "systemd-analyze verify: broker unit statically valid (host unit noise ignored)"
      fi
    fi
    for template in portable-agent.service.example portable-ui.service.example portable-credit.service.example; do
      if [ -f "$UNIT_DIR/$template" ]; then
        warn "$template: full systemd-analyze verify is the owning slice's step (template has no ExecStart); directive checks ran above"
      fi
    done
  else
    warn "systemd-analyze not available: static unit verification UNQUALIFIED (not a pass)"
  fi
else
  failc "unit directory missing: $UNIT_DIR"
fi

# --- volatile-root milestone additions (CONFIGURATION-LEVEL ONLY) ----------------
if [ "$MILESTONE" = volatile-root ]; then
  warn "volatile-root checks here are CONFIGURATION-LEVEL ONLY; live volatile-root qualification is DEFERRED (see portable/raspberry-pi/storage/README.md) — nothing on this guest is claimed volatile from configuration alone"
  if [ -f "$FSTAB" ]; then
    ACTIVE_BOOT="$(grep -vE '^\s*(#|$)' "$FSTAB" | awk '$2=="/boot"||$2=="/boot/efi"||$2=="/boot/firmware" {print $2":"$4}')"
    BAD_RO=''
    while IFS= read -r entry; do
      [ -n "$entry" ] || continue
      case "$entry" in
        *':ro'|*':ro,'*|*,ro|*,ro,*) ;;
        *) BAD_RO="$BAD_RO $entry" ;;
      esac
    done <<EOF
$ACTIVE_BOOT
EOF
    check_bool "boot/ESP fstab entries configured ro (exceptions:$BAD_RO)" $([ -z "$BAD_RO" ]; echo $?)
    HOME_PERSIST="$(grep -vE '^\s*(#|$)' "$FSTAB" | awk '$2=="/home" {print}')"
    check_bool "no persistent /home fstab entry" $([ -z "$HOME_PERSIST" ]; echo $?)
    SWAP_ENTRY="$(grep -vE '^\s*(#|$)' "$FSTAB" | awk '$3=="swap" {print}')"
    check_bool "no fstab swap entries" $([ -z "$SWAP_ENTRY" ]; echo $?)
  else
    failc "no fstab found under $SYSROOT"
  fi
  OVR="$SYSROOT/etc/overlayroot.conf"
  if [ -f "$OVR" ] && grep -Eq '^\s*overlayroot="?tmpfs:recurse=0"?\s*$' "$OVR" 2>/dev/null; then
    pass "overlayroot config text is tmpfs:recurse=0 (configuration only; NOT live evidence)"
  else
    failc "overlayroot config missing or not tmpfs:recurse=0"
  fi
  if [ -f "$SYSROOT/etc/cloud/cloud-init.disabled" ]; then
    pass "cloud-init reprovisioning disabled (/etc/cloud/cloud-init.disabled)"
  else
    failc "cloud-init reprovisioning not disabled"
  fi
  printf '\nDEFERRED (explicitly NOT claimed by this verifier): live root overlay audit\n'\
'  (findmnt root upperdir/workdir tmpfs backing, read-only lower root and boot,\n'\
'  ALL real block-backed mounts, active swap), reboot canaries and lower-image\n'\
'  hash evidence. See portable/raspberry-pi/storage/README.md (deferred work).\n'
fi

printf '\nsummary: pass=%d fail=%d warn=%d (milestone=%s, sysroot=%s, staged=%s)\n' \
  "$PASS_COUNT" "$FAIL_COUNT" "$WARN_COUNT" "$MILESTONE" "$SYSROOT" "$STAGED"
if [ "$MILESTONE" = volatile-root ]; then
  log 'volatile-root: configuration-level checks only; live qualification remains DEFERRED'
fi
[ "$FAIL_COUNT" = 0 ] || log 'boundary verification FAILED; see FAIL lines above'
exit "$([ "$FAIL_COUNT" = 0 ] && echo 0 || echo 1)"
