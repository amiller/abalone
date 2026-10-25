#!/bin/bash
# stage-volatile-root.sh — OFFLINE staging/config generator for the portable
# volatile-root image slice (portable/image).
#
# It stages, into a SYSROOT tree of a pinned ARM guest image (never into a
# running system), the small inspectable volatile-root mechanism:
#   * /etc/initramfs-tools/scripts/init-bottom/portable-volatile-root (0755)
#   * /etc/initramfs-tools/hooks/portable-volatile-root (0755)
#   * /etc/portable-volatile-root.conf (0644, strict schema)
# plus the read-only/volatile policy around it:
#   * fstab: /boot, /boot/efi, /boot/firmware -> ro; swap entries commented
#     out (marker "# portable-image:"); persistent non-boot filesystem mounts
#     are REFUSED (they would silently defeat volatility);
#   * journald drop-in: Storage=volatile + SystemMaxUse/RuntimeMaxUse bound;
#   * core policy: DefaultLimitCORE=0 (no coredump retention into the RAM
#     root) and coredump.conf Storage=none when systemd-coredump is present;
#   * dphys-swapfile masked and cloud-init disabled when those packages are
#     present (per-boot reprovisioning on a volatile root is refused work).
#
# Source-layout checks are preflight only. After a separate authorized build,
# audit-initramfs.py must verify the generated ORDER files and reviewed script
# hashes. Neither source ordering nor offline tests qualify an actual boot.
#
# It NEVER runs update-initramfs, never mounts anything, never touches block
# devices, and never modifies the running host: --sysroot must not be /, and
# --apply additionally requires EUID 0 so staged boot files are root-owned.
# The supervisor performs the guest-side step (chroot update-initramfs -u)
# after reviewing the dry-run plan.
#
# Usage:
#   stage-volatile-root.sh --sysroot DIR [--config FILE] [--boot-part DIR]
#                          [--apply --confirm VOLATILE-IMAGE]
#   --sysroot DIR    staged guest root tree (absolute, existing, not /)
#   --config FILE    volatile-root config (default: bundled example)
#   --boot-part DIR  directory holding the kernel cmdline file (PiOS FAT boot
#                    partition: DIR/cmdline.txt). Required to verify "no
#                    pending init=" unless the sysroot carries grub.cfg.
#   --apply          write the plan (default: dry run, writes nothing)
#   --confirm        safety phrase required by --apply: VOLATILE-IMAGE
#
# Exit codes: 0 ok · 2 usage · 5 config invalid · 6 precondition/refusal.
#
# License: MIT (see repository LICENSE).
set -euo pipefail
umask 077
LC_ALL=C
export LC_ALL

SRCDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

EX_OK=0
EX_USAGE=2
EX_CONFIG=5
EX_PRECOND=6

log()  { printf 'stage-volatile-root: %s\n' "$*" >&2; }
out()  { printf '%s\n' "$*"; }
die()  { local code="$1"; shift; printf 'stage-volatile-root: refused: %s\n' "$*" >&2; exit "$code"; }
usage_error() { printf 'stage-volatile-root: usage: %s\n' "$*" >&2; exit "$EX_USAGE"; }

APPLY=no
CONFIRM=
SYSROOT=
CONFIG="$SRCDIR/conf/portable-volatile-root.conf.example"
BOOTPART=

while [ $# -gt 0 ]; do
	case "$1" in
		--apply) APPLY=yes; shift ;;
		--confirm) [ $# -ge 2 ] || usage_error '--confirm requires a value'; CONFIRM="$2"; shift 2 ;;
		--confirm=*) CONFIRM="${1#*=}"; shift ;;
		--sysroot) [ $# -ge 2 ] || usage_error '--sysroot requires a value'; SYSROOT="$2"; shift 2 ;;
		--sysroot=*) SYSROOT="${1#*=}"; shift ;;
		--config) [ $# -ge 2 ] || usage_error '--config requires a value'; CONFIG="$2"; shift 2 ;;
		--config=*) CONFIG="${1#*=}"; shift ;;
		--boot-part) [ $# -ge 2 ] || usage_error '--boot-part requires a value'; BOOTPART="$2"; shift 2 ;;
		--boot-part=*) BOOTPART="${1#*=}"; shift ;;
		-h|--help) sed -n '3,40p' "$0"; exit 0 ;;
		*) usage_error "unknown argument: $1" ;;
	esac
