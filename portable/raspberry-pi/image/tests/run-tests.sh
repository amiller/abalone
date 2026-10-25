#!/bin/bash
# run-tests.sh — OFFLINE test suite for the portable/image volatile-root slice.
#
# Everything here is offline and side-effect-free outside a temp directory:
# no mounts, no block devices, no network, no guest interaction, no service
# state. Boot-script behavior is exercised with FAKE executors (mount,
# modprobe, poweroff) over synthetic mountinfo/cmdline fixtures; staging is
# exercised against synthetic sysroot trees built in a temp dir. --apply tests
# re-exec this suite inside a MAPPED-ROOT USER NAMESPACE ONLY
# (unshare --user --map-root-user; NO mount namespace is created and nothing
# is mounted) so staged files are root-owned as production requires; when
# user namespaces are unavailable those tests are labelled SKIPPED, never
# faked.
#
# These are STRUCTURAL and logic-path tests of staging paths, config parsing,
# syntax and boot-script ordering. They are NOT boot proof: live overlay
# assembly, reboot disappearance, real-boot mountinfo and failure injection
# in a real guest are the separate supervisor QEMU gate described in
# portable/raspberry-pi/image/README.md.
#
# Usage: tests/run-tests.sh
set -uo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOOT="$SRC_DIR/scripts/init-bottom/portable-volatile-root"
HOOK="$SRC_DIR/hooks/portable-volatile-root"
GEN="$SRC_DIR/stage-volatile-root.sh"
EXAMPLE="$SRC_DIR/conf/portable-volatile-root.conf.example"

PASS=0 FAIL=0 SKIPPED=0
ok()   { PASS=$((PASS + 1)); printf 'ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL %s %s\n' "$1" "${2:-}"; }
skip() { SKIPPED=$((SKIPPED + 1)); printf 'skip %s\n' "$1"; }
expect_rc() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "(want rc=$2 got rc=$3)"; fi; }
expect_contains() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1" "(missing: $3)" ;; esac; }
expect_lacks()    { case "$2" in *"$3"*) bad "$1" "(unexpected: $3)" ;; *) ok "$1" ;; esac; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------- fixtures ---
# initramfs-tools /init fragment mirroring the installed source (0.140 host
# reference read during development; same family as pinned PiOS 0.142): the
# generator asserts these exact ordering relationships from the SYSROOT's
# own installed /init at stage time.
make_init() { # make_init <file>
	cat > "$1" <<'EOF'
#!/bin/sh
export rootmnt=/root
mount -t tmpfs -o "nodev,noexec,nosuid,size=${RUNSIZE:-10%},mode=0755" tmpfs /run
run_scripts /scripts/init-top
maybe_break premount
mountroot
log_end_msg
mount_bottom
nfs_bottom
local_bottom
maybe_break bottom
run_scripts /scripts/init-bottom
mount -n -o move /run ${rootmnt}/run
exec run-init ${drop_caps} "${rootmnt}" "${init}" "$@"
EOF
}

make_sysroot() { # make_sysroot <dir> — good PiOS-like fixture
	local root="$1"
	mkdir -p "$root/usr/share/initramfs-tools/scripts/init-bottom" \
		"$root/usr/share/initramfs-tools/scripts/init-premount" \
		"$root/etc" "$root/var/lib/dpkg" \
		"$root/lib/modules/6.12.109+rpt-rpi-v8/kernel/fs/overlay" \
		"$root/bin" "$root/boot/grub"
	make_init "$root/usr/share/initramfs-tools/init"
	cat > "$root/usr/share/initramfs-tools/scripts/init-bottom/udev" <<'EOF'
#!/bin/sh -e
PREREQS=""
prereqs() { echo "${PREREQS}"; }
mount -n -o move /dev "${rootmnt:?}/dev" || mount -n --move /dev "${rootmnt}/dev"
EOF
	chmod 755 "$root/usr/share/initramfs-tools/scripts/init-bottom/udev"
	printf '#!/bin/sh\n' > "$root/bin/busybox"; chmod 755 "$root/bin/busybox"
	printf 'kernel/fs/overlay/overlay.ko\n' > "$root/lib/modules/6.12.109+rpt-rpi-v8/modules.builtin"
	printf 'module placeholder; staging asserts presence evidence only\n' > "$root/lib/modules/6.12.109+rpt-rpi-v8/kernel/fs/overlay/overlay.ko"
	cat > "$root/var/lib/dpkg/status" <<'EOF'
Package: base-files
Status: install ok installed

Package: initramfs-tools-core
Status: install ok installed

Package: dphys-swapfile
Status: install ok installed
EOF
	cat > "$root/etc/fstab" <<'EOF'
PARTUUID=12345678-02  /boot/firmware  vfat    defaults          0 2
PARTUUID=12345678-02  /               ext4    defaults,noatime  0 1
EOF
	printf 'set terminal_output console\nlinux /boot/vmlinuz root=UUID=aaaa-bbbb ro quiet\n' > "$root/boot/grub/grub.cfg"
}

make_bootpart() { # make_bootpart <dir> [extra-cmdline]
	local bp="$1" extra="${2:-}"
	mkdir -p "$bp"
	printf 'console=serial0,115200 console=tty1 root=PARTUUID=12345678-02 rootfstype=ext4 fsck.mode=skip rootwait quiet%s\n' \
		"${extra:+ $extra}" > "$bp/cmdline.txt"
}

# Fake-executor rig for the BOOT script (dash; fake mount/modprobe/poweroff).
boot_rig() { # boot_rig <sandbox>
	local sb="$1"
	mkdir -p "$sb/bin" "$sb/root/etc" "$sb/runbase/pvr" "$sb/scripts"
	printf 'PARTUUID=test / ext4 ro,noload 0 0\nPARTUUID=boot /boot/firmware vfat ro 0 0\n' > "$sb/root/etc/fstab"
	sb="$sb" cat > "$sb/scripts/functions" <<EOF
panic() { echo "PANIC: \$*" >> "$sb/log"; echo "PANIC: \$*"; return 0; }
EOF
	cat > "$sb/bin/mount" <<'EOF'
#!/bin/bash
# fake mount: logs calls; simulates kernel mountinfo effects on the fixture
echo "mount $*" >> "$SB_CALLS"
case " $* " in
    *" -o move "*)
        [ ! -f "$SB_ROOT/etc/fstab" ] || cp "$SB_ROOT/etc/fstab" "$PVR_LOWER_BASE/lower-fstab-evidence"
        sed -i "s| $SB_ROOT | $PVR_LOWER_BASE |" "$PVR_MOUNTINFO"; exit 0 ;;
	*" remount,ro "*)
		sed -i "s|^\([0-9]* [0-9]* [0-9:]* / [^ ]* \)rw|\1ro|" "$PVR_MOUNTINFO" 2>/dev/null
		exit "${FAKE_MOUNT_RC:-0}" ;;
	*" -t tmpfs "*)
		printf '99 1 0:41 / %s rw,nosuid,nodev - tmpfs tmpfs rw\n' "$PVR_UPPER_BASE" >> "$PVR_MOUNTINFO"
		exit 0 ;;
	*" -t overlay "*)
		printf '100 1 0:42 / %s rw,relatime - overlay portable-volatile-root rw,lowerdir=%s,upperdir=%s/upper,workdir=%s/work\n' \
			"$SB_ROOT" "$PVR_LOWER_BASE" "$PVR_UPPER_BASE" "$PVR_UPPER_BASE" >> "$PVR_MOUNTINFO"
		exit 0 ;;
