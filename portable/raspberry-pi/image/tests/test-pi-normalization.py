"""Synthetic offline roots only; no image, boot, service or vendor script execution."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'stage-pi-normalization.py'
spec = importlib.util.spec_from_file_location('normalizer', SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def fixture(base):
    root = base / 'root'
    root.mkdir()
    records = {}
    for name in sorted(m.FILES):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        body = ('reviewed synthetic ' + name + '\n').encode()
        if name == 'boot/firmware/cmdline.txt':
            body = b'console=tty1 root=PARTUUID=12345678-02 rootfstype=ext4 fsck.repair=yes rootwait init=/usr/lib/raspberrypi-sys-mods/firstboot\n'
        mode = 0o755 if name in m.RETIRE else 0o644
        path.write_bytes(body)
        path.chmod(mode)
        records[name] = {'sha256': m.sha(body), 'mode': mode}
    for name, target in m.LINKS.items():
        p = root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.symlink_to(target)
    for parent, dirs, files in os.walk(root):
        Path(parent).chmod(0o755)
    profile = {'version': 1, 'files': records, 'links': m.LINKS, 'provenance': {'fixture': True}}
    raw = m.encode(profile)
    path = base / 'profile.json'
    path.write_bytes(raw)
    return root, profile, raw, path


class Normalization(unittest.TestCase):
    def setUp(self):
        self.old_umask = os.umask(0o022)
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root, self.profile, self.raw, self.path = fixture(self.base)

    def tearDown(self):
        self.temp.cleanup()
        os.umask(self.old_umask)

    def test_dry_plan_exact_scope_and_unchanged_source(self):
        plan, inputs, body = m.build(self.root, self.profile, self.raw)
        self.assertEqual(set(plan['retireFiles']), m.RETIRE)
        self.assertEqual(body, b'console=tty1 root=PARTUUID=12345678-02 rootfstype=ext4 rootwait\n')
        self.assertFalse((self.root / m.BACKUP).exists())
        self.assertEqual((self.root / 'boot/firmware/cmdline.txt').read_bytes(), inputs['boot/firmware/cmdline.txt'])

    def test_unknown_content_profile_or_mode_refuses(self):
        p = self.root / sorted(m.RETIRE)[0]
        p.write_bytes(b'unknown vendor upgrade')
        with self.assertRaises(m.Refusal):
            m.build(self.root, self.profile, self.raw)
        with self.assertRaises(m.Refusal):
            m.load_profile(self.path, '0' * 64)
        self.profile['files']['etc/unrelated'] = {'sha256': '0' * 64, 'mode': 0o644}
        self.path.write_bytes(m.encode(self.profile))
        with self.assertRaises(m.Refusal):
            m.load_profile(self.path, m.sha(self.path.read_bytes()))

    def test_unknown_overrides_aliases_markers_and_netplan_refused(self):
        for name, body in [('etc/netplan/new.yaml', b'network: {}'),
                           ('boot/firmware/custom.toml', b'synthetic'),
                           ('usr/lib/systemd/system/userconfig.service.d/new.conf', b'[Service]'),
                           ('run/systemd/system/userconfig.service', b'[Service]')]:
            p = self.root / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(body)
            p.chmod(0o644)
            with self.subTest(name=name), self.assertRaises(m.Refusal):
                m.build(self.root, self.profile, self.raw)
            p.unlink()
        p = self.root / 'etc/systemd/system/unknown-alias.service'
        p.symlink_to('/lib/systemd/system/userconfig.service')
        with self.assertRaises(m.Refusal):
            m.build(self.root, self.profile, self.raw)

    def test_extra_executable_hook_refused_but_documentation_text_allowed(self):
        p = self.root / 'etc/initramfs-tools/scripts/local-top/README'
        p.parent.mkdir(parents=True)
        p.write_text('firstboot imager_fixup are described here\n')
        p.chmod(0o644)
        m.build(self.root, self.profile, self.raw)
        p = p.with_name('firstboot-extra')
        p.write_text('#!/bin/sh\nexit 0\n')
        p.chmod(0o755)
        with self.assertRaises(m.Refusal):
            m.build(self.root, self.profile, self.raw)

    def test_sysv_resize_extra_activation_or_wrong_target_refused(self):
        for name, target in (
                ('etc/rc2.d/S01resize2fs_once', '../init.d/resize2fs_once'),
                ('etc/rcS.d/S99other', '../init.d/resize2fs_once')):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.symlink_to(target)
            with self.subTest(name=name), self.assertRaises(m.Refusal):
                m.build(self.root, self.profile, self.raw)
            path.unlink()
        known = self.root / 'etc/rc3.d/S01resize2fs_once'
        known.unlink()
        known.symlink_to('../init.d/foreign')
        with self.assertRaises(m.Refusal):
            m.build(self.root, self.profile, self.raw)

    def test_generated_resize_mask_without_fabricated_vendor_unit(self):
        self.assertNotIn('usr/lib/systemd/system/resize2fs_once.service', m.FILES)
        plan, _, _ = m.build(self.root, self.profile, self.raw)
        self.assertIn('resize2fs_once.service', plan['maskUnits'])
        override = self.root / 'etc/systemd/system/resize2fs_once.service.d'
        override.mkdir()
        (override / 'local.conf').write_text('[Service]\n')
        with self.assertRaises(m.Refusal):
            m.build(self.root, self.profile, self.raw)

    def test_parent_symlink_hardlink_and_cmdline_conflict_refused(self):
        p = self.root / 'boot/firmware/cmdline.txt'
        os.link(p, self.base / 'extra-link')
        with self.assertRaises(m.Refusal):
            m.build(self.root, self.profile, self.raw)
        (self.base / 'extra-link').unlink()
        for addition in (b' init=/other', b' fsck.repair=no', b' systemd.run=/unknown'):
            with self.assertRaises(m.Refusal):
                m.cmdline(p.read_bytes().strip() + addition + b'\n')
        (self.root / 'run').symlink_to(self.base)
        with self.assertRaises(m.Refusal):
            m.build(self.root, self.profile, self.raw)

    def test_mapped_root_apply_preserves_provenance_firmware_and_refuses_replay(self):
        plan, inputs, _ = m.build(self.root, self.profile, self.raw)
        args = [sys.executable, str(SCRIPT), '--root', str(self.root), '--profile', str(self.path),
                '--profile-sha256', m.sha(self.raw), '--apply', '--plan-sha256', m.sha(m.encode(plan))]
        r = subprocess.run(['unshare', '-Ur', 'sh', '-c', 'umask 077; exec "$@"', 'fixture', *args],
                           capture_output=True, text=True, timeout=20)
        self.assertEqual(r.returncode, 0, r.stderr)
        for name in m.RETIRE:
            self.assertFalse((self.root / name).exists())
            backup = self.root / m.BACKUP / 'original' / name
            self.assertEqual(backup.read_bytes(), inputs[name])
            self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o600)
        for unit in m.UNITS:
            self.assertEqual(os.readlink(self.root / 'etc/systemd/system' / unit), '/dev/null')
            name = 'usr/lib/systemd/system/' + unit
            self.assertEqual((self.root / name).read_bytes(), inputs[name])
        self.assertEqual(os.readlink(self.root / 'etc/systemd/system/resize2fs_once.service'), '/dev/null')
        self.assertFalse((self.root / 'etc/rc3.d/S01resize2fs_once').is_symlink())
        self.assertEqual((self.root / 'boot/firmware/config.txt').read_bytes(), inputs['boot/firmware/config.txt'])
        self.assertEqual(stat.S_IMODE((self.root / 'boot/firmware/cmdline.txt').stat().st_mode), 0o644)
        self.assertTrue((self.root / m.BACKUP / 'completed.json').is_file())
        with self.assertRaises(m.Refusal):
            m.build(self.root, self.profile, self.raw)

    def test_interrupted_intent_and_wrong_plan_never_mutate_startup(self):
        plan, inputs, _ = m.build(self.root, self.profile, self.raw)
        args = [sys.executable, str(SCRIPT), '--root', str(self.root), '--profile', str(self.path),
                '--profile-sha256', m.sha(self.raw), '--apply', '--plan-sha256', '0' * 64]
        r = subprocess.run(['unshare', '-Ur', *args], capture_output=True, text=True, timeout=20)
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse((self.root / m.BACKUP).exists())
        (self.root / m.BACKUP).mkdir(parents=True)
        with self.assertRaises(m.Refusal):
            m.build(self.root, self.profile, self.raw)
        self.assertEqual((self.root / 'boot/firmware/cmdline.txt').read_bytes(), inputs['boot/firmware/cmdline.txt'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