done

[ -n "$SYSROOT" ] || usage_error '--sysroot is required'
case "$SYSROOT" in
	/*) ;;
	*) usage_error '--sysroot must be an absolute path' ;;
esac
[ "$SYSROOT" != / ] || die "$EX_PRECOND" '--sysroot / refused: never stage into a live system; stage into an offline tree'
[ -d "$SYSROOT" ] || die "$EX_PRECOND" "sysroot is not a directory: $SYSROOT"
python3 "$SRCDIR/check-tree.py" "$SYSROOT" >&2 || die "$EX_PRECOND" "unsafe sysroot containment"
SYSROOT="$(realpath -e "$SYSROOT")"
[ ! -L "$SYSROOT" ] || die "$EX_PRECOND" "sysroot is a symlink: $SYSROOT"
for d in "$SRCDIR/scripts/init-top/00-portable-volatile-guard" "$SRCDIR/scripts/init-bottom/portable-volatile-root" "$SRCDIR/hooks/portable-volatile-root"; do
	[ -f "$d" ] || die "$EX_PRECOND" "slice source incomplete: missing $d"
done
[ -f "$CONFIG" ] || die "$EX_CONFIG" "config file not found: $CONFIG"

if [ "$APPLY" = yes ]; then
	[ -n "$CONFIRM" ] || usage_error '--apply requires --confirm VOLATILE-IMAGE'
	[ "$CONFIRM" = VOLATILE-IMAGE ] || die "$EX_PRECOND" 'wrong confirm phrase: expected --confirm VOLATILE-IMAGE'
	[ "$(id -u)" = 0 ] || die "$EX_PRECOND" '--apply requires root so staged boot files are root-owned (rehearse a dry run, or stage inside a mapped-root user namespace)'
fi

# --- config validation (same strict schema the boot script enforces) -------
CONFIG_MODE= CONFIG_UPPER= CONFIG_JOURNAL=
config_invalid() { die "$EX_CONFIG" "config $CONFIG: $1"; }
[ "$(wc -c < "$CONFIG")" -le 4096 ] || config_invalid "too large (max 4096 bytes)"
declare -A cfg_seen=()
while IFS= read -r line || [ -n "$line" ]; do
	case "$line" in ''|'#'*) continue ;; esac
	case "$line" in *=*) ;; *) config_invalid "unparsable line: ${line:0:80}" ;; esac
	key="${line%%=*}"; value="${line#*=}"
	case "$key" in
		VOLATILE_ROOT_MODE|UPPER_SIZE|JOURNAL_MAX_USE) ;;
		*) config_invalid "unknown key: $key" ;;
	esac
	[ -z "${cfg_seen[$key]+x}" ] || config_invalid "duplicate key: $key"
	cfg_seen["$key"]=1
	case "$key:$value" in
		VOLATILE_ROOT_MODE:overlay-tmpfs|VOLATILE_ROOT_MODE:off) ;;
		*)
			case "$key" in
				UPPER_SIZE)
				printf '%s' "$value" | grep -Eq '^[1-9][0-9]{0,3}(K|M|G)$|^([1-9]|[1-8][0-9]|90)%$' \
						|| config_invalid "invalid UPPER_SIZE: $value"
					;;
				JOURNAL_MAX_USE)
					printf '%s' "$value" | grep -Eq '^[1-9][0-9]{0,3}(M|G)$' \
						|| config_invalid "invalid JOURNAL_MAX_USE: $value"
					;;
				*) config_invalid "invalid VOLATILE_ROOT_MODE: $value" ;;
			esac
			;;
	esac
	case "$key" in
		VOLATILE_ROOT_MODE) CONFIG_MODE="$value" ;;
		UPPER_SIZE) CONFIG_UPPER="$value" ;;
		JOURNAL_MAX_USE) CONFIG_JOURNAL="$value" ;;
	esac
done < "$CONFIG"
[ -n "$CONFIG_MODE" ] || config_invalid 'missing VOLATILE_ROOT_MODE'
# Reuse the boot script's own parser as the final authority.
PVR_CFG="$CONFIG" /bin/sh "$SRCDIR/scripts/init-bottom/portable-volatile-root" selfcheck >/dev/null 2>&1 \
	|| die "$EX_CONFIG" "boot script parser rejected $CONFIG (selfcheck); refusing to stage"

# The example config must never claim to be active while being merely a sample.
if [ "$CONFIG" = "$SRCDIR/conf/portable-volatile-root.conf.example" ] && [ "$CONFIG_MODE" != "overlay-tmpfs" ]; then
	die "$EX_CONFIG" 'bundled example config is not in overlay-tmpfs mode (edit a copy with --config)'
fi

# --- installed initramfs-tools: ordering evidence from the sysroot ---------
INIT_SH="$SYSROOT/usr/share/initramfs-tools/init"
[ -f "$INIT_SH" ] || die "$EX_PRECOND" "no initramfs-tools /init in sysroot: $INIT_SH (prepare the image with initramfs-tools and re-run; this generator refuses to guess boot ordering)"

line_of() { grep -n -m1 -F "$2" "$1" | cut -d: -f1 || true; }

L_MOUNTROOT="$(grep -n -m1 '^mountroot$' "$INIT_SH" | cut -d: -f1 || true)"
L_TOP="$(line_of "$INIT_SH" 'run_scripts /scripts/init-top')"
[ -n "$L_TOP" ] && [ -n "$L_MOUNTROOT" ] && [ "$L_TOP" -lt "$L_MOUNTROOT" ] || die "$EX_PRECOND" "unsupported init-top layout"
L_INITBOTTOM="$(line_of "$INIT_SH" 'run_scripts /scripts/init-bottom')"
L_RUNMOVE="$(line_of "$INIT_SH" 'move /run')"
L_EXEC="$(grep -n -m1 -E '^exec (run-init|switch_root)' "$INIT_SH" | cut -d: -f1 || true)"
[ -n "$L_INITBOTTOM" ] || die "$EX_PRECOND" "installed /init has no 'run_scripts /scripts/init-bottom' phase: refusing to stage against an unknown boot layout"
[ -n "$L_MOUNTROOT" ] || die "$EX_PRECOND" "installed /init has no mountroot call: cannot prove root is mounted before init-bottom"
[ "$L_MOUNTROOT" -lt "$L_INITBOTTOM" ] || die "$EX_PRECOND" "installed /init mounts root (line $L_MOUNTROOT) at/after init-bottom (line $L_INITBOTTOM): ordering contract violated; refusing"
[ -n "$L_RUNMOVE" ] || die "$EX_PRECOND" "installed /init has no 'move /run' after init-bottom: cannot prove the tmpfs upper survives switch_root (expected 'mount -n -o move /run \${rootmnt}/run')"
[ "$L_RUNMOVE" -gt "$L_INITBOTTOM" ] || die "$EX_PRECOND" "installed /init moves /run (line $L_RUNMOVE) at/before init-bottom (line $L_INITBOTTOM): the upper tmpfs would not relocate into the real root; refusing"
if [ -z "$L_EXEC" ]; then
	die "$EX_PRECOND" "installed /init execs neither run-init nor switch_root: refusing to stage against an unknown root switch"
fi
[ "$L_RUNMOVE" -lt "$L_EXEC" ] || die "$EX_PRECOND" "run move must precede exec"
INIT_EXEC="$(sed -n "${L_EXEC}p" "$INIT_SH" | awk '{print $2}')"
log "source phase layout checked in installed /init: mountroot:$L_MOUNTROOT < init-bottom:$L_INITBOTTOM < run-move:$L_RUNMOVE < exec $INIT_EXEC:$L_EXEC"

# --- udev init-bottom contract: our script must precede the /dev move ------
UDEV_SH="$SYSROOT/usr/share/initramfs-tools/scripts/init-bottom/udev"
[ -f "$UDEV_SH" ] || die "$EX_PRECOND" "no udev init-bottom script in sysroot: cannot verify the /dev move contract"
grep -q -- 'move /dev' "$UDEV_SH" || die "$EX_PRECOND" "udev init-bottom script does not move /dev: ${UDEV_SH}"
grep -q -- 'rootmnt' "$UDEV_SH" || die "$EX_PRECOND" "udev init-bottom script does not reference \${rootmnt}: ${UDEV_SH}"
UDEV_PREREQ="$(sed -n 's/^PREREQS\{0,1\}="\([^"]*\)"/\1/p' "$UDEV_SH" | head -n1)"
[ -z "$UDEV_PREREQ" ] || die "$EX_PRECOND" "note: udev init-bottom declares PREREQ '$UDEV_PREREQ' (expected empty; verify it cannot reorder our script before udev)"

PVR_NAME="portable-volatile-root"
if [ "$(printf '%s\n' "$PVR_NAME" udev | LC_ALL=C sort | head -n1)" != "$PVR_NAME" ]; then
	die "$EX_PRECOND" "'$PVR_NAME' does not sort before 'udev': the overlay would be stacked after /dev moved into the root and would hide it; refusing"
fi
for other in "$SYSROOT/usr/share/initramfs-tools/scripts/init-bottom"/* "$SYSROOT/etc/initramfs-tools/scripts/init-bottom"/*; do
	[ -f "$other" ] || continue
	b="$(basename "$other")"
	[ "$b" != "$PVR_NAME" ] || continue
	if [ "$(printf '%s\n' "$b" "$PVR_NAME" | LC_ALL=C sort | head -n1)" = "$PVR_NAME" ]; then
		continue # we run before it: fine (we refuse child mounts anyway)
	fi
	# A script sorting before us is also fine; only report scripts between us and udev that touch mounts.
	case "$b" in
		udev) ;;
		*) log "note: init-bottom script '$b' sorts before '$PVR_NAME'" ;;
	esac
done
log "source ordering candidate only; generated ORDER audit REQUIRED: '$PVR_NAME' sorts before 'udev' in init-bottom (mkinitramfs runs unconnected scripts in sorted name order; our script also refuses any child mount under \${rootmnt} at runtime)"

# --- busybox + kernel overlayfs evidence ------------------------------------
[ -x "$SYSROOT/bin/busybox" ] || die "$EX_PRECOND" "no executable /bin/busybox in sysroot (initramfs shell/mount provider)"
OVERLAY_EVIDENCE=
if ls "$SYSROOT"/lib/modules/*/kernel/fs/overlay/overlay.ko* >/dev/null 2>&1 || ls "$SYSROOT"/lib/modules/*/kernel/fs/overlayfs/overlay.ko* >/dev/null 2>&1; then
	OVERLAY_EVIDENCE="loadable overlay.ko under /lib/modules/*/kernel/fs/{overlay,overlayfs}/"