esac
exit 0
EOF
	cat > "$sb/bin/modprobe" <<'EOF'
#!/bin/bash
echo "modprobe $*" >> "$SB_CALLS"; exit 0
EOF
	cat > "$sb/bin/poweroff" <<'EOF'
#!/bin/bash
echo "poweroff $*" >> "$SB_CALLS"; kill -USR1 "$PPID"; exit 0
EOF
	chmod 755 "$sb/bin/mount" "$sb/bin/modprobe" "$sb/bin/poweroff"
}

run_boot_script() { # run_boot_script <sandbox> <mountinfo> <cmdline> [FAKE_MOUNT_RC]
	local sb="$1" mi="$2" cm="$3" frc="${4:-0}"
	: > "$sb/log"; : > "$sb/calls"; : > "$sb/out"
	env -i PATH="$sb/bin:/usr/bin:/bin" \
		PVR_FUNCTIONS="$sb/scripts/functions" \
		PVR_MOUNTINFO="$mi" PVR_CMDLINE="$cm" \
		PVR_LOWER_BASE="$sb/runbase/lower" PVR_UPPER_BASE="$sb/runbase/pvr" PVR_CFG="$sb/pvr.conf" \
		rootmnt="$sb/root" SB_ROOT="$sb/root" SB_CALLS="$sb/calls" \
		FAKE_MOUNT_RC="$frc" \
		dash -c 'trap "exit 1" USR1; . "$1"' dash "$BOOT" > "$sb/out" 2>&1
}

mi_ro_root() { printf '28 1 259:2 / %s ro,relatime - ext4 /dev/mmcblk0p2 ro,noload\n' "$1"; }
mi_rw_root() { printf '28 1 259:2 / %s rw,relatime - ext4 /dev/mmcblk0p2 ro,noload\n' "$1"; }

printf '== syntax ==\n'
for f in "$BOOT" "$HOOK"; do
	if dash -n "$f" && busybox sh -n "$f" && bash -n "$f"; then
		ok "syntax (dash+busybox+bash): $(basename "$f")"
	else
		bad "syntax $(basename "$f")"
	fi
done
bash -n "$GEN" && ok 'syntax: stage-volatile-root.sh' || bad 'syntax: stage-volatile-root.sh'

# ------------------------------------------------------- boot script: config --
printf '== boot script: config parser (selfcheck mode, no fake mounts needed) ==\n'
sc() { # sc <desc> <config-text> <want-rc>
	local desc="$1" text="$2" want="$3" f="$WORK/sc.conf" rc
	printf '%s\n' "$text" > "$f"
	PVR_CFG="$f" dash "$BOOT" selfcheck >"$WORK/sc.out" 2>&1; rc=$?
	expect_rc "selfcheck: $desc" "$want" "$rc"
}
sc 'valid full config' 'VOLATILE_ROOT_MODE=overlay-tmpfs
UPPER_SIZE=2048M
JOURNAL_MAX_USE=64M' 0
sc 'mode off is valid' 'VOLATILE_ROOT_MODE=off' 0
sc 'percent size valid' 'VOLATILE_ROOT_MODE=overlay-tmpfs
UPPER_SIZE=50%
JOURNAL_MAX_USE=64M' 0
sc 'single-digit percent valid' 'VOLATILE_ROOT_MODE=overlay-tmpfs
UPPER_SIZE=9%
JOURNAL_MAX_USE=64M' 0
sc '90 percent valid' 'VOLATILE_ROOT_MODE=overlay-tmpfs
UPPER_SIZE=90%
JOURNAL_MAX_USE=64M' 0
sc 'unknown key refused' 'VOLATILE_ROOT_MODE=overlay-tmpfs
EVIL=1' 1
sc 'duplicate key refused' 'VOLATILE_ROOT_MODE=overlay-tmpfs
UPPER_SIZE=1G
UPPER_SIZE=2G' 1
sc 'missing mode refused' 'UPPER_SIZE=1G' 1
sc 'bad mode refused' 'VOLATILE_ROOT_MODE=yes-please' 1
sc 'plain number size refused' 'VOLATILE_ROOT_MODE=overlay-tmpfs
UPPER_SIZE=2048' 1
sc 'oversize percent refused' 'VOLATILE_ROOT_MODE=overlay-tmpfs
UPPER_SIZE=91%' 1
sc 'zero percent refused' 'VOLATILE_ROOT_MODE=overlay-tmpfs
UPPER_SIZE=0%' 1
sc 'injection style size refused' 'VOLATILE_ROOT_MODE=overlay-tmpfs
UPPER_SIZE=64M,evil' 1
sc 'lowercase suffix refused' 'VOLATILE_ROOT_MODE=overlay-tmpfs
UPPER_SIZE=64m' 1
sc 'journal without M/G refused' 'VOLATILE_ROOT_MODE=overlay-tmpfs
JOURNAL_MAX_USE=64' 1
sc 'unparsable line refused' 'VOLATILE_ROOT_MODE overlay-tmpfs' 1
PVR_CFG="$WORK/definitely-absent.conf" dash "$BOOT" selfcheck >/dev/null 2>&1
expect_rc 'selfcheck: absent config refused' 1 $?
PVR_CFG="$EXAMPLE" dash "$BOOT" selfcheck >"$WORK/sc.out" 2>&1
expect_rc 'selfcheck: bundled example config accepted' 0 $?

# ---------------------------------------------------- boot script: boot flow --
printf '== boot script: boot flow with fake executors ==\n'
printf 'console=tty1 root=PARTUUID=x\n' > "$WORK/cmd.ok"

