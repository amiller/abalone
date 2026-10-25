#!/usr/bin/env python3
"""Offline containment preflight; reject unsupported links, never follow them."""
import os, sys
from pathlib import Path
root = Path(sys.argv[1])
def refuse(message):
    raise SystemExit('unsafe offline tree: '+message)
if not root.is_absolute() or root.resolve() == Path('/'):
    refuse('host root/relative root')
for p in (root, *root.parents):
    if p.is_symlink(): refuse('symlink ancestor: '+str(p))
# Only relative usrmerge aliases are supported; all authority/output trees
# must be real directories. No untrusted concurrent writer is supported.
for name in ('etc','usr','var','boot','bin','sbin','lib','lib64'):
    p = root/name
    if p.is_symlink():
        if name not in ('bin','sbin','lib','lib64') or os.readlink(p) != 'usr/'+name:
            refuse('unsupported root alias: '+str(p))
        if not (root/'usr'/name).is_dir() or (root/'usr'/name).is_symlink():
            refuse('invalid usrmerge destination')
paths = ('etc/initramfs-tools','etc/portable-volatile-root.conf','etc/fstab','etc/fstab.portable-image.bak',
 'etc/crypttab','etc/growroot-disabled','etc/overlayroot.conf','etc/systemd/journald.conf.d','etc/systemd/system.conf.d',
 'etc/systemd/coredump.conf.d','etc/cloud/cloud-init.disabled','etc/systemd/system/dphys-swapfile.service',
 'usr/share/initramfs-tools','var/lib/dpkg/status','boot/grub/grub.cfg')
for name in paths:
    p=root/name
    for q in (p,*p.parents):
        if q == root: break
        if q.is_symlink():
            if q == root/'etc/systemd/system/dphys-swapfile.service' and os.readlink(q)=='/dev/null': continue
            refuse('symlink in authority/output path: '+str(q))
    if p.is_dir():
        for directory, dirs, files in os.walk(p, followlinks=False):
            for child in dirs+files:
                q=Path(directory)/child
                if q.is_symlink(): refuse('symlink inside authority/output tree: '+str(q))
marker=root/'etc/growroot-disabled'
if marker.exists() and (not marker.is_file() or marker.stat().st_uid != 0 or marker.stat().st_mode & 0o022):
    refuse('growroot-disabled must be root-owned regular and non-writable by others')
# Busybox may be ordinary file through bin -> usr/bin, never an absolute link.
busy = root/'bin/busybox'
if busy.is_symlink(): refuse('busybox symlink unsupported')
print('offline tree containment checked')