elif grep -qs 'kernel/fs/overlay' "$SYSROOT"/lib/modules/*/modules.builtin; then
	OVERLAY_EVIDENCE="overlay built-in per modules.builtin"
fi
[ -n "$OVERLAY_EVIDENCE" ] || die "$EX_PRECOND" 'no kernel overlayfs evidence in sysroot (neither overlay.ko under /lib/modules/*/kernel/fs/overlay/ nor a modules.builtin entry); refusing'
log "kernel overlayfs evidence: $OVERLAY_EVIDENCE"

# --- installed package inventory (offline dpkg status parse) ----------------
dpkg_installed() { # dpkg_installed <name>: rc 0 when 'install ok installed'
	awk -v pkg="$1" '
		$1 == "Package:" { cur = ($2 == pkg) }
		$1 == "Status:" && cur && $2 == "install" && $3 == "ok" && $4 == "installed" { found = 1 }
		END { exit found ? 0 : 1 }' "$SYSROOT/var/lib/dpkg/status" 2>/dev/null
}
DPKG_STATUS="$SYSROOT/var/lib/dpkg/status"
[ -f "$DPKG_STATUS" ] || die "$EX_PRECOND" "no dpkg status database at $DPKG_STATUS: cannot verify installed packages (refusing to guess)"
dpkg_installed initramfs-tools-core || die "$EX_PRECOND" 'initramfs-tools-core is not installed in sysroot'
dpkg_installed overlayroot && die "$EX_PRECOND" 'the overlayroot package is installed in sysroot: a second volatile-root mechanism would conflict (storage milestone B applies it); remove one before staging'
[ ! -e "$SYSROOT/etc/overlayroot.conf" ] || die "$EX_PRECOND" 'sysroot already carries /etc/overlayroot.conf (conflicting volatile-root mechanism); refusing'
HAS_CLOUDINIT=no;  dpkg_installed cloud-init     && HAS_CLOUDINIT=yes
HAS_DPHYS=no;      dpkg_installed dphys-swapfile && HAS_DPHYS=yes
HAS_COREDUMP=no;   dpkg_installed systemd-coredump && HAS_COREDUMP=yes