SB="$WORK/sb1"; boot_rig "$SB"
printf 'VOLATILE_ROOT_MODE=overlay-tmpfs\nUPPER_SIZE=2048M\nJOURNAL_MAX_USE=64M\n' > "$SB/pvr.conf"
mi_ro_root "$SB/root" > "$WORK/mi.ro"
run_boot_script "$SB" "$WORK/mi.ro" "$WORK/cmd.ok"; rc=$?
expect_rc 'flow: ro ext4 root -> success (exit 0)' 0 "$rc"
expect_contains 'flow: success log' "$(cat "$SB/out")" 'volatile root ACTIVE'
expect_contains 'flow: modprobe overlay attempted' "$(cat "$SB/calls")" 'modprobe overlay'
expect_contains 'flow: bounded tmpfs mounted' "$(cat "$SB/calls")" '-t tmpfs -o size=2048M,mode=0755,nodev,nosuid tmpfs'
expect_contains 'flow: overlay stacked on root' "$(cat "$SB/calls")" "-t overlay portable-volatile-root -o lowerdir=$SB/runbase/lower,upperdir=$SB/runbase/pvr/upper,workdir=$SB/runbase/pvr/work $SB/root"
expect_lacks 'flow: no remount needed (already ro)' "$(cat "$SB/calls")" 'remount'
expect_lacks 'flow: no panic on success' "$(cat "$SB/out")" 'PANIC'
expect_lacks 'flow: never powers off on success' "$(cat "$SB/calls")" 'poweroff'
expect_contains 'visible fstab describes writable overlay' "$(cat "$SB/root/etc/fstab")" 'portable-volatile-root / overlay rw 0 0'
expect_contains 'lower fstab remains ext4 read-only' "$(cat "$SB/runbase/lower/lower-fstab-evidence")" 'PARTUUID=test / ext4 ro,noload 0 0'
expect_contains 'visible boot policy remains read-only' "$(cat "$SB/root/etc/fstab")" 'PARTUUID=boot /boot/firmware vfat ro 0 0'


SB="$WORK/sb2"; boot_rig "$SB"
printf 'VOLATILE_ROOT_MODE=overlay-tmpfs\nUPPER_SIZE=512M\nJOURNAL_MAX_USE=64M\n' > "$SB/pvr.conf"
mi_rw_root "$SB/root" > "$WORK/mi.rw"
run_boot_script "$SB" "$WORK/mi.rw" "$WORK/cmd.ok"; rc=$?
expect_rc 'flow: initial rw root refused' 1 "$rc"
expect_lacks 'flow: no late remount claim' "$(cat "$SB/calls")" 'remount'
expect_lacks 'flow: rw lower never assembled' "$(cat "$SB/calls")" '-t overlay'

SB="$WORK/sb3"; boot_rig "$SB"
printf 'VOLATILE_ROOT_MODE=overlay-tmpfs\nUPPER_SIZE=512M\nJOURNAL_MAX_USE=64M\n' > "$SB/pvr.conf"
mi_rw_root "$SB/root" > "$WORK/mi.rw3"
run_boot_script "$SB" "$WORK/mi.rw3" "$WORK/cmd.ok" 1; rc=$?
expect_rc 'flow: remount failure -> fail closed (nonzero)' 1 "$rc"
expect_contains 'flow: failure is loud' "$(cat "$SB/out")" 'FAIL-CLOSED'
expect_contains 'flow: recovery powers off after shell' "$(cat "$SB/calls")" 'poweroff'
expect_lacks 'flow: no overlay after remount failure' "$(cat "$SB/calls")" '-t overlay'
expect_lacks 'flow: no tmpfs after remount failure' "$(cat "$SB/calls")" '-t tmpfs'

SB="$WORK/sb4"; boot_rig "$SB"
printf 'VOLATILE_ROOT_MODE=overlay-tmpfs\nUPPER_SIZE=512M\nJOURNAL_MAX_USE=64M\n' > "$SB/pvr.conf"
{ mi_ro_root "$SB/root" | sed 's|- ext4 /dev/mmcblk0p2 ro,noload$|- overlay already rw|'; } > "$WORK/mi.ovl"
run_boot_script "$SB" "$WORK/mi.ovl" "$WORK/cmd.ok"; rc=$?
expect_rc 'flow: overlay root refused (no double overlay)' 1 "$rc"
expect_contains 'flow: already-volatile refusal named' "$(cat "$SB/out")" 'already volatile'

SB="$WORK/sb5"; boot_rig "$SB"
printf 'VOLATILE_ROOT_MODE=overlay-tmpfs\nUPPER_SIZE=512M\nJOURNAL_MAX_USE=64M\n' > "$SB/pvr.conf"
{ mi_ro_root "$SB/root"; printf '29 28 0:20 / %s/dev rw,nosuid - devtmpfs udev rw\n' "$SB/root"; } > "$WORK/mi.child"
run_boot_script "$SB" "$WORK/mi.child" "$WORK/cmd.ok"; rc=$?
expect_rc 'flow: child mount under root -> fail closed' 1 "$rc"
expect_contains 'flow: hidden-mount refusal names /dev' "$(cat "$SB/out")" '/dev'
expect_lacks 'flow: no overlay on child refusal' "$(cat "$SB/calls")" '-t overlay'

SB="$WORK/sb6"; boot_rig "$SB"
printf 'VOLATILE_ROOT_MODE=overlay-tmpfs\nUPPER_SIZE=512M\nJOURNAL_MAX_USE=64M\n' > "$SB/pvr.conf"
{ mi_ro_root "$SB/root" | sed 's|- ext4 /dev/mmcblk0p2 ro,noload$|- nfs srv:/export rw|'; } > "$WORK/mi.nfs"
run_boot_script "$SB" "$WORK/mi.nfs" "$WORK/cmd.ok"; rc=$?
expect_rc 'flow: nfs root refused' 1 "$rc"
expect_contains 'flow: nfs refusal mentions fstype' "$(cat "$SB/out")" 'nfs'

SB="$WORK/sb7"; boot_rig "$SB"
printf 'VOLATILE_ROOT_MODE=overlay-tmpfs\nUPPER_SIZE=512M\nJOURNAL_MAX_USE=64M\n' > "$SB/pvr.conf"
: > "$WORK/mi.empty"
run_boot_script "$SB" "$WORK/mi.empty" "$WORK/cmd.ok"; rc=$?
expect_rc 'flow: no root mount -> fail closed' 1 "$rc"

SB="$WORK/sb8"; boot_rig "$SB"
printf 'VOLATILE_ROOT_MODE=overlay-tmpfs\nUPPER_SIZE=512M\nJOURNAL_MAX_USE=64M\n' > "$SB/pvr.conf"
printf 'console=tty1 portable-volatile-root=off\n' > "$WORK/cmd.off"
mi_rw_root "$SB/root" > "$WORK/mi.rw8"
run_boot_script "$SB" "$WORK/mi.rw8" "$WORK/cmd.off"; rc=$?
expect_rc 'flow: cmdline kill switch -> exit 0' 0 "$rc"
expect_contains 'flow: kill switch is LOUD' "$(cat "$SB/out")" 'NON-VOLATILE'
expect_lacks 'flow: kill switch mounts nothing' "$(cat "$SB/calls")" '-t overlay'

