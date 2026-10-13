#!/usr/bin/env python3
"""Portable archive acceptance/refusal with synthetic public inputs; no installs."""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


class PortablePackage(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='abalone-portable-test-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        runtime = self.base / 'build' / 'abalone'
        (runtime / 'bin').mkdir(parents=True)
        (runtime / 'lib').mkdir()
        for name in ('config.mjs', 'state-path.mjs', 'credit-store.mjs'):
            (runtime / 'lib' / name).write_bytes((ROOT / 'lib' / name).read_bytes())
        (runtime / 'lib' / 'credit.mjs').write_text('export {};\n')
        (runtime / 'package.json').write_text('{"type":"module"}')
        launcher = runtime / 'bin' / 'abalone'
        launcher.write_text('''#!/usr/bin/env node
import { STATE, ROOT } from '../lib/config.mjs';
import { portableWorkspace } from '../lib/state-path.mjs';
console.log(JSON.stringify({state:STATE, workspace:portableWorkspace(ROOT,process.cwd())}));
''')
        launcher.chmod(0o755)
        self.archive = self.base / 'runtime.tar.gz'
        with tarfile.open(self.archive, 'w:gz') as tar:
            tar.add(runtime, arcname='abalone')
        self.public = self.base / 'public'
        self.public.mkdir()
        (self.public / 'trial.json').write_text(json.dumps({'platform': 'linux-node24-owned-host', 'issuer': {'pin': 'issuer-pin.json', 'approval': 'staging-approval.json'}}))
        for name in ('issuer-pin.json', 'staging-approval.json', 'readiness.json'):
            (self.public / name).write_text('{"synthetic":true}')

    def command(self, out='packed', sha=None):
        return ['python3', str(ROOT / 'tools/pack-portable.py'), '--runtime-archive', str(self.archive),
                '--runtime-sha256', sha or hashlib.sha256(self.archive.read_bytes()).hexdigest(),
                '--trial-dir', str(self.public), '--rev', 'abcdef0', '--out', str(self.base / out)]

    def run_pack(self, **kw):
        return subprocess.run(self.command(**kw), capture_output=True, text=True)

    def test_unpack_launch_and_relocation_preserve_access_without_home_state(self):
        result = self.run_pack()
        self.assertEqual(result.returncode, 0, result.stderr)
        archive = self.base / 'packed' / 'abalone-abcdef0-portable.tar.gz'
        actual = hashlib.sha256(archive.read_bytes()).hexdigest()
        self.assertEqual(archive.with_name(archive.name + '.sha256').read_text().split()[0], actual)
        (self.base / 'unpacked').mkdir()
        subprocess.run(['tar', '-xzf', str(archive), '-C', str(self.base / 'unpacked')], check=True)
        container = self.base / 'unpacked' / 'abalone-abcdef0-portable'
        metadata = json.loads((container / 'portable.json').read_text())
        self.assertEqual(metadata['runtimeSha256'], hashlib.sha256(self.archive.read_bytes()).hexdigest())
        for name, sha in metadata['publicFileSha256'].items():
            packed = next((container / 'public-credit').glob('*/' + name))
            self.assertEqual(hashlib.sha256(packed.read_bytes()).hexdigest(), sha)
        home = self.base / 'home'; home.mkdir()
        env = {k: v for k, v in os.environ.items() if k != 'ABALONE_DIR'}
        env['HOME'] = str(home)
        def launch(where):
            r = subprocess.run(['./abalone/bin/abalone'], cwd=where, env=env, capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            return json.loads(r.stdout)
        launched = launch(container)
        self.assertEqual(launched['state'], str(container / 'state'))
        self.assertEqual(launched['workspace'], str(container / 'work'))
        (container / 'state' / 'access.json').write_text('{"synthetic":"retained"}')
        moved = self.base / 'moved-client'; container.rename(moved)
        self.assertEqual(launch(moved)['state'], str(moved / 'state'))
        self.assertEqual((moved / 'state' / 'access.json').read_text(), '{"synthetic":"retained"}')
        self.assertFalse((home / '.abalone').exists())

    def test_wrong_digest_and_nonportable_runtime_refuse_before_output(self):
        self.assertNotEqual(self.run_pack(sha='0' * 64).returncode, 0)
        self.assertFalse((self.base / 'packed').exists())
        with tarfile.open(self.archive, 'r:gz') as source:
            entries = [(m, source.extractfile(m).read() if m.isfile() else None) for m in source if m.name != 'abalone/lib/state-path.mjs']
        with tarfile.open(self.archive, 'w:gz') as target:
            for m, raw in entries:
                target.addfile(m, io.BytesIO(raw) if raw is not None else None)
        self.assertNotEqual(self.run_pack().returncode, 0)
        self.assertFalse((self.base / 'packed').exists())

    def test_unsafe_paths_links_special_files_and_local_state_refuse(self):
        pristine = self.archive.read_bytes()
        cases = [('abalone/../escape', tarfile.REGTYPE, ''), ('/escape', tarfile.REGTYPE, ''),
                 ('abalone/link', tarfile.SYMTYPE, '../../escape'), ('abalone/hard', tarfile.LNKTYPE, 'outside'),
                 ('abalone/device', tarfile.CHRTYPE, ''), ('abalone/state/secret', tarfile.REGTYPE, '')]
        for name, kind, link in cases:
            with self.subTest(name=name):
                self.archive.write_bytes(pristine)
                with tarfile.open(self.archive, 'r:gz') as source:
                    entries = [(m, source.extractfile(m).read() if m.isfile() else None) for m in source]
                with tarfile.open(self.archive, 'w:gz') as target:
                    for m, raw in entries:
                        target.addfile(m, io.BytesIO(raw) if raw is not None else None)
                    bad = tarfile.TarInfo(name); bad.type = kind; bad.linkname = link
                    target.addfile(bad, io.BytesIO(b''))
                self.assertNotEqual(self.run_pack().returncode, 0)
                self.assertFalse((self.base / 'packed').exists())

    def test_composed_and_cyclic_link_graphs_refuse(self):
        pristine = self.archive.read_bytes()
        for pairs in [('link', '.', 'escape', 'link/../outside'), ('one', 'two', 'two', 'one')]:
            with self.subTest(pairs=pairs):
                self.archive.write_bytes(pristine)
                with tarfile.open(self.archive, 'r:gz') as source:
                    entries = [(m, source.extractfile(m).read() if m.isfile() else None) for m in source]
                with tarfile.open(self.archive, 'w:gz') as target:
                    for m, raw in entries:
                        target.addfile(m, io.BytesIO(raw) if raw is not None else None)
                    for name, destination in zip(pairs[::2], pairs[1::2]):
                        link = tarfile.TarInfo('abalone/' + name)
                        link.type = tarfile.SYMTYPE; link.linkname = destination
                        target.addfile(link)
                self.assertNotEqual(self.run_pack().returncode, 0)
                self.assertFalse((self.base / 'packed').exists())

    def test_hard_link_to_a_symlink_cannot_relocate_its_target(self):
        with tarfile.open(self.archive, 'r:gz') as source:
            entries = [(m, source.extractfile(m).read() if m.isfile() else None) for m in source]
        with tarfile.open(self.archive, 'w:gz') as target:
            for m, raw in entries:
                target.addfile(m, io.BytesIO(raw) if raw is not None else None)
            target.addfile(tarfile.TarInfo('abalone/file'), io.BytesIO(b''))
            symbolic = tarfile.TarInfo('abalone/deep/dir/sym')
            symbolic.type = tarfile.SYMTYPE; symbolic.linkname = '../../file'; target.addfile(symbolic)
            hard = tarfile.TarInfo('abalone/hard')
            hard.type = tarfile.LNKTYPE; hard.linkname = 'abalone/deep/dir/sym'; target.addfile(hard)
        self.assertNotEqual(self.run_pack().returncode, 0)
        self.assertFalse((self.base / 'packed').exists())

    def test_existing_output_and_symlink_public_input_refuse(self):
        self.assertEqual(self.run_pack().returncode, 0)
        archive = self.base / 'packed' / 'abalone-abcdef0-portable.tar.gz'
        before = archive.read_bytes()
        self.assertNotEqual(self.run_pack().returncode, 0)
        self.assertEqual(archive.read_bytes(), before)
        (self.public / 'issuer-pin.json').unlink()
        (self.public / 'issuer-pin.json').symlink_to(self.public / 'readiness.json')
        self.assertNotEqual(self.run_pack(out='other').returncode, 0)
        self.assertFalse((self.base / 'other').exists())


if __name__ == '__main__':
    unittest.main()