# --- crypttab: vault stays a LATE broker unlock, never a boot unlock -------
if [ -f "$SYSROOT/etc/crypttab" ] && grep -Eq '^[[:space:]]*[^#[:space:]]' "$SYSROOT/etc/crypttab"; then
	die "$EX_PRECOND" '/etc/crypttab has active entries: the portable vault is unlocked LATE by the storage broker after boot (never from the initramfs); remove or comment every entry before staging'
fi

# --- kernel command line: no pending init= (first-boot machinery) ----------
CMDLINE_SRC=
if [ -n "$BOOTPART" ]; then
	for component in "$BOOTPART" "$BOOTPART/cmdline.txt"; do
        check="$component"
        while [ "$check" != / ] && [ "$check" != . ]; do
            [ ! -L "$check" ] || die "$EX_PRECOND" "boot-part symlink: $check"
            check="$(dirname "$check")"
        done
    done
    [ -d "$BOOTPART" ] || die "$EX_PRECOND" "--boot-part is not a directory: $BOOTPART"
	[ -f "$BOOTPART/cmdline.txt" ] || die "$EX_PRECOND" "no cmdline.txt under --boot-part $BOOTPART"
	CMDLINE_SRC="$BOOTPART/cmdline.txt"
elif [ -f "$SYSROOT/boot/grub/grub.cfg" ]; then
	CMDLINE_SRC="$SYSROOT/boot/grub/grub.cfg"
