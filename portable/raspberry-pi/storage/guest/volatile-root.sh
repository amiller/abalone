#!/bin/bash
# volatile-root.sh — milestone B: make the guest ROOT volatile and boot
# storage read-only. SEPARATE from the accounts+vault milestone on purpose:
# this changes boot behavior and can make the guest unbootable without the
# QEMU harness, so it is applied by the supervisor only after milestone A is
# accepted (see portable/raspberry-pi/storage/README.md). There is no blanket installer.
#
# What it does (with --apply; without it, a dry run that writes NOTHING):
#   * /etc/overlayroot.conf: activate overlayroot="tmpfs:recurse=0" — checked
#     against the INSTALLED overlayroot package and kernel (presence of the
#     package, its initramfs hook, and its support for tmpfs/recurse options
#     are verified, not guessed), then update-initramfs -u.
#   * fstab: boot/ESP mounts set to "ro"; persistent /home and swap entries
#     commented out with a "# portable-volatile:" marker (first backup kept).
#   * swap: swapoff -a (live guest only).
#   * cloud-init reprovisioning disabled (/etc/cloud/cloud-init.disabled) when
#     cloud-init is installed.
#
# Usage: volatile-root.sh [--apply] [--confirm VOLATILE-ROOT] [--sysroot /]
set -euo pipefail
umask 077
LC_ALL=C
export LC_ALL
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

APPLY=no
CONFIRM=
SYSROOT=
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=yes; shift ;;
    --confirm) [ $# -ge 2 ] || usage_error '--confirm requires a value'; CONFIRM="$2"; shift 2 ;;
    --confirm=*) CONFIRM="${1#*=}"; shift ;;
    --sysroot) [ $# -ge 2 ] || usage_error '--sysroot requires a value'; SYSROOT="$2"; shift 2 ;;
    --sysroot=*) SYSROOT="${1#*=}"; shift ;;
    -h|--help) sed -n '3,20p' "$0"; exit 0 ;;
    *) usage_error "unknown argument: $1" ;;
  esac
