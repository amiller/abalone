#!/bin/bash
# check-prereqs.sh — report guest prerequisites for the portable storage slice.
#
# It CHECKS and REPORTS; it never installs anything (no apt, no dpkg -i, no
# downloads). Prepared prerequisites are supported: whatever the supervisor
# pre-installed into the image is reported exactly as found, including absent
# packages. Exit status: 0 when every required item for the selected milestone
# is present and at or above its floor version, 1 otherwise.
#
# Milestones (kept deliberately separate — see portable/raspberry-pi/storage/README.md):
#   vault         accounts + vault lifecycle (default)
#   volatile-root overlayroot tmpfs root rehearsal (applied only after vault)
#
# Usage: check-prereqs.sh [--milestone vault|volatile-root]
#                         [--filesystems-list FILE]  (default /proc/filesystems;
#                         override exists for offline/foreign-host rehearsal)
set -euo pipefail
umask 077
LC_ALL=C
export LC_ALL
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

MILESTONE=vault
FS_LIST=/proc/filesystems

while [ $# -gt 0 ]; do
  case "$1" in
    --milestone)
      [ $# -ge 2 ] || usage_error '--milestone requires a value'
      MILESTONE="$2"; shift 2 ;;
    --milestone=*) MILESTONE="${1#*=}"; shift ;;
    --filesystems-list)
      [ $# -ge 2 ] || usage_error '--filesystems-list requires a value'
      FS_LIST="$2"; shift 2 ;;
    --filesystems-list=*) FS_LIST="${1#*=}"; shift ;;
    -h|--help) out "Usage: check-prereqs.sh [--milestone vault|volatile-root] [--filesystems-list FILE]"; exit 0 ;;
    *) usage_error "unknown argument: $1" ;;
  esac
done
case "$MILESTONE" in
  vault|volatile-root) ;;
  *) usage_error "--milestone must be vault or volatile-root (got: $MILESTONE)" ;;
esac

required_absent=0
floor_unmet=0

version_ge() { # version_ge <found> <floor>: true when found >= floor (empty found is false)
  [ -n "$1" ] || return 1
  [ "$(printf '%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

report() { # report <required|optional> <name> <status> <detail>
  printf '%-9s %-22s %-7s %s\n' "$1" "$2" "$3" "$4"
  if [ "$1" = required ] && [ "$3" != PRESENT ]; then
    required_absent=$((required_absent + 1))
  fi
}

cmd_version() { # cmd_version <command> <args...>: first line containing a version number
  local out
  out="$("$@" 2>&1 || true)"
  printf '%s\n' "$out" | grep -oE '[0-9]+([.][0-9]+)+' | head -n1
}

dpkg_version() { # dpkg_version <package>: version when installed (any status), else empty
  # ${Status} is three words ("install ok installed"), so the version is $4.
  dpkg-query -W -f='${Status} ${Version}\n' "$1" 2>/dev/null \
    | awk '$1=="install" && $2=="ok" && $3=="installed" { print $4; exit }'
}

check_tool() { # check_tool <required|optional> <command> <floor-version|-> <purpose>
  local kind="$1" cmd="$2" floor="$3" purpose="$4" found
  if ! command -v "$cmd" >/dev/null 2>&1; then
    report "$kind" "$cmd" ABSENT "required for: $purpose"
    return
  fi
  found="$(cmd_version "$cmd" --version)"
  if [ "$floor" != - ]; then
    if ! version_ge "$found" "$floor"; then
      report "$kind" "$cmd" PRESENT "version $found below floor $floor ($purpose); upgrade the prepared image"
      floor_unmet=$((floor_unmet + 1))
      return
    fi
    report "$kind" "$cmd" PRESENT "version $found (>= $floor) — $purpose"
  else
    report "$kind" "$cmd" PRESENT "${found:+version $found — }$purpose"
  fi
}

check_dpkg() { # check_dpkg <required|optional> <package> <floor-version|-> <purpose>
  local kind="$1" pkg="$2" floor="$3" purpose="$4" found
  found="$(dpkg_version "$pkg")"
  if [ -z "$found" ]; then
    report "$kind" "$pkg" ABSENT "package not installed ($purpose)"
    return
  fi
  if [ "$floor" != - ] && ! version_ge "$found" "$floor"; then
    report "$kind" "$pkg" PRESENT "version $found below floor $floor ($purpose); upgrade the prepared image"
    floor_unmet=$((floor_unmet + 1))
    return
  fi
  report "$kind" "$pkg" PRESENT "package version $found${floor:+ (>= $floor)} — $purpose"
}

kernel_release="$(uname -r 2>/dev/null || echo unknown)"
printf 'milestone: %s   kernel: %s\n\n' "$MILESTONE" "$kernel_release"

case "$MILESTONE" in
  vault)
    check_tool required bash 4.0 'script interpreter'
    check_tool required cryptsetup 2.4 'LUKS2 format/open/close (key on stdin)'
    check_tool required lsblk 2.36 'device identity, size and UUID probes (util-linux)'
    check_tool required findmnt 2.36 'mount state verification (util-linux)'
    check_tool required wipefs 2.36 'existing-signature detection before provisioning (util-linux)'
    check_tool required blkid 2.36 'second signature detection (util-linux)'
    check_tool required mount - 'late unlock mount'
    check_tool required umount - 'ordinary (non-lazy, non-forced) unmount'
    check_tool required mkfs.ext4 1.44 'vault filesystem creation (e2fsprogs)'
    check_tool required fuser - 'stopped-writers check before lock (psmisc)'
    check_tool required flock 2.12 'lifecycle serialization (util-linux)'
    check_tool required python3 3.7 'vault broker (stdlib only)'
    check_tool required systemctl 240 'service unit sandboxing directives'
    check_tool optional lsof - 'alternative writer inspection during acceptance'
    check_tool optional diff - 'volatile-root dry-run previews'
    ;;
  volatile-root)
    check_tool required bash 4.0 'script interpreter'
    check_tool required update-initramfs - 'regenerate initramfs with overlayroot hook'
    check_tool required awk - 'fstab transformations'
    check_dpkg  required overlayroot - 'overlay root filesystem support (prepared prerequisite; stock Debian may not ship it — report is accurate either way)'
    check_dpkg  optional initramfs-tools 0.120 'initramfs framework overlayroot hooks into'
    check_dpkg  optional cloud-init - 'present means volatile-root.sh will disable reprovisioning'
    # Kernel check, not a guess: overlay must be usable by this kernel.
    if grep -qw -- overlay "$FS_LIST" 2>/dev/null; then
      report required 'kernel:overlayfs' PRESENT "in $FS_LIST"
    elif command -v modinfo >/dev/null 2>&1 && modinfo -n overlay >/dev/null 2>&1; then
      report required 'kernel:overlayfs' PRESENT 'loadable module (modinfo overlay)'
    else
      report required 'kernel:overlayfs' ABSENT "no overlay line in $FS_LIST and no loadable module"
    fi
    ;;
esac

printf '\nsummary: milestone=%s required_absent=%d floor_unmet=%d\n' \
  "$MILESTONE" "$required_absent" "$floor_unmet"
if [ "$required_absent" -gt 0 ] || [ "$floor_unmet" -gt 0 ]; then
  log 'prerequisites incomplete; this script installs nothing — prepare the image and re-run'
  exit 1
fi
log 'all required prerequisites present (versions reported above; presence is not qualification)'
exit 0