else
	die "$EX_PRECOND" 'cannot verify the kernel command line: pass --boot-part DIR (PiOS FAT partition with cmdline.txt) or stage a sysroot containing /boot/grub/grub.cfg; refusing to stage with an unverified cmdline (a pending first-boot init= override is incompatible with a volatile root)'
fi
# Only a single Pi cmdline or reviewed GRUB linux line set is supported.
if grep -Eq 'firstboot|systemd[.]run=|(^|[[:space:]])init=' "$CMDLINE_SRC"; then
    die "$EX_PRECOND" 'pending vendor firstboot/init trigger'
fi
for token in $(cat "$CMDLINE_SRC"); do
    case "$token" in
      rw|rootflags=*|rootfstype=*|fsck.mode=*|fsck.repair=*|forcefsck|fsckfix|boot=*|resume=*|ip=*|nfsroot=*)
        case "$token" in rootflags=noload|rootfstype=ext4|fsck.mode=skip|fsck.repair=no|boot=local|resume=none) ;; *) die "$EX_PRECOND" "unsupported boot argument: $token" ;; esac ;;
    esac
done
log "cmdline checked; early guard enforces ro,noload,fsck skip,noresume before mountroot"

# --- fstab policy ------------------------------------------------------------
FSTAB="$SYSROOT/etc/fstab"
MARK='# portable-image:'
persistent_re='^(ext[234]|btrfs|xfs|f2fs|vfat|exfat|ntfs|ntfs3|iso9660|udf|zfs|ufs)$'
virtual_re='^(proc|sysfs|devtmpfs|devpts|tmpfs|ramfs|cgroup|cgroup2|fusectl|mqueue|hugetlbfs)$'
FSTAB_PLAN="$(mktemp)"; trap 'rm -f "$FSTAB_PLAN"' EXIT
FSTAB_CHANGED=0 FSTAB_REFUSED=
if [ -f "$FSTAB" ]; then
	awk -v mark="$MARK" -v persistent_re="$persistent_re" -v virtual_re="$virtual_re" '
		/^[[:space:]]*#/ || /^[[:space:]]*$/ { print; next }
		{
			sub(/^[ \t]+/, "")
			n = split($0, f, /[[:space:]]+/)
			spec=f[1]; target=f[2]; fstype=f[3]; opts=f[4]
            if (target == "/") roots++
			if (fstype == "swap") { print mark " disabled by stage-volatile-root.sh: " $0; changed++; next }
            if (n != 6) { refused=1; print "REFUSED malformed fstab" > "/dev/stderr"; next }
            if (target == "/" || target == "/boot" || target == "/boot/efi" || target == "/boot/firmware") {
                if ((target == "/" && fstype != "ext4") || (target != "/" && fstype != "vfat" && fstype != "ext4")) {
                    refused=1; print "REFUSED unsupported root/boot filesystem" > "/dev/stderr"; next
                }
                count=split(opts,o,","); kept="ro"
                for(i=1;i<=count;i++) if(o[i]!="rw" && o[i]!="ro" && o[i]!="noload" && o[i] !~ /^(discard|x-systemd[.](growfs|makefs))(=|$)/) kept=kept "," o[i]
                if(fstype=="ext4") kept=kept ",noload"
                if (opts == kept && f[5] == "0" && f[6] == "0") { print; next }
                print mark " boot mount set ro; fsck disabled: " $0
                print spec " " target " " fstype " " kept " 0 0"
                next
            }
			if (fstype !~ virtual_re || opts ~ /(^|,)(bind|rbind)(,|$)/) {
				print mark " REFUSED (persistent non-boot mount defeats volatility): " $0 > "/dev/stderr"
				refused = 1
				next
			}
			print mark " virtual fs mount kept (RAM/kernel backed): " $0
			print; next
		}
		END { if (roots != 1) { print "REFUSED root row must be unique" > "/dev/stderr"; refused=1 }; if (refused) exit 9 }
	' "$FSTAB" > "$FSTAB_PLAN" 2>"$FSTAB_PLAN.err" || awk_rc=$?
	if [ "${awk_rc:-0}" = 9 ]; then
		FSTAB_REFUSED="$(cat "$FSTAB_PLAN.err")"
	elif grep -q REFUSED "$FSTAB_PLAN.err" 2>/dev/null; then
		FSTAB_REFUSED="$(cat "$FSTAB_PLAN.err")"
	fi
	rm -f "$FSTAB_PLAN.err"
	if [ -n "$FSTAB_REFUSED" ]; then
		die "$EX_PRECOND" "fstab refused: persistent non-boot filesystem mounts would silently defeat the volatile root: $FSTAB_REFUSED"
	fi
	FSTAB_CHANGED="$(grep -Ec "$MARK (disabled by|boot mount set ro)" "$FSTAB_PLAN" || true)"
