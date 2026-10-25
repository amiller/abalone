"""Offline fixtures only; no ARM execution, package installs, mounts, or services."""
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / 'stage-runtime.py'
spec = importlib.util.spec_from_file_location('runtime_stage', SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def fixture(base):
    root = base / 'image'
    (root / 'etc').mkdir(parents=True)
    (root / 'etc/passwd').write_text('root:x:0:0:root:/root:/bin/sh\n')
    (root / 'etc/group').write_text('root:x:0:\n')
    (root / 'etc/shadow').write_text('root:*:0:0:99999:7:::\n')
    artifact = base / 'artifacts'
    files = {}
    node = bytearray(64)
    node[:6] = b'\x7fELF\x02\x01'
    node[18:20] = (183).to_bytes(2, 'little')
    for name, body, mode in (
        ('bin/node', bytes(node), 0o755),
        ('bin/portable-clock', bytes(node), 0o755),
        ('vendor/pi/sdk/node_modules/@earendil-works/pi-coding-agent/dist/index.js',
         b'export const VERSION="offline-fixture";\n', 0o644),
    ):
        p = artifact / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(body)
        files[name] = {'sha256': m.sha(body), 'mode': mode}
    link = artifact / 'vendor/pi/packages/coding-agent'
    link.parent.mkdir(parents=True)
    target = '../sdk/node_modules/@earendil-works/pi-coding-agent'
    link.symlink_to(target)
    manifest = {'version': 1, 'files': files, 'links': {'vendor/pi/packages/coding-agent': target}}
    source = {name: m.sha(m.source_path(name).read_bytes()) for name in m.SOURCE_NAMES}
    for tree in (root, artifact):
        for parent, dirs, names in os.walk(tree):
            Path(parent).chmod(0o755)
            for name in names:
                p = Path(parent) / name
                if not p.is_symlink():
                    p.chmod(0o644)
    (root / 'etc/shadow').chmod(0o600)
    return root, artifact, manifest, source


class Stage(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root, self.artifact, self.manifest, self.source = fixture(self.base)

    def tearDown(self):
        self.temp.cleanup()

    def test_dry_plan_has_exact_native_workspace_and_no_rehearsal_payload(self):
        outputs, files, links = m.build(self.root, self.source, self.artifact, self.manifest)
        self.assert_shared_source_closure(outputs)
        self.assertIn('etc/sysusers.d/portable-runtime.conf', outputs)
        self.assertIn('etc/systemd/system/portable-workspace.service', outputs)
        for name in ('funding/credit-lease-entry.mjs', 'funding/ppq-balance-curl.mjs',
                     'funding/ppq-record.mjs', 'raspberry-pi/storage/financial-lease-run.py',
                     'raspberry-pi/storage/financial_lease.py', 'raspberry-pi/storage/guest/vault-broker.py'):
            self.assertIn('opt/portable/portable/' + name, outputs)
        self.assertNotIn(b'--credit-socket',
                         outputs['etc/systemd/system/portable-workspace-ui.service'][0])
        self.assertIn(b'd /run/portable-credit 0755 portable-credit portable-credit -',
                      outputs['etc/tmpfiles.d/portable-runtime.conf'][0])
        credit_unit = outputs['etc/systemd/system/portable-credit.service'][0]
        self.assertNotIn(b'[Install]', credit_unit)
        self.assertNotIn(b'WantedBy=', credit_unit)
        self.assertIn(b'Restart=no', credit_unit)
        self.assertIn(b'KillMode=mixed', credit_unit)
        self.assertNotIn('etc/systemd/system/portable-agent.service.d/99-workspace-handoff-preserve.conf', outputs)
        self.assertFalse((self.root / 'opt').exists())
        self.assertEqual(len(files), 3)
        self.assertEqual(set(links), {'vendor/pi/packages/coding-agent'})

    def assert_shared_source_closure(self, outputs, tools=False):
        expected = {'lib/provider-balance.mjs', 'lib/provider-credit-projection.mjs', 'lib/inference-socket.mjs', 'agents/pi/broker-provider.mjs'}
        if tools:
            expected |= {'lib/near-tool-codec.mjs', 'lib/near-tool-bridge.mjs'}
        for name in expected:
            self.assertEqual(outputs['opt/portable/' + name], (m.source_path(name).read_bytes(), 0o644))
        for old in ('funding/balance.mjs', 'funding/credit-projection.mjs',
                    'inference/near-tool-codec.mjs', 'inference/near-tool-bridge.mjs'):
            self.assertNotIn('opt/portable/portable/' + old, outputs)
        # Verify actual consumer imports resolve in the installed tree, not just
        # that an unreferenced copy of a shared module happened to be included.
        references = set()
        for name, (body, _) in outputs.items():
            if not name.endswith('.mjs'):
                continue
            for target in re.findall(r"(?:from\s*|import\s*)['\"]([^'\"]+)['\"]", body.decode()):
                if not target.startswith('.') or Path(target).name not in {Path(p).name for p in expected}:
                    continue
                resolved = os.path.normpath(str(Path(name).parent / target))
                self.assertIn(resolved, outputs, name + ' imports missing ' + resolved)
                if resolved.removeprefix('opt/portable/') in expected:
                    references.add(resolved.removeprefix('opt/portable/'))
        self.assertEqual(references, expected)

    def test_shared_source_map_rejects_unlisted_or_traversing_sources(self):
        for name in ('../lib/provider-balance.mjs', 'lib/credit.mjs', '/lib/provider-balance.mjs'):
            with self.assertRaisesRegex(m.Refusal, 'unknown runtime source'):
                m.source_path(name)
            with self.assertRaises(m.Refusal):
                m.source_destination(name)

    def test_shared_source_missing_or_changed_pins_refuse_without_writes(self):
        adapter_sources = {'lib/inference-socket.mjs', 'agents/pi/broker-provider.mjs'}
        for profile, names in (('default', m.BALANCE_SOURCES | adapter_sources), ('direct-zai', m.BALANCE_SOURCES | m.TOOL_SOURCES | adapter_sources)):
            pins = {name: m.sha(m.source_path(name).read_bytes()) for name in m.source_names(profile)}
            for name in names:
                for change in ('missing', 'digest'):
                    with self.subTest(profile=profile, source=name, change=change):
                        bad = dict(pins)
                        if change == 'missing':
                            del bad[name]
                        else:
                            bad[name] = '0' * 64
                        with self.assertRaisesRegex(m.Refusal, 'source closure|source digest'):
                            m.build(self.root, bad, self.artifact, self.manifest, profile)
                        self.assertFalse((self.root / 'opt').exists())

    def direct_fixture(self):
        self.source = {name: m.sha(m.source_path(name).read_bytes()) for name in m.source_names('direct-zai')}
        extras = {
            '@earendil-works/pi-ai/package.json': json.dumps({'name':'@earendil-works/pi-ai','exports':{'.':{'import':'./dist/index.js'},'./compat':{'import':'./dist/compat.js'}}}),
            '@earendil-works/pi-ai/dist/index.js': 'export {};',
            '@earendil-works/pi-ai/dist/compat.js': 'export {};',
            'openai/package.json': '{"name":"openai"}',
            'openai/index.mjs': 'export {};', 'openai/LICENSE': 'synthetic test notice',
        }
        for name, text in extras.items():
            name = 'vendor/pi/sdk/node_modules/' + name
            p = self.artifact / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text)
            self.manifest['files'][name] = {'sha256':m.sha(p.read_bytes()),'mode':0o644}

    def test_near_explicit_profile_missing_dependencies_refuses_then_stages_inactive(self):
        self.direct_fixture()
        self.source = {n:m.sha(m.source_path(n).read_bytes()) for n in m.source_names('direct-near',True)}
        with self.assertRaisesRegex(m.Refusal,'NEAR dependency'):
            m.build(self.root,self.source,self.artifact,self.manifest,'direct-near',True)
        names = ['lib/near.mjs','lib/coupon-near.mjs','lib/config.mjs','lib/keccak.mjs','lib/nvidia-gpu.mjs','verifiers/near/nearai_mainnet.json']
        extras = {n:(m.PORTABLE.parent/n).read_bytes() for n in names}
        extras.update({n:b'synthetic closure fixture' for n in ['vendor/phala-aci/package.json','vendor/phala-aci/verifier-ts/dist/index.js','vendor/phala-aci/verifier-ts/dist/node/transport.js','vendor/phala-aci/verifier-ts/LICENSE','node_modules/@noble/curves/LICENSE']})
        for n,v in [('node_modules/@phala/dcap-qvl/package.json','0.6.6'),('node_modules/undici/package.json','7.29.0'),('node_modules/@noble/curves/package.json','2.4.0')]:extras[n]=json.dumps({'version':v}).encode()
        extras.update({n+'/package.json':json.dumps({'version':v['version']}).encode() for n,v in m.NEAR_DEPENDENCIES.items()})
        for n,b in extras.items():
            p=self.artifact/n;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b)
            self.manifest['files'][n]={'sha256':m.sha(b),'mode':0o644}
        outputs,_,_=m.build(self.root,self.source,self.artifact,self.manifest,'direct-near',True)
        self.assert_shared_source_closure(outputs, tools=True)
        for name in m.BALANCE_SOURCES | m.TOOL_SOURCES:
            for change in ('missing', 'digest'):
                bad = dict(self.source)
                if change == 'missing': del bad[name]
                else: bad[name] = '0' * 64
                with self.assertRaisesRegex(m.Refusal, 'source closure|source digest'):
                    m.build(self.root,bad,self.artifact,self.manifest,'direct-near',True)
        self.assertIn(b'--credit-socket /run/portable-credit/credit.sock', outputs['etc/systemd/system/portable-workspace-ui.service.d/50-direct-near.conf'][0])
        self.assertIn(b'near.sock',outputs['etc/systemd/system/portable-agent.service.d/50-direct-near.conf'][0])
        self.assertIn(b'--profile near',outputs['etc/systemd/system/portable-vault-enrollment.service.d/50-direct-near.conf'][0])
        self.assertEqual(outputs['opt/portable/portable/raspberry-pi/display/sway.config'][0].count(b'console-status.py bar --near-warning'), 1)
        self.assertIn('opt/portable/portable/raspberry-pi/display/home-command.py', outputs)
        self.assertFalse(any('.wants/' in n for n in outputs))
        self.assertEqual(outputs['etc/systemd/system/portable-credit.service'][0],(m.PORTABLE/'raspberry-pi/storage/units/portable-credit.service').read_bytes())
        bad='node_modules/@noble/curves/LICENSE';del self.manifest['files'][bad]
        with self.assertRaises(m.Refusal):m.build(self.root,self.source,self.artifact,self.manifest,'direct-near',True)

    def test_direct_optin_complete_closure_and_unchanged_authority(self):
        self.direct_fixture()
        outputs, _, _ = m.build(self.root,self.source,self.artifact,self.manifest,'direct-zai')
        self.assert_shared_source_closure(outputs, tools=True)
        for source in m.DIRECT_SOURCES:
            self.assertIn(m.source_destination(source),outputs)
        for target in m.DIRECT_DROPINS:
            self.assertIn('etc/systemd/system/'+target,outputs)
        self.assertIn(b'2750 portable-credit portable-ipc',outputs['etc/tmpfiles.d/portable-runtime.conf'][0])
        self.assertIn(b'--credit-session',outputs['etc/systemd/system/portable-vault-broker.service.d/30-credit-session.conf'][0])
        self.assertIn(b'/run/portable-inference/zai.sock',outputs['etc/systemd/system/portable-agent.service.d/50-direct-zai.conf'][0])
        unit=outputs['etc/systemd/system/portable-credit.service'][0]
        self.assertEqual(unit,(m.PORTABLE/'raspberry-pi/storage/units/portable-credit.service').read_bytes())
        self.assertNotIn(b'[Install]',unit)
        self.assertFalse(any('.wants/' in n or n.endswith(('provider.json','vault.conf')) for n in outputs))
        self.assertFalse(any(b'fixture-' in outputs[m.source_destination(n)][0] or b'virtio' in outputs[m.source_destination(n)][0] for n in m.DIRECT_SOURCES))
        with self.assertRaises(m.Refusal):m.build(self.root,self.source,self.artifact,self.manifest)
        with self.assertRaises(m.Refusal):m.source_names('arbitrary-provider')

    def test_direct_actual_mapped_apply_and_repeat(self):
        self.direct_fixture()
        self.test_real_mapped_root_apply_under_umask077_and_repeat()
        self.assertTrue((self.root/'etc/systemd/system/portable-credit.service.d/50-direct-zai.conf').is_file())
        # Switching back cannot silently retain direct-mode unit overrides.
        defaults={name:m.sha(m.source_path(name).read_bytes()) for name in m.SOURCE_NAMES}
        with self.assertRaises(m.Refusal):m.build(self.root,defaults,self.artifact,self.manifest)

    def test_direct_graph_with_actual_systemd_parser_and_cycle_negative(self):
        self.direct_fixture()
        pins={name:m.sha(m.source_path(name).read_bytes()) for name in m.source_names('direct-zai',True)}
        outputs, _, _=m.build(self.root,pins,self.artifact,self.manifest,'direct-zai',True)
        units=self.root/'etc/systemd/system'
        for name,(body,mode) in outputs.items():
            if name.startswith('etc/systemd/'):
                p=self.root/name;p.parent.mkdir(parents=True,exist_ok=True)
                # Host systemd249 lacks verify --root. Substitute executables
                # only; validate the exact dependency/drop-in graph in isolation.
                p.write_text(re.sub(r'^ExecStart=.+$', 'ExecStart=/usr/bin/true',body.decode(),flags=re.M))
        for name in ('sysinit.target','basic.target','sockets.target','shutdown.target','local-fs.target','systemd-tmpfiles-setup.service','tor-guest-firewall.service','tor-guest.service','getty@tty3.service'):
            (units/name).write_text('[Unit]\nDefaultDependencies=no\n'+('[Service]\nType=oneshot\nExecStart=/usr/bin/true\n' if name.endswith('.service') else ''))
        def verify():
            return subprocess.run(['/usr/bin/systemd-analyze','verify',str(units/'portable-credit.service'),str(units/'portable-agent.service'),str(units/'portable-vault-broker.service'),str(units/'portable-vault-enrollment.service')],env={**os.environ,'SYSTEMD_UNIT_PATH':str(units)},capture_output=True,text=True,timeout=15)
        result=verify();self.assertEqual(result.returncode,0,result.stderr)
        # Demonstrate the graph check detects an ordering cycle, not just parse success.
        for name,other in (('portable-credit','portable-agent'),('portable-agent','portable-credit')):
            p=units/(name+'.service.d/cycle.conf');p.parent.mkdir(exist_ok=True);p.write_text('[Unit]\nRequires='+other+'.service\nAfter='+other+'.service\n')
        result=verify();self.assertNotEqual(result.returncode,0);self.assertIn('cycle',result.stderr.lower())

    def test_local_enrollment_explicit_direct_only_no_enable_or_namespace(self):
        with self.assertRaisesRegex(m.Refusal,'requires a direct profile'):
            m.source_names(local_enrollment=True)
        self.direct_fixture()
        pins={name:m.sha(m.source_path(name).read_bytes()) for name in m.source_names('direct-zai',True)}
        outputs,_,_=m.build(self.root,pins,self.artifact,self.manifest,'direct-zai',True)
        for name in m.ENROLLMENT_SOURCES:self.assertIn('opt/portable/portable/'+name,outputs)
        unit=outputs['etc/systemd/system/portable-vault-enrollment.service'][0].decode()
        self.assertIn('User=root',unit);self.assertIn('TTYPath=/dev/tty3',unit)
        self.assertNotIn('[Install]',unit)
        active=[line for line in unit.splitlines() if line and not line.startswith('#')]
        for directive in ('PrivateTmp=','PrivateMounts=','ProtectSystem=','ProtectHome=','MountFlags=','RootDirectory='):
            self.assertFalse(any(line.startswith(directive) for line in active))
        self.assertFalse(any('.wants/' in name for name in outputs))
        self.assertNotIn(b'enrollment',outputs['etc/systemd/system/portable-agent.service'][0])
        with self.assertRaises(m.Refusal):m.build(self.root,self.source,self.artifact,self.manifest,'direct-zai',True)

    def test_direct_missing_lazy_dependency_notice_or_source_refuses(self):
        self.direct_fixture()
        for name in ('openai/index.mjs','openai/LICENSE','@earendil-works/pi-ai/dist/compat.js'):
            name='vendor/pi/sdk/node_modules/'+name
            row=self.manifest['files'].pop(name);body=(self.artifact/name).read_bytes();(self.artifact/name).unlink()
            with self.assertRaisesRegex(m.Refusal,'direct SDK dependency'):
                m.build(self.root,self.source,self.artifact,self.manifest,'direct-zai')
            (self.artifact/name).write_bytes(body);self.manifest['files'][name]=row
        self.source.pop('inference/direct-zai-entry.mjs')
        with self.assertRaisesRegex(m.Refusal,'source closure'):
            m.build(self.root,self.source,self.artifact,self.manifest,'direct-zai')
        self.assertFalse((self.root/'opt').exists())

    def test_clock_is_explicit_pinned_arm_artifact_and_inactive(self):
        outputs, files, _ = m.build(self.root, self.source, self.artifact, self.manifest)
        unit = outputs['etc/systemd/system/portable-clock.service'][0]
        self.assertNotIn(b'[Install]', unit)
        self.assertNotIn(b'WantedBy=', unit)
        self.assertIn('bin/portable-clock', files)
        self.assertFalse(any('.wants/' in name or name.endswith('clock.json') for name in outputs))
        for name in m.CLOCK_SOURCES:
            self.assertIn('opt/portable/portable/' + name, outputs)
        record = self.manifest['files'].pop('bin/portable-clock')
        with self.assertRaisesRegex(m.Refusal, 'explicit prebuilt clock'):
            m.build(self.root, self.source, self.artifact, self.manifest)
        self.manifest['files']['bin/portable-clock'] = record
        path = self.artifact / 'bin/portable-clock'
        original = path.read_bytes()
        for body, mode, digest in (
            (original, 0o644, m.sha(original)),
            (original[:18] + (62).to_bytes(2, 'little') + original[20:], 0o755, None),
            (b'not an ELF', 0o755, None),
            (original, 0o755, '0' * 64),
        ):
            path.write_bytes(body)
            record.update(mode=mode, sha256=digest or m.sha(body))
            with self.assertRaises(m.Refusal):
                m.build(self.root, self.source, self.artifact, self.manifest)
        self.assertFalse((self.root / 'opt').exists())

    def test_vault_console_static_closure_exact_modes(self):
        outputs, _, _ = m.build(self.root, self.source, self.artifact, self.manifest)
        for name, source in m.EXECUTABLE_ALIASES.items():
            self.assertEqual(outputs['opt/portable/bin/' + name],
                             (outputs['opt/portable/portable/' + source][0], 0o755))
        self.assertIn('etc/systemd/system/portable-vault-operator.service', outputs)
        unit = outputs['etc/systemd/system/portable-vault-broker.service'][0].decode()
        self.assertNotIn('--credit-session', next(x for x in unit.splitlines() if x.startswith('ExecStart=')))
        self.assertFalse(any('.wants/' in name or name.endswith('vault.conf') for name in outputs))
        self.assertNotIn('etc/systemd/system/portable-vault-broker.service.d/30-credit-session.conf', outputs)

    def test_reserved_identity_and_privileged_membership_refused_before_writes(self):
        for table, line in (
            ('passwd', 'someone:x:970:970::/home/someone:/bin/sh\n'),
            ('passwd', 'someone:x:0970:1000::/home/someone:/bin/sh\n'),
            ('group', 'sudo:x:27:portable-agent\n'),
        ):
            path = self.root / 'etc' / table
            old = path.read_text()
            path.write_text(old + line)
            with self.assertRaises(m.Refusal):
                m.build(self.root, self.source, self.artifact, self.manifest)
            self.assertFalse((self.root / 'opt').exists())
            path.write_text(old)

    def test_foreign_primary_membership_in_every_protected_group_refused(self):
        path = self.root / 'etc/passwd'
        before = path.read_text()
        for gid in m.GROUPS.values():
            with self.subTest(gid=gid):
                path.write_text(before + f'someone:x:1500:{gid}::/home/someone:/bin/sh\n')
                with self.assertRaises(m.Refusal):
                    m.build(self.root, self.source, self.artifact, self.manifest)
        path.write_text(before)

    def test_unreviewed_source_or_dropin_cannot_reset_hardening(self):
        pins = dict(self.source)
        pins['workspace/server.mjs'] = '0' * 64
        with self.assertRaises(m.Refusal):
            m.build(self.root, pins, self.artifact, self.manifest)
        p = self.root / 'etc/systemd/system/portable-agent.service.d/reset.conf'
        p.parent.mkdir(parents=True)
        for directory in (self.root / 'etc/systemd', self.root / 'etc/systemd/system', p.parent):
            directory.chmod(0o755)
        p.write_text('[Service]\nNoNewPrivileges=no\n')
        p.chmod(0o644)
        with self.assertRaises(m.Refusal):
            m.build(self.root, self.source, self.artifact, self.manifest)

    def test_artifact_extra_private_state_wrong_arch_and_link_escape_refused(self):
        p = self.artifact / 'vendor/pi/auth.json'
        p.write_text('{"secret":"synthetic-canary"}')
        with self.assertRaises(m.Refusal):
            m.artifact_plan(self.artifact, self.manifest)
        p.unlink()
        node = self.artifact / 'bin/node'
        original = node.read_bytes()
        node.write_bytes(b'not ARM')
        self.manifest['files']['bin/node']['sha256'] = m.sha(node.read_bytes())
        with self.assertRaises(m.Refusal):
            m.artifact_plan(self.artifact, self.manifest)
        node.write_bytes(original)
        self.manifest['files']['bin/node']['sha256'] = m.sha(node.read_bytes())
        outside = self.artifact / 'outside'
        outside.write_text('outside vendor subtree')
        link = self.artifact / 'vendor/pi/packages/coding-agent'
        link.unlink()
        link.symlink_to('../../../outside')
        self.manifest['links']['vendor/pi/packages/coding-agent'] = '../../../outside'
        with self.assertRaises(m.Refusal):
            m.artifact_plan(self.artifact, self.manifest)
        for name in ('../outside', '/absolute', 'vendor/pi/../escape'):
            with self.assertRaises(m.Refusal):
                m.relative(name)

    def test_destination_symlink_cannot_escape_image(self):
        outside = self.base / 'outside'
        outside.mkdir()
        (self.root / 'opt').symlink_to(outside)
        with self.assertRaises(m.Refusal):
            m.build(self.root, self.source, self.artifact, self.manifest)
        self.assertEqual(list(outside.iterdir()), [])

    def test_complete_accounts_requires_locked_identity_and_exact_groups(self):
        with self.assertRaises(m.Refusal):
            m.accounts(self.root, complete=True)
        with (self.root / 'etc/passwd').open('a') as f:
            for name, uid in m.USERS.items():
                f.write(f'{name}:x:{uid}:{uid}::/var/lib/portable/{name}:/usr/sbin/nologin\n')
        with (self.root / 'etc/group').open('a') as f:
            for name, gid in m.GROUPS.items():
                f.write(f'{name}:x:{gid}:{",".join(sorted(m.MEMBERS.get(name, set())))}\n')
        with (self.root / 'etc/shadow').open('a') as f:
            for name in m.USERS:
                f.write(f'{name}:!:0:0:99999:7:::\n')
        m.accounts(self.root, complete=True)
        passwd = self.root / 'etc/passwd'
        old = passwd.read_text()
        passwd.write_text(old.replace('portable-agent:x:', 'portable-agent::'))
        with self.assertRaises(m.Refusal):
            m.accounts(self.root, complete=True)
        passwd.write_text(old)
        p = self.root / 'etc/shadow'
        p.write_text(p.read_text().replace('portable-agent:!:', 'portable-agent::'))
        with self.assertRaises(m.Refusal):
            m.accounts(self.root, complete=True)

    def test_actual_sysusers_declarations_create_locked_exact_account_graph(self):
        config = self.root / 'etc/sysusers.d/portable-runtime.conf'
        config.parent.mkdir(mode=0o755)
        config.parent.chmod(0o755)
        config.write_text(m.SYSUSERS)
        config.chmod(0o644)
        result = subprocess.run(['unshare', '--user', '--map-root-user',
                                 '/usr/bin/systemd-sysusers', '--root=' + str(self.root)],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        m.accounts(self.root, complete=True)

    def test_real_mapped_root_apply_under_umask077_and_repeat(self):
        # Inputs are tiny fake ELF/SDK fixtures. Execute actual CLI in a user
        # namespace so ownership/modes are real without host-root privileges.
        paths = []
        for name, data in (('sources.json', self.source), ('artifacts.json', self.manifest)):
            p = self.base / name
            p.write_text(json.dumps(data, sort_keys=True))
            paths.append((p, m.sha(p.read_bytes())))
        cmd = [sys.executable, str(SCRIPT), '--sysroot', str(self.root),
               '--source-manifest', str(paths[0][0]), '--source-manifest-sha', paths[0][1],
               '--artifacts', str(self.artifact), '--artifact-manifest', str(paths[1][0]),
               '--artifact-manifest-sha', paths[1][1], '--apply', '--confirm', 'PORTABLE-RUNTIME-IMAGE']
        if 'inference/direct-zai-entry.mjs' in self.source:
            cmd += ['--profile', 'direct-zai']
        for _ in range(2):
            r = subprocess.run(['unshare', '--user', '--map-root-user', 'sh', '-c',
                                'umask 077; exec "$@"', 'offline-test', *cmd],
                               capture_output=True, text=True, timeout=20)
            self.assertEqual(r.returncode, 0, r.stderr)
        node = self.root / 'opt/portable/bin/node'
        entry = self.root / 'opt/portable/vendor/pi/packages/coding-agent/dist/index.js'
        self.assertEqual(stat.S_IMODE(node.stat().st_mode), 0o755)
        self.assertEqual(entry.read_bytes(), b'export const VERSION="offline-fixture";\n')
        for p in (node.parent, entry.resolve().parent, self.root / 'etc/sysusers.d'):
            self.assertEqual(stat.S_IMODE(p.stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE((self.root / 'etc/systemd/system/portable-agent.service').stat().st_mode), 0o644)


if __name__ == '__main__':
    unittest.main(verbosity=2)
