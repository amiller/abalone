#!/usr/bin/env python3
"""Stage the terminal workspace into an exclusive offline image tree; never execute it."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat

PORTABLE = Path(__file__).resolve().parents[2]
CLOCK_SOURCES = tuple('raspberry-pi/clock/posttor/' + name for name in (
    'COPYING', 'GO-LICENSE', 'NOTICE', 'README.md', 'go.mod',
    'clock.go', 'clock_test.go', 'boottime_linux.go',
    'cmd/portable-clock/LICENSE', 'cmd/portable-clock/README.md',
    'cmd/portable-clock/main.go', 'cmd/portable-clock/transaction.go',
    'cmd/portable-clock/transaction_test.go',
))
EXECUTABLE_ALIASES = {name: 'raspberry-pi/storage/guest/' + name for name in (
    'vault-broker.py', 'common.sh', 'unlock-vault.sh', 'lock-vault.sh', 'vault-status.sh')}
SOURCE_FILES = tuple(EXECUTABLE_ALIASES.values()) + ('raspberry-pi/storage/operator-vt.py',) + CLOCK_SOURCES + tuple('workspace/' + name for name in (
    'server.mjs', 'credit-client.mjs', 'agent-manager.mjs', 'agent-worker.mjs', 'broker-provider.mjs', 'terminal-manager.mjs',
    'terminal_bridge.py', 'desktop-status.mjs', 'ui/index.html', 'ui/app.js', 'ui/style.css',
)) + ('inference/client.mjs',) + tuple('funding/' + name for name in (
    'credit-service.mjs',
    'inherited-lease.mjs', 'ppq-record.mjs', 'ppq-balance-curl.mjs', 'credit-lease-entry.mjs',
)) + tuple('raspberry-pi/storage/' + name for name in (
    'financial-lease-run.py', 'financial_lease.py', 'topology.py', 'topology_collector.py',
    'guest/vault-broker.py',
)) + tuple('workspace-service/' + name for name in (
    'agent-service.mjs', 'backend-client.mjs', 'ipc.mjs', 'syscred.mjs',
    'workspace-files.mjs', 'workspace-files.py',
)) + tuple('raspberry-pi/display/' + name for name in (
    'agent-terminal.py', 'native-terminal-client.py', 'native-terminal-daemon.py', 'browser-ram-launcher.py',
    'home-command.py', 'console-status.py', 'sway-runtime.py', 'sway.config', 'status-line.py', 'status-line.mjs', 'project-status.py',
))
UNITS = {
    'portable-vault-broker.service': 'raspberry-pi/storage/units/portable-vault-broker.service',
    'portable-vault-operator.service': 'raspberry-pi/storage/units/portable-vault-operator.service',
    'portable-clock.service': 'raspberry-pi/clock/portable-clock.service',
    'portable-credit.service': 'raspberry-pi/storage/units/portable-credit.service',
    'portable-workspace.service': 'workspace-service/units/portable-workspace.service',
    'portable-agent.service': 'workspace-service/units/portable-agent.service',
    'portable-workspace-ui.service': 'workspace-service/units/portable-workspace-ui.service',
    **{name: 'raspberry-pi/display/' + name for name in (
        'portable-native-terminal.service', 'portable-display.service',
        'portable-desktop-status.service', 'portable-desktop-status.timer')},
}
# These shared capabilities are reviewed repository sources, not SDK artifacts.
# Keep their source and installed locations explicit; manifest names never use '..'.
REPO_SOURCE_MAP = {
    'lib/inference-socket.mjs': ('lib/inference-socket.mjs', 'opt/portable/lib/inference-socket.mjs'),
    'agents/pi/broker-provider.mjs': ('agents/pi/broker-provider.mjs', 'opt/portable/agents/pi/broker-provider.mjs'),
    'lib/provider-balance.mjs': ('lib/provider-balance.mjs', 'opt/portable/lib/provider-balance.mjs'),
    'lib/provider-credit-projection.mjs': ('lib/provider-credit-projection.mjs', 'opt/portable/lib/provider-credit-projection.mjs'),
    'lib/near-tool-codec.mjs': ('lib/near-tool-codec.mjs', 'opt/portable/lib/near-tool-codec.mjs'),
    'lib/near-tool-bridge.mjs': ('lib/near-tool-bridge.mjs', 'opt/portable/lib/near-tool-bridge.mjs'),
}
BALANCE_SOURCES = {'lib/provider-balance.mjs', 'lib/provider-credit-projection.mjs'}
TOOL_SOURCES = {'lib/near-tool-codec.mjs', 'lib/near-tool-bridge.mjs'}
SOURCE_NAMES = set(SOURCE_FILES) | set(UNITS.values()) | BALANCE_SOURCES | {'lib/inference-socket.mjs', 'agents/pi/broker-provider.mjs'}
DIRECT_SOURCES = {
    'inference/direct-zai-broker.mjs', 'inference/zai-curl-transport.mjs',
    'inference/direct-zai-entry.mjs', 'inference/financial-zai-run.py',
    'raspberry-pi/image/profiles/direct-zai/consumer.conf', 'raspberry-pi/image/profiles/direct-zai/agent.conf',
    'raspberry-pi/storage/units/portable-vault-broker-credit-session.conf',
}
DIRECT_SOURCES |= TOOL_SOURCES
DIRECT_DROPINS = {
    'portable-credit.service.d/50-direct-zai.conf': 'raspberry-pi/image/profiles/direct-zai/consumer.conf',
    'portable-agent.service.d/50-direct-zai.conf': 'raspberry-pi/image/profiles/direct-zai/agent.conf',
    'portable-vault-broker.service.d/30-credit-session.conf': 'raspberry-pi/storage/units/portable-vault-broker-credit-session.conf',
}

NEAR_SOURCES = {'inference/' + name for name in (
    'direct-zai-broker.mjs', 'direct-near-entry.mjs', 'financial-near-run.py',
    'near-session.mjs', 'near-tor-transport.mjs')} | TOOL_SOURCES
NEAR_SOURCES |= {'raspberry-pi/image/profiles/direct-near/' + name for name in ('consumer.conf', 'agent.conf', 'ui.conf', 'enrollment.conf', 'dependencies.json')}
NEAR_SOURCES.add('raspberry-pi/storage/units/portable-vault-broker-credit-session.conf')
NEAR_DROPINS = {
    'portable-credit.service.d/50-direct-near.conf': 'raspberry-pi/image/profiles/direct-near/consumer.conf',
    'portable-agent.service.d/50-direct-near.conf': 'raspberry-pi/image/profiles/direct-near/agent.conf',
    'portable-workspace-ui.service.d/50-direct-near.conf': 'raspberry-pi/image/profiles/direct-near/ui.conf',
    'portable-vault-broker.service.d/30-credit-session.conf': 'raspberry-pi/storage/units/portable-vault-broker-credit-session.conf',
}

ENROLLMENT_UNIT = 'raspberry-pi/storage/units/portable-vault-enrollment.service'
ENROLLMENT_SOURCES = {ENROLLMENT_UNIT} | {'raspberry-pi/storage/' + n for n in (
    'enrollment.py', 'enrollment_native.py', 'enrollment_blank.py', 'enrollment-vt.py')}

def source_names(profile='default', local_enrollment=False):
    need(profile in ('default', 'direct-zai', 'direct-near'), 'unknown runtime profile')
    need(type(local_enrollment) is bool and (not local_enrollment or profile in ('direct-zai', 'direct-near')),
         'local enrollment requires a direct profile')
    return SOURCE_NAMES | (DIRECT_SOURCES if profile == 'direct-zai' else set()) | (NEAR_SOURCES if profile == 'direct-near' else set()) | (ENROLLMENT_SOURCES if local_enrollment else set())

def source_path(name):
    need(name in SOURCE_NAMES | DIRECT_SOURCES | NEAR_SOURCES | ENROLLMENT_SOURCES,
         'unknown runtime source')
    return PORTABLE.parent / REPO_SOURCE_MAP[name][0] if name in REPO_SOURCE_MAP else PORTABLE / name


def source_destination(name):
    # source_path also admits only the finite source lists above.
    source_path(name)
    return REPO_SOURCE_MAP[name][1] if name in REPO_SOURCE_MAP else 'opt/portable/portable/' + name


USERS = {'portable-agent': 970, 'portable-ui': 971, 'portable-credit': 972}
GROUPS = {**USERS, 'portable-operators': 973, 'portable-ipc': 974}
MEMBERS = {'portable-ipc': {'portable-agent', 'portable-ui'},
           'portable-operators': {'portable-credit'}}
SYSUSERS = ''.join(f'g {name} {gid}\n' for name, gid in GROUPS.items()) + ''.join(
    f'u {name} {uid} "Portable {name.removeprefix("portable-")}" '
    f'/var/lib/portable/{name} /usr/sbin/nologin\n' for name, uid in USERS.items()
) + ''.join(f'm {user} {group}\n' for group, users in MEMBERS.items() for user in sorted(users))
TMPFILES = 'd /var/lib/portable 0755 root root -\n' + ''.join(
    f'd /var/lib/portable/{user} 0700 {user} {user} -\n' for user in USERS)
TMPFILES += 'd /run/portable-credit 0755 portable-credit portable-credit -\n'


class Refusal(ValueError):
    pass


def need(value, reason):
    if not value:
        raise Refusal(reason)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def relative(name):
    need(isinstance(name, str) and name and '\\' not in name and '\0' not in name,
         'invalid manifest path')
    p = Path(name)
    need(not p.is_absolute() and all(x not in ('', '.', '..') for x in name.split('/')),
         'manifest path escapes tree')
    return p


def regular(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= limit,
             'not a bounded single regular file: ' + str(path))
        chunks = []
        size = 0
        while True:
            chunk = os.read(fd, min(1024 * 1024, limit + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            need(size <= limit, 'file grew beyond bound')
        after = os.fstat(fd)
        need((before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
             (after.st_size, after.st_mtime_ns, after.st_ctime_ns) and size == before.st_size,
             'input changed while reading')
        return b''.join(chunks)
    finally:
        os.close(fd)


def canonical(root):
    need(root.is_absolute() and root.is_dir() and root.resolve() == root and
         not os.path.samefile(root, '/'), 'canonical offline tree required')


def safe(root, path):
    need(path.is_relative_to(root), 'output outside image')
    for parent in reversed((path.parent, *path.parent.parents)):
        if parent == root or parent.is_relative_to(root):
            if parent.exists() or parent.is_symlink():
                s = parent.lstat()
                need(stat.S_ISDIR(s.st_mode) and s.st_uid in (0, os.getuid()) and
                     not s.st_mode & 0o022, 'unsafe image directory: ' + str(parent))
    if path.exists() or path.is_symlink():
        s = path.lstat()
        need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid in (0, os.getuid()) and
             not s.st_mode & 0o022, 'unsafe existing output: ' + str(path))


def manifest(path, pin):
    raw = regular(path, 16 * 1024 * 1024)
    need(re.fullmatch('[0-9a-f]{64}', pin or '') and sha(raw) == pin, 'manifest digest mismatch')
    def pairs(items):
        out = {}
        for key, value in items:
            need(key not in out, 'duplicate manifest key')
            out[key] = value
        return out
    return json.loads(raw, object_pairs_hook=pairs)


def accounts(root, complete=False):
    tables = {}
    for name, fields in (('passwd', 7), ('group', 4), ('shadow', 9)):
        path = root / 'etc' / name
        safe(root, path)
        rows = [line.split(':') for line in regular(path, 1024 * 1024).decode().splitlines()]
        need(all(len(row) == fields for row in rows), 'malformed account database')
        need(len({row[0] for row in rows}) == len(rows), 'duplicate account name')
        if name in ('passwd', 'group'):
            indexes = (2, 3) if name == 'passwd' else (2,)
            need(all(re.fullmatch(r'0|[1-9][0-9]*', row[i]) and int(row[i]) < 4294967295
                     for row in rows for i in indexes), 'noncanonical account numeric ID')
        tables[name] = {row[0]: row for row in rows}
    for row in tables['passwd'].values():
        if row[3] in {str(gid) for gid in GROUPS.values()}:
            need(row[0] in USERS and row[3] == str(USERS[row[0]]),
                 'foreign primary membership in a protected group')
    for name, gid in GROUPS.items():
        matches = [r for r in tables['group'].values() if r[2] == str(gid)]
        need(not matches or len(matches) == 1 and matches[0][0] == name, 'reserved GID collision')
        row = tables['group'].get(name)
        need(not complete or row is not None, 'required group absent')
        if row:
            allowed = MEMBERS.get(name, set())
            actual = set(filter(None, row[3].split(',')))
            need(row[2] == str(gid) and actual <= allowed and
                 (not complete or actual == allowed), 'unexpected group identity/membership')
    for name, uid in USERS.items():
        matches = [r for r in tables['passwd'].values() if r[2] == str(uid)]
        need(not matches or len(matches) == 1 and matches[0][0] == name, 'reserved UID collision')
        row = tables['passwd'].get(name)
        need(not complete or row is not None, 'required account absent')
        if row:
            need(row[1] == 'x' and row[2:4] == [str(uid), str(uid)] and row[5:] ==
                 ['/var/lib/portable/' + name, '/usr/sbin/nologin'], 'unexpected account identity')
            secret = tables['shadow'].get(name)
            need(secret is not None and secret[1].startswith(('!', '*')), 'account password not locked')
        for group, entry in tables['group'].items():
            if name in entry[3].split(','):
                need(name in MEMBERS.get(group, set()), 'privileged supplemental membership')


NEAR_DEPENDENCIES = json.loads((PORTABLE / 'raspberry-pi/image/profiles/direct-near/dependencies.json').read_text())

def artifact_plan(root, data, near=False):
    canonical(root)
    need(set(data) == {'version', 'files', 'links'} and type(data['version']) is int and
         data['version'] == 1 and isinstance(data['files'], dict) and isinstance(data['links'], dict),
         'artifact manifest schema')
    need(0 < len(data['files']) <= 50000 and len(data['links']) <= 1000, 'artifact count bound')
    need('bin/portable-clock' in data['files'], 'explicit prebuilt clock artifact required')
    need('bin/node' in data['files'] and
         ('vendor/pi/packages/coding-agent' in data['links'] or
          'vendor/pi/packages/coding-agent/dist/index.js' in data['files']), 'Node/SDK entry missing')
    files, links = {}, {}
    for name, record in data['files'].items():
        p = relative(name)
        need(name in ('bin/node', 'bin/portable-clock') or name.startswith('vendor/pi/') or (near and (name in ('lib/near.mjs','lib/coupon-near.mjs','lib/config.mjs','lib/keccak.mjs','lib/nvidia-gpu.mjs','verifiers/near/nearai_mainnet.json') or name.startswith('vendor/phala-aci/') or any(name.startswith(n + '/') for n in NEAR_DEPENDENCIES))), 'unexpected artifact destination')
        need(not any(x in ('.git', '.env', '.npmrc', 'auth.json', 'models.json') for x in p.parts),
             'private/runtime state in artifact')
        need(set(record) == {'sha256', 'mode'} and type(record['mode']) is int and
             record['mode'] in (0o644, 0o755), 'artifact metadata')
        source = root / p
        need(source.resolve() == source, 'linked artifact file/ancestor')
        body = regular(source, 192 * 1024 * 1024)
        need(sha(body) == record['sha256'], 'artifact content mismatch: ' + name)
        if name in ('bin/node', 'bin/portable-clock'):
            need(record['mode'] == 0o755 and body[:6] == b'\x7fELF\x02\x01' and
                 len(body) >= 64 and int.from_bytes(body[18:20], 'little') == 183,
                 name + ' must be reviewed little-endian AArch64 ELF')
        files[name] = (source, record['sha256'], record['mode'])
    for name, target in data['links'].items():
        relative(name)
        need(name.startswith('vendor/pi/') and isinstance(target, str) and
             not Path(target).is_absolute() and '\0' not in target and '\\' not in target,
             'invalid artifact link')
        source = root / name
        need(source.is_symlink() and os.readlink(source) == target, 'artifact link mismatch')
        resolved = source.resolve(strict=True)
        need(resolved.is_relative_to(root / 'vendor/pi') and
             any((root / p) == resolved or (root / p).is_relative_to(resolved) for p in files),
             'artifact link leaves reviewed content')
        links[name] = target
    # No unmanifested file, directory symlink, socket or hidden credential is copied.
    seen = set()
    for parent, dirs, names in os.walk(root, followlinks=False):
        for name in dirs + names:
            p = Path(parent) / name
            if p.is_symlink() or not p.is_dir():
                seen.add(p.relative_to(root).as_posix())
    need(seen == set(files) | set(links), 'artifact tree contains unreviewed entries')
    entry = root / 'vendor/pi/packages/coding-agent/dist/index.js'
    need(entry.resolve(strict=True).relative_to(root).as_posix() in files, 'SDK entry not manifested')
    return files, links


def direct_sdk_closure(root, files):
    # Direct broker uses the qualified installed scoped package layout. The
    # caller's complete manifest remains authoritative; these guards catch the
    # historical omitted lazy OpenAI dependency before an image is written.
    coding = (root / 'vendor/pi/packages/coding-agent/dist/index.js').resolve(strict=True).parent.parent
    need(coding.name == 'pi-coding-agent' and coding.parent.name == '@earendil-works',
         'direct profile requires scoped SDK package layout')
    modules = coding.parent.parent
    required = ('@earendil-works/pi-ai/package.json', '@earendil-works/pi-ai/dist/index.js',
                '@earendil-works/pi-ai/dist/compat.js', 'openai/package.json',
                'openai/index.mjs', 'openai/LICENSE')
    for name in required:
        p = modules / name
        need(p.relative_to(root).as_posix() in files, 'direct SDK dependency/notice missing: ' + name)
    ai = json.loads(regular(modules / '@earendil-works/pi-ai/package.json', 65536))
    need(ai.get('name') == '@earendil-works/pi-ai' and
         ai.get('exports', {}).get('.', {}).get('import') == './dist/index.js' and
         ai.get('exports', {}).get('./compat', {}).get('import') == './dist/compat.js',
         'direct SDK compatibility exports missing')
    need(json.loads(regular(modules / 'openai/package.json', 65536)).get('name') == 'openai',
         'direct SDK OpenAI package mismatch')

def near_dependency_closure(root, files):
    # Supplied complete artifact manifest owns every dependency/license file.
    # No download/build or claim that the Pi SDK contains attestation dependencies.
    required = ('lib/near.mjs', 'lib/coupon-near.mjs', 'lib/config.mjs', 'lib/keccak.mjs', 'lib/nvidia-gpu.mjs',
                'verifiers/near/nearai_mainnet.json', 'vendor/phala-aci/package.json',
                'vendor/phala-aci/verifier-ts/dist/index.js',
                'vendor/phala-aci/verifier-ts/dist/node/transport.js',
                'vendor/phala-aci/verifier-ts/LICENSE',
                'node_modules/@phala/dcap-qvl/package.json',
                'node_modules/undici/package.json',
                'node_modules/@noble/curves/package.json', 'node_modules/@noble/curves/LICENSE')
    for name in required:
        need(name in files, 'NEAR dependency/notice missing: ' + name)
    for name in required[:6]:
        need(sha(regular(root / name, 1024 * 1024)) == sha(regular(PORTABLE.parent / name, 1024 * 1024)),
             'NEAR source artifact mismatch: ' + name)
    for package, record in NEAR_DEPENDENCIES.items():
        name = package + '/package.json'
        need(name in files, 'NEAR transitive package missing: ' + name)
        need(json.loads(regular(root / name, 65536)).get('version') == record['version'], 'NEAR transitive version mismatch: ' + name)
    for name, version in (('node_modules/@phala/dcap-qvl/package.json', '0.6.6'),
                          ('node_modules/undici/package.json', '7.29.0'),
                          ('node_modules/@noble/curves/package.json', '2.4.0')):
        need(json.loads(regular(root / name, 65536)).get('version') == version,
             'NEAR dependency version mismatch: ' + name)


def build(root, source_pins, artifacts, artifact_data, profile='default', local_enrollment=False):
    canonical(root)
    accounts(root)
    selected = source_names(profile, local_enrollment)
    dropins = DIRECT_DROPINS if profile == 'direct-zai' else NEAR_DROPINS if profile == 'direct-near' else {}
    if profile == 'direct-near' and local_enrollment:
        dropins = {**dropins, 'portable-vault-enrollment.service.d/50-direct-near.conf': 'raspberry-pi/image/profiles/direct-near/enrollment.conf'}
    units = {**UNITS, **({'portable-vault-enrollment.service': ENROLLMENT_UNIT} if local_enrollment else {})}
    need(set(source_pins) == selected, 'runtime source closure mismatch')
    for unit in units:
        directory = root / 'etc/systemd/system' / (unit + '.d')
        if directory.exists() or directory.is_symlink():
            safe(root, directory / '.runtime-path-check')
            allowed = {'20-tor-firewall.conf'} if unit == 'portable-workspace-ui.service' else set()
            if profile in ('direct-zai', 'direct-near'):
                allowed |= {Path(n).name for n in dropins if n.startswith(unit + '.d/')}
            need(set(p.name for p in directory.iterdir()) <= allowed,
                 'unreviewed runtime unit drop-ins; stage runtime before image policies')
    outputs = {}
    for name in selected:
        body = regular(source_path(name), 1024 * 1024)
        need(sha(body) == source_pins[name], 'runtime source digest mismatch: ' + name)
        outputs[source_destination(name)] = (body, 0o644)
    for name, source in EXECUTABLE_ALIASES.items():
        outputs['opt/portable/bin/' + name] = (outputs[source_destination(source)][0], 0o755)
    for unit, name in units.items():
        outputs['etc/systemd/system/' + unit] = outputs[source_destination(name)]
    outputs['etc/sysusers.d/portable-runtime.conf'] = (SYSUSERS.encode(), 0o644)
    tmpfiles = TMPFILES
    if profile in ('direct-zai', 'direct-near'):
        tmpfiles += 'd /run/portable-inference 2750 portable-credit portable-ipc -\n'
        for target, source in dropins.items():
            outputs['etc/systemd/system/' + target] = outputs['opt/portable/portable/' + source]
    if profile == 'direct-near':
        old, mode = outputs['opt/portable/portable/raspberry-pi/display/sway.config']
        marker = b'$display/console-status.py bar'
        need(old.count(marker) == 1, 'fixed status command missing')
        outputs['opt/portable/portable/raspberry-pi/display/sway.config'] = (old.replace(marker, marker + b' --near-warning'), mode)
    outputs['etc/tmpfiles.d/portable-runtime.conf'] = (tmpfiles.encode(), 0o644)
    # The UI must fail closed with the same firewall as its agent, even before
    # the separate network stager is run. These dependencies do not create it.
    outputs['etc/systemd/system/portable-workspace-ui.service.d/20-tor-firewall.conf'] = (
        b'[Unit]\nRequires=tor-guest-firewall.service\nAfter=tor-guest-firewall.service\n', 0o644)
    files, links = artifact_plan(artifacts, artifact_data, near=profile == 'direct-near')
    if profile in ('direct-zai', 'direct-near'):
        direct_sdk_closure(artifacts, files)
    if profile == 'direct-near':
        near_dependency_closure(artifacts, files)
    for name in set(outputs) | {'opt/portable/' + n for n in files}:
        target = root / name
        safe(root, target)
        if target.exists():
            expected = sha(outputs[name][0]) if name in outputs else files[name.removeprefix('opt/portable/')][1]
            need(sha(regular(target, 192 * 1024 * 1024)) == expected, 'different existing runtime output')
    for name, target in links.items():
        path = root / 'opt/portable' / name
        safe(root, path.parent / '.runtime-path-check')
        need(not path.exists() and not path.is_symlink() or
             path.is_symlink() and os.readlink(path) == target, 'runtime link conflict')
    return outputs, files, links


def directories(root, path):
    safe(root, path / '.runtime-path-check')
    missing = []
    while path != root and not path.exists():
        missing.append(path)
        path = path.parent
    for path in reversed(missing):
        path.mkdir(mode=0o700)
        os.chown(path, 0, 0)
        os.chmod(path, 0o755)


def publish(root, relative_name, body, mode):
    target = root / relative_name
    safe(root, target)
    directories(root, target.parent)
    temporary = target.with_name(target.name + '.runtime-stage-new')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(os.dup(fd), 'wb') as out:
            out.write(body)
            out.flush()
        os.fchmod(fd, mode)
        os.fchown(fd, 0, 0)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temporary, target)
    need(stat.S_IMODE(target.stat().st_mode) == mode, 'publication mode mismatch')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sysroot', required=True, type=Path)
    parser.add_argument('--source-manifest', type=Path)
    parser.add_argument('--source-manifest-sha')
    parser.add_argument('--artifacts', type=Path)
    parser.add_argument('--artifact-manifest', type=Path)
    parser.add_argument('--artifact-manifest-sha')
    parser.add_argument('--profile', choices=('default', 'direct-zai', 'direct-near'), default='default')
    parser.add_argument('--local-enrollment', action='store_true')
    parser.add_argument('--verify-accounts', action='store_true')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--confirm')
    args = parser.parse_args()
    source_names(args.profile, args.local_enrollment)
    canonical(args.sysroot)
    if args.verify_accounts:
        need(not args.apply, 'account verification never applies changes')
        accounts(args.sysroot, complete=True)
        print(json.dumps({'accountGraphVerified': True}))
        return
    need(all((args.source_manifest, args.source_manifest_sha, args.artifacts,
              args.artifact_manifest, args.artifact_manifest_sha)), 'reviewed manifests/artifacts required')
    source = manifest(args.source_manifest, args.source_manifest_sha)
    artifact = manifest(args.artifact_manifest, args.artifact_manifest_sha)
    outputs, files, links = build(args.sysroot, source, args.artifacts, artifact, args.profile, args.local_enrollment)
    if args.apply:
        need(os.getuid() == 0 and args.confirm == 'PORTABLE-RUNTIME-IMAGE', 'root/offline confirmation required')
        for name, (body, mode) in outputs.items():
            publish(args.sysroot, name, body, mode)
        for name, (path, digest, mode) in files.items():
            body = regular(path, 192 * 1024 * 1024)
            need(sha(body) == digest, 'artifact changed before publication')
            publish(args.sysroot, 'opt/portable/' + name, body, mode)
        for name, target in links.items():
            p = args.sysroot / 'opt/portable' / name
            directories(args.sysroot, p.parent)
            if not p.is_symlink():
                p.symlink_to(target)
    print(json.dumps({'applied': args.apply, 'sourceFiles': len(outputs), 'artifactFiles': len(files),
                      'artifactLinks': links, 'profile': args.profile, 'localEnrollment': args.local_enrollment, 'qualification': 'OFFLINE STAGING ONLY; no model execution or account enrollment',
                      'next': ['create accounts with target systemd-sysusers, then --verify-accounts',
                               'review explicit desktop unit enablement after image policies; keep clock/credit inactive',
                               'qualify actual ARM SDK, native desktop, Tor, persistence and admitted inference']}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (Refusal, OSError, ValueError) as error:
        raise SystemExit('REFUSED: ' + str(error))