else
	die "$EX_PRECOND" "no /etc/fstab in sysroot: cannot enforce read-only /boot or swap policy; refusing"
fi

# --- planned writes ----------------------------------------------------------
PVR_GROWROOT_DST="$SYSROOT/etc/growroot-disabled"
PVR_GUARD_DST="$SYSROOT/etc/initramfs-tools/scripts/init-top/00-portable-volatile-guard"
PVR_BOOT_DST="$SYSROOT/etc/initramfs-tools/scripts/init-bottom/$PVR_NAME"
PVR_HOOK_DST="$SYSROOT/etc/initramfs-tools/hooks/$PVR_NAME"
PVR_CFG_DST="$SYSROOT/etc/portable-volatile-root.conf"
JOURNALDropIN="$SYSROOT/etc/systemd/journald.conf.d/portable-volatile.conf"
SYSTEM_DROPIN="$SYSROOT/etc/systemd/system.conf.d/portable-volatile.conf"
COREDUMP_DROPIN="$SYSROOT/etc/systemd/coredump.conf.d/portable-volatile.conf"

same_or_absent() { # same_or_absent <dst> <src>: rc 0 when dst absent or identical
	[ ! -e "$1" ] || cmp -s "$1" "$2"
}
refuse_conflict() { # <dst> <src>
	[ ! -L "$1" ] || die "$EX_PRECOND" "symlink destination: $1"
	same_or_absent "$1" "$2" || die "$EX_PRECOND" "target exists with different content: $1 (resolve manually; idempotent re-staging allows only identical content)"
}
refuse_conflict "$PVR_GROWROOT_DST" "$SRCDIR/conf/growroot-disabled"
refuse_conflict "$PVR_GUARD_DST" "$SRCDIR/scripts/init-top/00-portable-volatile-guard"
refuse_conflict "$PVR_BOOT_DST" "$SRCDIR/scripts/init-bottom/portable-volatile-root"
refuse_conflict "$PVR_HOOK_DST" "$SRCDIR/hooks/portable-volatile-root"
refuse_conflict "$PVR_CFG_DST" "$CONFIG"
# Generated policy drop-ins: idempotent only when byte-identical to what we
# would write; a differing existing file is a manual override we never clobber.
check_generated_dropin() { # <path> <content>
	if [ -e "$1" ] && [ "$(cat "$1")" != "$2" ]; then
		die "$EX_PRECOND" "policy drop-in exists with different content: $1 (resolve manually; staging never overwrites policy files)"
	fi
}
check_generated_dropin "$JOURNALDropIN" "# Staged by portable/image stage-volatile-root.sh: volatile journal only.
[Journal]
Storage=volatile
SystemMaxUse=$CONFIG_JOURNAL
RuntimeMaxUse=$CONFIG_JOURNAL"
check_generated_dropin "$SYSTEM_DROPIN" "# Staged by portable/image stage-volatile-root.sh: no coredump retention into
# the bounded RAM root (DefaultLimitCORE=0 disables core files for services).
[Manager]
DefaultLimitCORE=0"
if [ "$HAS_COREDUMP" = yes ]; then
	check_generated_dropin "$COREDUMP_DROPIN" "# Staged by portable/image stage-volatile-root.sh: systemd-coredump present;