done
[ -z "$SYSROOT" ] && SYSROOT=/
case "$SYSROOT" in /*) ;; *) usage_error '--sysroot must be absolute' ;; esac

if [ "$APPLY" = yes ]; then
  [ -n "$CONFIRM" ] || usage_error '--apply requires --confirm VOLATILE-ROOT'
  [ "$CONFIRM" = VOLATILE-ROOT ] || die "$EX_USAGE" 'wrong confirm phrase: expected --confirm VOLATILE-ROOT'
  [ "$SYSROOT" = / ] || log 'offline --sysroot given: swapoff/update-initramfs are skipped (run them inside the guest/chroot)'
  [ "$SYSROOT" = / ] && require_root
fi

FSTAB="$SYSROOT/etc/fstab"
OVRCONF="$SYSROOT/etc/overlayroot.conf"
CLDDIS="$SYSROOT/etc/cloud/cloud-init.disabled"

# --- check the overlayroot support instead of guessing -------------------------
dpkg_version_() { dpkg-query -W -f='${Status} ${Version}\n' "$1" 2>/dev/null | awk '$1=="install" && $2=="ok" && $3=="installed" { print $4; exit }'; }
OVR_VER="$(dpkg_version_ overlayroot)"
[ -n "$OVR_VER" ] || die "$EX_PRECOND" 'overlayroot package is not installed; this script refuses to guess initramfs behavior — prepare the package (check-prereqs.sh --milestone volatile-root) and re-run'
HOOK_FILES="$(dpkg -L overlayroot 2>/dev/null | grep -E 'initramfs' || true)"
[ -n "$HOOK_FILES" ] || die "$EX_PRECOND" 'overlayroot package installed but ships no initramfs integration (dpkg -L); refusing'
RECURSE_SUPPORT=no
for f in $HOOK_FILES; do
  if [ -f "$f" ] && grep -q 'recurse' "$f" 2>/dev/null; then RECURSE_SUPPORT=yes; fi
done
[ "$RECURSE_SUPPORT" = yes ] || die "$EX_PRECOND" "installed overlayroot ($OVR_VER) shows no 'recurse' option support in its initramfs files; refusing to write a config it may not honor"
if ! grep -qw -- overlay /proc/filesystems 2>/dev/null && ! { command -v modinfo >/dev/null 2>&1 && modinfo -n overlay >/dev/null 2>&1; }; then
  die "$EX_PRECOND" 'kernel shows no overlay filesystem support (built-in or loadable)'
fi
log "overlayroot $OVR_VER installed with initramfs recurse support; kernel overlay available"

# --- plan the fstab transformation (idempotent) ---------------------------------
transform_fstab() { # transform_fstab <in> <out>; prints change count to stderr
  awk -v mark='# portable-volatile:' '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { print; next }
    {
      sub(/^[ \t]+/, "")
      n = split($0, f, /[[:space:]]+/)
      # f[1]=spec f[2]=target f[3]=fstype f[4]=opts ...
      if (f[3] == "swap" || f[2] == "/home") {
        print mark " disabled by volatile-root.sh: " $0; changed++
        next
      }
      if (f[2] == "/boot" || f[2] == "/boot/efi" || f[2] == "/boot/firmware") {
        line = f[1] " " f[2] " " f[3] " ro"
        for (i = 5; i <= n; i++) line = line " " f[i]
        print line; changed++
        next
      }
      print
    }
    END { printf "%d\n", changed + 0 > "/dev/stderr" }
  ' "$1" > "$2"
}

FSTAB_PLAN="$(mktemp)"
CHANGES=0
if [ -f "$FSTAB" ]; then
  CHANGES="$(transform_fstab "$FSTAB" "$FSTAB_PLAN" 2>&1 >/dev/null)" || CHANGES=0
else
  : > "$FSTAB_PLAN"
  log "no fstab at $FSTAB (nothing to transform)"
fi

OVR_ACTIVE_LINE='overlayroot="tmpfs:recurse=0"'
OVR_ACTION=create
if [ -f "$OVRCONF" ]; then
  if grep -Eq "^\s*overlayroot=\"?tmpfs:recurse=0\"?\s*$" "$OVRCONF"; then
    OVR_ACTION=already
  elif grep -Eq '^\s*overlayroot=' "$OVRCONF"; then
    OVR_ACTION=replace
  else
    OVR_ACTION=append
  fi
fi
CLOUD_PRESENT=no
[ -n "$(dpkg_version_ cloud-init)" ] && CLOUD_PRESENT=yes

# --- dry run: report, write nothing ---------------------------------------------
if [ "$APPLY" = no ]; then
  out "DRY RUN (nothing written; pass --apply --confirm VOLATILE-ROOT to proceed)"
  out "overlayroot.conf $OVR_ACTION: $OVRCONF -> $OVR_ACTIVE_LINE"
  out "cloud-init present: $CLOUD_PRESENT -> $([ "$CLOUD_PRESENT" = yes ] && echo 'disable via /etc/cloud/cloud-init.disabled' || echo 'nothing to disable')"
  if [ "$CHANGES" -gt 0 ]; then
    out "fstab planned changes: $CHANGES (preview:)"
    diff -u "$FSTAB" "$FSTAB_PLAN" | sed 's/^/  /' || true
  else
    out 'fstab: no changes needed (already transformed or absent)'
  fi
  [ "$SYSROOT" = / ] && out 'apply would also run: swapoff -a; update-initramfs -u'
  rm -f "$FSTAB_PLAN"
  exit "$EX_OK"
fi

# --- apply ------------------------------------------------------------------------
log "applying volatile-root with sysroot=$SYSROOT"

# fstab (backup kept from the FIRST transformation only)
if [ "$CHANGES" -gt 0 ]; then
  if [ ! -e "$FSTAB.portable-volatile.bak" ]; then
    cp -p "$FSTAB" "$FSTAB.portable-volatile.bak"
    log "original fstab backed up to $FSTAB.portable-volatile.bak (kept)"
  fi
  cat "$FSTAB_PLAN" > "$FSTAB"
  log 'fstab transformed (boot/ESP ro; /home and swap commented)'
fi
rm -f "$FSTAB_PLAN"

case "$OVR_ACTION" in
  already) log 'overlayroot.conf already active for tmpfs:recurse=0' ;;
  append)  printf '\n%s\n' "$OVR_ACTIVE_LINE" >> "$OVRCONF"; log "appended to $OVRCONF" ;;
  replace) sed -i -E "s|^\s*overlayroot=.*$|$OVR_ACTIVE_LINE|" "$OVRCONF"; log "replaced active overlayroot line in $OVRCONF" ;;
  create)  printf '%s\n' "$OVR_ACTIVE_LINE" > "$OVRCONF"; log "created $OVRCONF" ;;
esac

if [ "$CLOUD_PRESENT" = yes ]; then
  mkdir -p "$SYSROOT/etc/cloud"
  touch "$CLDDIS"
  log 'cloud-init reprovisioning disabled'
fi

if [ "$SYSROOT" = / ]; then
  swapoff -a 2>/dev/null || log 'swapoff -a reported an error (no active swap? continuing)'
  update-initramfs -u || die "$EX_VAULT" 'update-initramfs failed; DO NOT REBOOT until resolved (root would not be volatile but config is half-applied)'
  out 'volatile-root applied: reboot to activate. /home, swap, boot/ESP changes are live now.'
else
  out "volatile-root applied offline under $SYSROOT; run 'update-initramfs -u' and 'swapoff -a' inside the guest before relying on them"
fi
out 'rollback for the rehearsal: restore fstab.portable-volatile.bak, remove overlayroot line, update-initramfs -u, reboot (or just discard the disposable guest)'
exit "$EX_OK"