SB="$WORK/sb9"; boot_rig "$SB"
printf 'VOLATILE_ROOT_MODE=off\n' > "$SB/pvr.conf"
mi_rw_root "$SB/root" > "$WORK/mi.rw9"
run_boot_script "$SB" "$WORK/mi.rw9" "$WORK/cmd.ok"; rc=$?
expect_rc 'flow: config mode off -> exit 0' 0 "$rc"
expect_contains 'flow: config off is LOUD' "$(cat "$SB/out")" 'NON-VOLATILE'

SB="$WORK/sb10"; boot_rig "$SB"
printf 'VOLATILE_ROOT_MODE=overlay-tmpfs\nUPPER_SIZE=bogus\n' > "$SB/pvr.conf"
mi_ro_root "$SB/root" > "$WORK/mi.ro10"
run_boot_script "$SB" "$WORK/mi.ro10" "$WORK/cmd.ok"; rc=$?
expect_rc 'flow: invalid config at boot -> fail closed' 1 "$rc"
expect_contains 'flow: bad config powers off after shell' "$(cat "$SB/calls")" 'poweroff'
expect_lacks 'flow: bad config mounts nothing' "$(cat "$SB/calls")" '-t overlay'

# ---------------------------------------------------------------- hook tests --
printf '== hook ==\n'
HD="$WORK/hookdest"; HOOKCALLS="$WORK/hookcalls"; : > "$HOOKCALLS"
printf 'VOLATILE_ROOT_MODE=overlay-tmpfs\nUPPER_SIZE=2048M\nJOURNAL_MAX_USE=64M\n' > "$WORK/hook.conf"
install -m 0755 "$BOOT" "$WORK/hookboot"
# mkinitramfs sources hook-functions before running hooks; mirror that here.
cat > "$WORK/hookfunctions" <<EOF
manual_add_modules() { echo "manual_add_modules \$*" >> "$HOOKCALLS"; }
EOF
run_hook() { # run_hook <cfg>
	local cfg="$1"
	rm -rf "$HD"; mkdir -p "$HD"
	env -i PATH=/usr/bin:/bin DESTDIR="$HD" \
		PVR_HOOK_FUNCTIONS="$WORK/hookfunctions" PVR_CFG="$cfg" PVR_BOOT_SCRIPT="$WORK/hookboot" HOOKCALLS="$HOOKCALLS" \
		dash -c '. "$1"; . "$2"' dash "$WORK/hookfunctions" "$HOOK" > "$WORK/hook.out" 2>&1
}
run_hook "$WORK/hook.conf"
expect_rc 'hook: valid config -> success' 0 $?
[ -f "$HD/etc/portable-volatile-root.conf" ] && ok 'hook: config copied into DESTDIR' || bad 'hook: config copied into DESTDIR'
[ "$(stat -c '%a' "$HD/etc/portable-volatile-root.conf")" = 644 ] && ok 'hook: config 0644' || bad 'hook: config 0644'
expect_contains 'hook: overlay module requested' "$(cat "$HOOKCALLS")" 'manual_add_modules overlay'
run_hook "$WORK/hook.conf"
expect_rc 'hook: rerun idempotent' 0 $?
printf 'VOLATILE_ROOT_MODE=wrong\n' > "$WORK/hookbad.conf"
run_hook "$WORK/hookbad.conf"
expect_rc 'hook: invalid config fails the build' 1 $?
expect_contains 'hook: build failure is explicit' "$(cat "$WORK/hook.out")" 'INVALID'
run_hook "$WORK/definitely-absent.conf"
expect_rc 'hook: missing config fails the build' 1 $?

# ------------------------------------------------------------- staging tests --
printf '== staging: dry-run positives ==\n'
SYS="$WORK/sys1"; make_sysroot "$SYS"
BP="$WORK/bp1"; make_bootpart "$BP"
"$GEN" --sysroot "$SYS" --boot-part "$BP" > "$WORK/gen1.out" 2>&1; rc=$?
expect_rc 'staging: good sysroot dry-run ok' 0 "$rc"
expect_contains 'staging: dry run announces itself' "$(cat "$WORK/gen1.out")" 'DRY RUN'
expect_contains 'staging: switch exec recorded (run-init)' "$(cat "$WORK/gen1.out")" 'run-init'
expect_contains 'staging: handoff instructions present' "$(cat "$WORK/gen1.out")" 'supervisor handoff'
[ ! -e "$SYS/etc/initramfs-tools/scripts/init-bottom/portable-volatile-root" ] \
	&& ok 'staging: dry run writes NOTHING' || bad 'staging: dry run writes NOTHING'
"$GEN" --sysroot "$SYS" --boot-part "$BP" >/dev/null 2>&1; rc=$?
expect_rc 'staging: second dry-run ok (idempotent)' 0 "$rc"

# Source snapshots on a read-only input ISO need not carry executable modes.
SNAP="$WORK/nonexec-source"
cp -R "$SRC_DIR" "$SNAP"
chmod 0444 "$SNAP/stage-volatile-root.sh" "$SNAP/scripts/init-bottom/portable-volatile-root"
bash "$SNAP/stage-volatile-root.sh" --sysroot "$SYS" --boot-part "$BP" > "$WORK/nonexec-good.out" 2>&1; rc=$?
expect_rc 'staging: nonexecutable source parser accepts valid config' 0 "$rc"
printf 'VOLATILE_ROOT_MODE=overlay-tmpfs\n' > "$WORK/missing-overlay-bounds.conf"
bash "$SNAP/stage-volatile-root.sh" --sysroot "$SYS" --boot-part "$BP" --config "$WORK/missing-overlay-bounds.conf" > "$WORK/nonexec-bad.out" 2>&1; rc=$?
[ "$rc" -ne 0 ] && ok 'staging: nonexecutable source parser rejects missing bounds' || bad 'staging: nonexecutable source parser rejects missing bounds'
expect_contains 'staging: nonexecutable source still uses boot parser validation' "$(cat "$WORK/nonexec-bad.out")" 'boot script parser rejected'

# switch_root variant of /init accepted
SYS="$WORK/sys1b"; make_sysroot "$SYS"
sed -i 's|^exec run-init .*|exec switch_root "${rootmnt}" "${init}" "$@"|' "$SYS/usr/share/initramfs-tools/init"
"$GEN" --sysroot "$SYS" --boot-part "$WORK/bp1" > "$WORK/gen1b.out" 2>&1; rc=$?
expect_rc 'staging: switch_root /init accepted' 0 "$rc"
expect_contains 'staging: switch_root recorded' "$(cat "$WORK/gen1b.out")" 'switch_root'