# never retain dumps into the volatile root.
[Coredump]
Storage=none"
fi
if [ "$HAS_DPHYS" = yes ]; then
	M="$SYSROOT/etc/systemd/system/dphys-swapfile.service"
	if [ -e "$M" ] || [ -L "$M" ]; then
		[ -L "$M" ] && [ "$(readlink "$M")" = /dev/null ] || die "$EX_PRECOND" "dphys-swapfile.service mask target exists and is not our mask: $M"
	fi
fi

if [ "$APPLY" = no ]; then
	out "stage root-owned growroot disable marker -> $PVR_GROWROOT_DST"
	out 'DRY RUN (nothing written; pass --apply --confirm VOLATILE-IMAGE to proceed)'
	out "initramfs-tools source preflight passed; generated ORDER audit REQUIRED (switch exec: $INIT_EXEC)"
	out "kernel overlayfs: $OVERLAY_EVIDENCE"
	out "kernel cmdline: no init= ($CMDLINE_SRC)"
	out "config ($CONFIG): mode=$CONFIG_MODE upper=$CONFIG_UPPER journal=$CONFIG_JOURNAL"
	out "stage boot script -> $PVR_BOOT_DST (0755 root:root)"
	out "stage hook         -> $PVR_HOOK_DST (0755 root:root)"
	out "stage config       -> $PVR_CFG_DST (0644 root:root)"
	out "journald drop-in   -> $JOURNALDropIN (Storage=volatile, MaxUse=$CONFIG_JOURNAL)"
	out "system drop-in     -> $SYSTEM_DROPIN (DefaultLimitCORE=0: no coredumps into the RAM root)"
	if [ "$HAS_COREDUMP" = yes ]; then out "coredump drop-in  -> $COREDUMP_DROPIN (Storage=none; systemd-coredump present)"; fi
	if [ "$HAS_DPHYS" = yes ]; then out "mask dphys-swapfile -> $SYSROOT/etc/systemd/system/dphys-swapfile.service -> /dev/null"; fi
	if [ "$HAS_CLOUDINIT" = yes ]; then out "disable cloud-init -> $SYSROOT/etc/cloud/cloud-init.disabled"; fi
	out "fstab: $FSTAB_CHANGED marked change(s) (boot ro / swap off); boot mounts and swap policy:"
	if [ "$FSTAB_CHANGED" -gt 0 ]; then
		diff -u "$FSTAB" "$FSTAB_PLAN" | sed 's/^/  /' || true
	fi
	out 'supervisor handoff (NOT run by this tool): inside the guest/chroot — mount /boot (PiOS: /boot/firmware) rw, then'
	out '  update-initramfs -u'
	out '  lsinitramfs /boot/initrd.img-* | grep -E "portable-volatile-root"   # expect script + /etc/portable-volatile-root.conf'
	out 'Do not boot until audit-initramfs.py passes on the generated extracted archive. Rollback: remove staged files, restore fstab backup, update-initramfs -u.'
	exit "$EX_OK"