printf '== staging: negative refusals ==\n'
gen_refuses() { # gen_refuses <desc> <expected-message> -- <args...>
	local desc="$1" msg="$2"; shift 3
	local out rc
	out="$("$GEN" "$@" 2>&1)"; rc=$?
	if [ "$rc" -ne 0 ]; then ok "$desc (rc=$rc)"; else bad "$desc" '(accepted: rc=0)'; fi
	expect_contains "$desc message" "$out" "$msg"
}
SYS="$WORK/sys2"; make_sysroot "$SYS"; make_bootpart "$WORK/bp2"
gen_refuses 'staging: --sysroot / refused' 'never stage into a live system' -- --sysroot /
gen_refuses 'staging: relative sysroot refused' 'absolute path' -- --sysroot relative/path
gen_refuses 'staging: missing sysroot refused' 'not a directory' -- --sysroot "$WORK/nope"
gen_refuses 'staging: unknown argument refused' 'unknown argument' -- --sysroot "$SYS" --bogus
gen_refuses 'staging: apply without confirm refused' 'requires --confirm' -- --sysroot "$SYS" --boot-part "$WORK/bp2" --apply
gen_refuses 'staging: wrong confirm refused' 'wrong confirm phrase' -- --sysroot "$SYS" --boot-part "$WORK/bp2" --apply --confirm WRONG

SYS="$WORK/sys3"; make_sysroot "$SYS"; rm "$SYS/usr/share/initramfs-tools/init"
gen_refuses 'staging: no initramfs-tools /init refused' 'refuses to guess boot ordering' -- --sysroot "$SYS" --boot-part "$WORK/bp2"

SYS="$WORK/sys4"; make_sysroot "$SYS"
grep -v 'run_scripts /scripts/init-bottom' "$SYS/usr/share/initramfs-tools/init" > "$WORK/i.tmp" && mv "$WORK/i.tmp" "$SYS/usr/share/initramfs-tools/init"
gen_refuses 'staging: /init without init-bottom refused' 'phase' -- --sysroot "$SYS" --boot-part "$WORK/bp2"

SYS="$WORK/sys5"; make_sysroot "$SYS"
printf '#!/bin/sh\nrun_scripts /scripts/init-top\nrun_scripts /scripts/init-bottom\nmountroot\nmount -n -o move /run ${rootmnt}/run\nexec run-init x\n' \
	> "$SYS/usr/share/initramfs-tools/init"
gen_refuses 'staging: init-bottom BEFORE mountroot refused' 'ordering contract violated' -- --sysroot "$SYS" --boot-part "$WORK/bp2"

SYS="$WORK/sys6"; make_sysroot "$SYS"
printf '#!/bin/sh\nrun_scripts /scripts/init-top\nmountroot\nmount -n -o move /run ${rootmnt}/run\nrun_scripts /scripts/init-bottom\nexec run-init x\n' \
	> "$SYS/usr/share/initramfs-tools/init"
gen_refuses 'staging: /run move BEFORE init-bottom refused' 'would not relocate' -- --sysroot "$SYS" --boot-part "$WORK/bp2"

SYS="$WORK/sys7"; make_sysroot "$SYS"
printf '#!/bin/sh\nrun_scripts /scripts/init-top\nmountroot\nrun_scripts /scripts/init-bottom\nmount -n -o move /run ${rootmnt}/run\n' \
	> "$SYS/usr/share/initramfs-tools/init"
gen_refuses 'staging: /init without run-init/switch_root refused' 'neither run-init nor switch_root' -- --sysroot "$SYS" --boot-part "$WORK/bp2"

SYS="$WORK/sys8"; make_sysroot "$SYS"
sed -i 's|move /dev|copy /dev|g; s|--move /dev|--copy /dev|g' "$SYS/usr/share/initramfs-tools/scripts/init-bottom/udev"
gen_refuses 'staging: udev not moving /dev refused' 'does not move /dev' -- --sysroot "$SYS" --boot-part "$WORK/bp2"

SYS="$WORK/sys9"; make_sysroot "$SYS"; rm "$SYS/usr/share/initramfs-tools/scripts/init-bottom/udev"
gen_refuses 'staging: udev script missing refused' 'no udev init-bottom script' -- --sysroot "$SYS" --boot-part "$WORK/bp2"

SYS="$WORK/sys10"; make_sysroot "$SYS"; rm "$SYS/bin/busybox"
gen_refuses 'staging: busybox missing refused' 'no executable /bin/busybox' -- --sysroot "$SYS" --boot-part "$WORK/bp2"

SYS="$WORK/sys11"; make_sysroot "$SYS"
rm -rf "$SYS/lib/modules/6.12.109+rpt-rpi-v8/kernel/fs/overlay"
: > "$SYS/lib/modules/6.12.109+rpt-rpi-v8/modules.builtin"
gen_refuses 'staging: no overlayfs evidence refused' 'no kernel overlayfs evidence' -- --sysroot "$SYS" --boot-part "$WORK/bp2"

SYS="$WORK/sys12"; make_sysroot "$SYS"
printf '\nPackage: overlayroot\nStatus: install ok installed\n' >> "$SYS/var/lib/dpkg/status"
gen_refuses 'staging: overlayroot package conflict refused' 'conflict' -- --sysroot "$SYS" --boot-part "$WORK/bp2"

SYS="$WORK/sys13"; make_sysroot "$SYS"
printf 'overlayroot="tmpfs:recurse=0"\n' > "$SYS/etc/overlayroot.conf"
gen_refuses 'staging: overlayroot.conf conflict refused' 'conflicting volatile-root mechanism' -- --sysroot "$SYS" --boot-part "$WORK/bp2"

SYS="$WORK/sys14"; make_sysroot "$SYS"
printf 'vault /dev/disk/by-uuid/1234 none luks,discard\n' > "$SYS/etc/crypttab"
gen_refuses 'staging: active crypttab refused (vault stays late)' 'unlocked LATE by the storage broker' -- --sysroot "$SYS" --boot-part "$WORK/bp2"

SYS="$WORK/sys15"; make_sysroot "$SYS"
make_bootpart "$WORK/bp15" 'init=/usr/lib/raspberrypi-sys-mods/firstboot'
gen_refuses 'staging: pending firstboot init= refused' 'pending vendor firstboot/init trigger' -- --sysroot "$SYS" --boot-part "$WORK/bp15"

SYS="$WORK/sys16"; make_sysroot "$SYS"; rm "$SYS/boot/grub/grub.cfg"
gen_refuses 'staging: unverifiable cmdline refused' 'cannot verify the kernel command line' -- --sysroot "$SYS"

SYS="$WORK/sys17"; make_sysroot "$SYS"
printf '/dev/sdb1 /var ext4 defaults 0 2\n' >> "$SYS/etc/fstab"
gen_refuses 'staging: persistent /var mount refused' 'persistent non-boot filesystem mounts' -- --sysroot "$SYS" --boot-part "$WORK/bp2"

SYS="$WORK/sys18"; make_sysroot "$SYS"
mkdir -p "$SYS/etc/initramfs-tools/scripts/init-bottom"
printf '#!/bin/sh\necho tampered\n' > "$SYS/etc/initramfs-tools/scripts/init-bottom/portable-volatile-root"
gen_refuses 'staging: preexisting differing boot script refused' 'different content' -- --sysroot "$SYS" --boot-part "$WORK/bp2"

SYS="$WORK/sys19"; make_sysroot "$SYS"
printf 'VOLATILE_ROOT_MODE=maybe\nUPPER_SIZE=1G\n' > "$WORK/bad.conf"
gen_refuses 'staging: invalid config refused' 'invalid VOLATILE_ROOT_MODE' -- --sysroot "$SYS" --boot-part "$WORK/bp2" --config "$WORK/bad.conf"

# positive fstab policy dry-run (ro boot kept; swap commented in plan)
SYS="$WORK/sys20"; make_sysroot "$SYS"; make_bootpart "$WORK/bp20"
printf 'PARTUUID=test / ext4 defaults 0 1\nPARTUUID=12345678-02  /boot/firmware  vfat    ro,defaults  0 2\n/dev/mmcblk0p2  none  swap  sw  0 0\n' > "$SYS/etc/fstab"
OUT="$("$GEN" --sysroot "$SYS" --boot-part "$WORK/bp20" 2>&1)"; rc=$?
expect_rc 'staging: ro-boot + swap fstab dry-run ok' 0 "$rc"
expect_contains 'staging: swap disabled in plan' "$OUT" 'disabled by stage-volatile-root.sh'

# ------------------------------------------------- staging: apply phase ------
printf '== staging: apply phase (mapped-root user namespace, NO mounts) ==\n'
if [ "${PORTABLE_IMAGE_TESTS_IN_NS:-0}" != 1 ]; then
	if unshare --user --map-root-user true 2>/dev/null; then
		exec unshare --user --map-root-user -- \
			env PORTABLE_IMAGE_TESTS_IN_NS=1 bash "$0" "$@"
	fi
	skip 'apply-phase tests: user namespaces unavailable (no --apply executed)'
else
	APSYS="$WORK/apply1"; make_sysroot "$APSYS"
	printf 'PARTUUID=test / ext4 defaults 0 1\nPARTUUID=12345678-02  /boot/firmware  vfat    defaults  0 2\n/dev/mmcblk0p2  none  swap  sw  0 0\n' > "$APSYS/etc/fstab"
	make_bootpart "$WORK/bpA"
	[ "$(id -u)" = 0 ] && ok 'apply: running as mapped root' || bad 'apply: expected mapped root'
	"$GEN" --sysroot "$APSYS" --boot-part "$WORK/bpA" --apply --confirm VOLATILE-IMAGE > "$WORK/apply.out" 2>&1; rc=$?
	expect_rc 'apply: good sysroot succeeds' 0 "$rc"
	for f in \
		"$APSYS/etc/initramfs-tools/scripts/init-bottom/portable-volatile-root" \
		"$APSYS/etc/initramfs-tools/hooks/portable-volatile-root" \
		"$APSYS/etc/portable-volatile-root.conf" \
		"$APSYS/etc/systemd/journald.conf.d/portable-volatile.conf" \
		"$APSYS/etc/systemd/system.conf.d/portable-volatile.conf"; do
		[ -f "$f" ] && ok "apply: wrote $(basename "$f")" || bad "apply: wrote $f"
	done
	[ -x "$APSYS/etc/initramfs-tools/scripts/init-bottom/portable-volatile-root" ] \
		&& ok 'apply: boot script executable' || bad 'apply: boot script executable'
	[ "$(stat -c '%U' "$APSYS/etc/portable-volatile-root.conf")" = root ] \
		&& ok 'apply: staged config root-owned' || bad 'apply: staged config root-owned'
	expect_contains 'apply: fstab boot ro' "$(cat "$APSYS/etc/fstab")" '/boot/firmware vfat ro'
	expect_contains 'apply: fstab swap disabled' "$(cat "$APSYS/etc/fstab")" '# portable-image: disabled'
	expect_contains 'apply: fstab backup kept' "$(ls "$APSYS/etc" | tr '\n' ' ')" 'fstab.portable-image.bak'
	expect_contains 'apply: journald volatile' "$(cat "$APSYS/etc/systemd/journald.conf.d/portable-volatile.conf")" 'Storage=volatile'
	expect_contains 'apply: dphys-swapfile masked' "$(readlink "$APSYS/etc/systemd/system/dphys-swapfile.service")" '/dev/null'
	if grep -Eq '^[[:space:]]*[^#[:space:]].*[[:space:]]swap[[:space:]]' "$APSYS/etc/fstab"; then
		bad 'apply: no active swap entries remain'
	else
		ok 'apply: no active swap entries remain'
	fi
	"$GEN" --sysroot "$APSYS" --boot-part "$WORK/bpA" --apply --confirm VOLATILE-IMAGE >/dev/null 2>&1; rc=$?
	expect_rc 'apply: identical re-apply idempotent' 0 "$rc"
	printf 'tamper\n' >> "$APSYS/etc/initramfs-tools/hooks/portable-volatile-root"
	"$GEN" --sysroot "$APSYS" --boot-part "$WORK/bpA" --apply --confirm VOLATILE-IMAGE >"$WORK/apply2.out" 2>&1; rc=$?
	expect_rc 'apply: tampered staged file refused' 6 "$rc"
	expect_contains 'apply: tamper refusal message' "$(cat "$WORK/apply2.out")" 'different content'
	printf 'Storage=persistent\n[Journal]\n' > "$APSYS/etc/systemd/journald.conf.d/portable-volatile.conf"
	"$GEN" --sysroot "$APSYS" --boot-part "$WORK/bpA" --apply --confirm VOLATILE-IMAGE >"$WORK/apply3.out" 2>&1; rc=$?
	expect_rc 'apply: differing policy drop-in refused' 6 "$rc"
fi