fi

# --- apply (all checks above passed; writes only under sysroot) -------------
log "applying volatile-root staging into $SYSROOT (mode=$CONFIG_MODE)"

if [ "$FSTAB_CHANGED" -gt 0 ]; then
	if [ ! -e "$FSTAB.portable-image.bak" ]; then
		cp -p "$FSTAB" "$FSTAB.portable-image.bak"
		log "fstab backed up to fstab.portable-image.bak (kept)"
	fi
	cat "$FSTAB_PLAN" > "$FSTAB"
	log 'fstab transformed (boot/ESP ro; swap disabled; virtual mounts kept)'
fi

mkdir -p "$SYSROOT/etc/initramfs-tools/scripts/init-top" "$SYSROOT/etc/initramfs-tools/scripts/init-bottom" "$SYSROOT/etc/initramfs-tools/hooks" "$SYSROOT/etc/systemd/journald.conf.d" "$SYSROOT/etc/systemd/system.conf.d"
install -m 0755 -o 0 -g 0 "$SRCDIR/scripts/init-top/00-portable-volatile-guard" "$PVR_GUARD_DST"
install -m 0755 -o 0 -g 0 "$SRCDIR/scripts/init-bottom/portable-volatile-root" "$PVR_BOOT_DST"
install -m 0755 -o 0 -g 0 "$SRCDIR/hooks/portable-volatile-root" "$PVR_HOOK_DST"
install -m 0644 -o 0 -g 0 "$SRCDIR/conf/growroot-disabled" "$PVR_GROWROOT_DST"
install -m 0644 -o 0 -g 0 "$CONFIG" "$PVR_CFG_DST"

cat > "$JOURNALDropIN" <<EOF
# Staged by portable/image stage-volatile-root.sh: volatile journal only.
[Journal]
Storage=volatile
SystemMaxUse=$CONFIG_JOURNAL
RuntimeMaxUse=$CONFIG_JOURNAL
EOF
cat > "$SYSTEM_DROPIN" <<'EOF'
# Staged by portable/image stage-volatile-root.sh: no coredump retention into
# the bounded RAM root (DefaultLimitCORE=0 disables core files for services).
[Manager]
DefaultLimitCORE=0
EOF
chown 0:0 "$JOURNALDropIN" "$SYSTEM_DROPIN"; chmod 0644 "$JOURNALDropIN" "$SYSTEM_DROPIN"
if [ "$HAS_COREDUMP" = yes ]; then
	mkdir -p "$SYSROOT/etc/systemd/coredump.conf.d"
	cat > "$COREDUMP_DROPIN" <<'EOF'
# Staged by portable/image stage-volatile-root.sh: systemd-coredump present;
# never retain dumps into the volatile root.
[Coredump]
Storage=none
EOF
	chown 0:0 "$COREDUMP_DROPIN"; chmod 0644 "$COREDUMP_DROPIN"
fi
if [ "$HAS_DPHYS" = yes ]; then
	mkdir -p "$SYSROOT/etc/systemd/system"
	ln -sfn /dev/null "$SYSROOT/etc/systemd/system/dphys-swapfile.service"
	log 'dphys-swapfile masked (symlink -> /dev/null): no swap file on the volatile root'
fi
if [ "$HAS_CLOUDINIT" = yes ]; then
	mkdir -p "$SYSROOT/etc/cloud"
	: > "$SYSROOT/etc/cloud/cloud-init.disabled"
	chown 0:0 "$SYSROOT/etc/cloud/cloud-init.disabled"; chmod 0644 "$SYSROOT/etc/cloud/cloud-init.disabled"
	log 'cloud-init reprovisioning disabled'
fi

out "staged. supervisor handoff (NOT run by this tool): inside the guest/chroot —"
out '  mount /boot (PiOS: /boot/firmware) rw, then update-initramfs -u, then verify:'
out '  lsinitramfs /boot/initrd.img-* | grep portable-volatile-root'
out 'Generated archive audit and kernel qualification REQUIRED before boot (fail-closed to a local recovery console;'
out 'recovery boot: kernel cmdline portable-volatile-root=off).'
exit "$EX_OK"