# Independent review regressions: actual refusals, not grep-only assertions.
sc 'zero upper refused' 'VOLATILE_ROOT_MODE=overlay-tmpfs
UPPER_SIZE=0M
JOURNAL_MAX_USE=64M' 1
sc 'zero padded journal refused' 'VOLATILE_ROOT_MODE=overlay-tmpfs
UPPER_SIZE=1G
JOURNAL_MAX_USE=0000G' 1
sc 'missing upper refused' 'VOLATILE_ROOT_MODE=overlay-tmpfs
JOURNAL_MAX_USE=64M' 1
sc 'missing journal refused' 'VOLATILE_ROOT_MODE=overlay-tmpfs
UPPER_SIZE=1G' 1
for token in firstboot prefixfirstbootsuffix systemd.run=/boot/firstrun.sh rw rootflags=rw fsck.mode=force fsck.repair=yes resume=/dev/vda; do
 SYS="$WORK/reg-$RANDOM"; make_sysroot "$SYS"; make_bootpart "$WORK/reg-bp" "$token"
 gen_refuses "regression: cmdline $token" 'refused' -- --sysroot "$SYS" --boot-part "$WORK/reg-bp"
done
for fstype in auto nfs fuse overlay efivarfs; do
 SYS="$WORK/reg-$RANDOM"; make_sysroot "$SYS"; printf '/dev/test /persist %s defaults 0 0\n' "$fstype" >> "$SYS/etc/fstab"
 gen_refuses "regression: fstab $fstype" 'fstab refused' -- --sysroot "$SYS"
done
SYS="$WORK/reg-links"; make_sysroot "$SYS"; ln -s "$WORK" "$WORK/linkancestor"
gen_refuses 'regression: intermediate sysroot symlink' 'unsafe' -- --sysroot "$WORK/linkancestor/reg-links"
mkdir -p "$SYS/etc/systemd/journald.conf.d"; ln -s "$WORK/no-such-file" "$SYS/etc/systemd/journald.conf.d/portable-volatile.conf"
gen_refuses 'regression: dangling output symlink' 'unsafe' -- --sysroot "$SYS"
[ ! -e "$WORK/no-such-file" ] && ok 'regression: outside sentinel untouched' || bad 'regression: sentinel write'
SB="$WORK/reg-ambiguous"; boot_rig "$SB"; cp "$EXAMPLE" "$SB/pvr.conf"
{ mi_ro_root "$SB/root"; mi_ro_root "$SB/root"; } > "$WORK/reg-mi"
run_boot_script "$SB" "$WORK/reg-mi" "$WORK/cmd.ok"; expect_rc 'regression: duplicate mountpoint refused' 1 $?
mi_ro_root "$SB/root" | sed 's/,noload//' > "$WORK/reg-mi"
run_boot_script "$SB" "$WORK/reg-mi" "$WORK/cmd.ok"; expect_rc 'regression: ro without noload refused' 1 $?
mkdir -p "$WORK/guard-safe-bin"
printf '#!/bin/sh\nexit 1\n' > "$WORK/guard-safe-bin/poweroff"
cp "$WORK/guard-safe-bin/poweroff" "$WORK/guard-safe-bin/halt"
chmod 755 "$WORK/guard-safe-bin/"*
# Guard export proof in a synthetic /conf: no actual boot or mounts.
printf 'root=/dev/vda ro\n' > "$WORK/guard-cmd"
printf 'panic() { exit 19; }\n' > "$WORK/guard-functions"
PATH="$WORK/guard-safe-bin:/usr/bin:/bin" PVR_FUNCTIONS="$WORK/guard-functions" PVR_CMDLINE="$WORK/guard-cmd" PVR_PARAM_CONF="$WORK/guard-param" dash "$SRC_DIR/scripts/init-top/00-portable-volatile-guard"
expect_rc 'early guard accepts supported cmdline' 0 $?
if ( . "$WORK/guard-param"; [ "$readonly:$ROOTFLAGS:$fastboot:$noresume:$RESUME" = 'y:-o noload:y:y:none' ] ); then ok 'early guard exports mount/fsck/resume policy'; else bad 'early guard policy'; fi
for token in firstboot rw rootflags=rw fsck.mode=force systemd.run=/boot/firstrun.sh; do
 printf '%s\n' "$token" > "$WORK/guard-cmd"
 timeout 1 env PATH="$WORK/guard-safe-bin:/usr/bin:/bin" PVR_FUNCTIONS="$WORK/guard-functions" PVR_CMDLINE="$WORK/guard-cmd" PVR_PARAM_CONF="$WORK/guard-param" dash "$SRC_DIR/scripts/init-top/00-portable-volatile-guard"
 expect_rc "early guard refuses $token despite exiting panic" 124 $?
done

# Apply containment refusal uses only a synthetic tree and a dangling sentinel.
if unshare --user --map-root-user true 2>/dev/null; then
 SYS="$WORK/reg-apply-link"; make_sysroot "$SYS"
 mkdir -p "$SYS/etc/systemd/journald.conf.d"
 ln -s "$WORK/escaped-sentinel" "$SYS/etc/systemd/journald.conf.d/portable-volatile.conf"
 unshare --user --map-root-user "$GEN" --sysroot "$SYS" --apply --confirm VOLATILE-IMAGE > "$WORK/reg-apply.out" 2>&1
 expect_rc 'apply containment: dangling destination refused' 6 $?
 [ ! -e "$WORK/escaped-sentinel" ] && ok 'apply containment: outside sentinel absent' || bad 'apply containment: outside write'
fi
# If panic and shutdown both return, ORDER must never regain control.
mkdir -p "$WORK/no-shutdown"
printf '#!/bin/sh\nexit 0\n' > "$WORK/no-shutdown/poweroff"
cp "$WORK/no-shutdown/poweroff" "$WORK/no-shutdown/halt"
chmod 755 "$WORK/no-shutdown/"*
printf 'panic() { return 0; }\n' > "$WORK/returning-functions"
printf 'rw\n' > "$WORK/guard-cmd"
timeout 2 env PATH="$WORK/no-shutdown:/usr/bin:/bin" PVR_FUNCTIONS="$WORK/returning-functions" PVR_CMDLINE="$WORK/guard-cmd" PVR_PARAM_CONF="$WORK/guard-param" dash "$SRC_DIR/scripts/init-top/00-portable-volatile-guard"
expect_rc 'early guard cannot return when recovery/shutdown returns' 124 $?

# Open failure and ENOSPC must never return to ORDER, even when both shutdown
# executors fail. /dev/full is a kernel sink; no real filesystem is filled.
printf '#!/bin/sh\nexit 1\n' > "$WORK/no-shutdown/poweroff"
cp "$WORK/no-shutdown/poweroff" "$WORK/no-shutdown/halt"
printf 'ro root=/dev/vda\n' > "$WORK/guard-cmd"
for destination in /dev/full "$WORK/absent-directory/param.conf"; do
 timeout 2 env PATH="$WORK/no-shutdown:/usr/bin:/bin" PVR_FUNCTIONS="$WORK/returning-functions" PVR_CMDLINE="$WORK/guard-cmd" PVR_PARAM_CONF="$destination" dash -c '
   "$1"
   touch "$2"
 ' dash "$SRC_DIR/scripts/init-top/00-portable-volatile-guard" "$WORK/boot-continued" > "$WORK/write-failure.out" 2>&1
 expect_rc "early guard write failure blocks ORDER: $destination" 124 $?
 [ ! -e "$WORK/boot-continued" ] && ok 'write failure never reaches next ORDER command' || bad 'write failure continued boot'
done

SYS="$WORK/root-options"; make_sysroot "$SYS"
sed -i 's/defaults,noatime/rw,discard,x-systemd.growfs,x-systemd.makefs,errors=remount-ro/' "$SYS/etc/fstab"
"$GEN" --sysroot "$SYS" > "$WORK/root-options.out" 2>&1
expect_rc 'physical root automutation options normalized' 0 $?
expect_contains 'physical root retains safe options, noload and pass0' "$(cat "$WORK/root-options.out")" 'ext4 ro,errors=remount-ro,noload 0 0'
SYS="$WORK/duplicate-root"; make_sysroot "$SYS"
printf 'PARTUUID=other / ext4 defaults 0 1\n' >> "$SYS/etc/fstab"
gen_refuses 'duplicate physical root row refused' 'root row must be unique' -- --sysroot "$SYS"
SB="$WORK/duplicate-overlay-root"; boot_rig "$SB"; cp "$EXAMPLE" "$SB/pvr.conf"
printf 'PARTUUID=other / ext4 defaults 0 1\n' >> "$SB/root/etc/fstab"
mi_ro_root "$SB/root" > "$WORK/duplicate-overlay-mi"
run_boot_script "$SB" "$WORK/duplicate-overlay-mi" "$WORK/cmd.ok"
expect_rc 'duplicate overlay root row refuses boot' 1 $?
expect_lacks 'failed RAM rewrite leaves fstab unpublished' "$(cat "$SB/root/etc/fstab")" 'portable-volatile-root / overlay'

for fault in mktemp awk mv; do
 SB="$WORK/rewrite-$fault"; boot_rig "$SB"; cp "$EXAMPLE" "$SB/pvr.conf"
 if [ "$fault" = awk ]; then
  cat > "$SB/bin/awk" <<'STUB'
#!/bin/sh
case "$*" in *'portable-volatile-root / overlay rw 0 0'*) exit 1 ;; esac
exec /usr/bin/awk "$@"
STUB
 else
  printf '#!/bin/sh\nexit 1\n' > "$SB/bin/$fault"
 fi
 chmod 755 "$SB/bin/$fault"
 mi_ro_root "$SB/root" > "$WORK/rewrite-$fault.mi"
 run_boot_script "$SB" "$WORK/rewrite-$fault.mi" "$WORK/cmd.ok"
 expect_rc "RAM fstab $fault failure refuses boot" 1 $?
 expect_lacks "RAM fstab $fault failure unpublished" "$(cat "$SB/root/etc/fstab")" 'portable-volatile-root / overlay'
 expect_contains "RAM fstab $fault failure lower unchanged" "$(cat "$SB/runbase/lower/lower-fstab-evidence")" 'PARTUUID=test / ext4 ro,noload 0 0'
done


for fault in missing symlink etc-symlink; do
 SB="$WORK/fstab-$fault"; boot_rig "$SB"; cp "$EXAMPLE" "$SB/pvr.conf"
 case "$fault" in
  missing) rm "$SB/root/etc/fstab" ;;
  symlink) mv "$SB/root/etc/fstab" "$SB/original"; ln -s "$SB/original" "$SB/root/etc/fstab" ;;
  etc-symlink) mv "$SB/root/etc" "$SB/original-etc"; ln -s "$SB/original-etc" "$SB/root/etc" ;;
 esac
 mi_ro_root "$SB/root" > "$WORK/fstab-$fault.mi"
 run_boot_script "$SB" "$WORK/fstab-$fault.mi" "$WORK/cmd.ok"
 expect_rc "RAM fstab $fault refused" 1 $?
done
SYS="$WORK/debian-overlay-path"; make_sysroot "$SYS"
for directory in "$SYS"/lib/modules/*/kernel/fs/overlay; do mv "$directory" "${directory}fs"; done
"$GEN" --sysroot "$SYS" > "$WORK/debian-overlay-path.out" 2>&1
expect_rc 'Debian kernel fs/overlayfs module path accepted' 0 $?

SYS="$WORK/unsafe-growroot-marker"; make_sysroot "$SYS"
ln -s "$WORK/marker-outside" "$SYS/etc/growroot-disabled"
gen_refuses 'unsafe growroot-disable marker symlink refused' 'unsafe' -- --sysroot "$SYS"
if unshare --user --map-root-user true 2>/dev/null; then
 SYS="$WORK/growroot-marker-apply"; make_sysroot "$SYS"
 unshare --user --map-root-user "$GEN" --sysroot "$SYS" --apply --confirm VOLATILE-IMAGE > "$WORK/growroot-marker-apply.log" 2>&1
 expect_rc 'growroot marker staged in mapped-root apply' 0 $?
 unshare --user --map-root-user sh -c '[ -f "$1" ] && [ ! -L "$1" ] && [ "$(stat -c %u "$1")" = 0 ] && [ "$(stat -c %a "$1")" = 644 ]' sh "$SYS/etc/growroot-disabled"
 expect_rc 'staged growroot marker root-owned regular0644' 0 $?
fi

# Real initramfs panic can call exit after a failed reboot. Isolate that exit
# and prove neither script returns to the next ORDER command.
printf 'panic() { exit 0; }\n' > "$WORK/exiting-panic-functions"
printf 'rw panic=1\n' > "$WORK/panic-cmd"
: > "$WORK/panic-mountinfo"
for script in "$SRC_DIR/scripts/init-top/00-portable-volatile-guard" "$BOOT"; do
 timeout 2 env PATH="$WORK/no-shutdown:/usr/bin:/bin" PVR_FUNCTIONS="$WORK/exiting-panic-functions" PVR_CMDLINE="$WORK/panic-cmd" PVR_CFG="$EXAMPLE" PVR_MOUNTINFO="$WORK/panic-mountinfo" rootmnt="$WORK/panic-root" dash -c '
  "$1"
  touch "$2"
 ' dash "$script" "$WORK/panic-returned" > "$WORK/panic-exit.out" 2>&1
 expect_rc "panic exit contained: $script" 124 $?
 [ ! -e "$WORK/panic-returned" ] && ok 'panic exit never reaches next ORDER script' || bad 'panic exit escaped failure loop'
done


# ------------------------------------------------------------------- summary --
printf '\nsummary: pass=%d fail=%d skip=%d\n' "$PASS" "$FAIL" "$SKIPPED"
[ "$FAIL" -eq 0 ]
