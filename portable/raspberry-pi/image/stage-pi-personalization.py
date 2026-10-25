#!/usr/bin/env python3
"""Pin an offline candidate's boot/root/vault identities; never format or boot."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent

def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

n = module('pi_normalization_io', HERE / 'stage-pi-normalization.py')
t = module('pi_topology_schema', HERE.parent / 'storage/topology.py')
need, sha, encode = n.need, n.sha, n.encode
CMD = 'boot/firmware/cmdline.txt'
FSTAB = 'etc/fstab'
MANIFEST = 'opt/portable/etc/vault-topology.json'
BACKUP = 'var/lib/portable-image/personalization'

def unique(items):
    out = {}
    for key, value in items:
        need(key not in out, 'duplicate profile field')
        out[key] = value
    return out

def profile_read(path, pin):
    raw = n.bounded(path)
    need(sha(raw) == pin, 'profile digest mismatch')
    p = json.loads(raw, object_pairs_hook=unique)
    need(type(p) is dict and set(p) == {'version', 'inputSha256', 'oldDiskId', 'provenance'} and
         type(p['version']) is int and p['version'] == 1, 'unsupported profile')
    need(type(p['inputSha256']) is dict and set(p['inputSha256']) == {CMD, FSTAB}, 'exact input paths required')
    need(all(type(h) is str and re.fullmatch('[0-9a-f]{64}', h) for h in p['inputSha256'].values()), 'bad input digest')
    need(type(p['oldDiskId']) is str and re.fullmatch('[0-9a-f]{8}', p['oldDiskId']) and
         p['oldDiskId'] != '00000000' and type(p['provenance']) is dict, 'bad profile identity')
    return p, raw

def render(inputs, profile, layout_raw):
    layout = t.parse_manifest(layout_raw)
    old = profile['oldDiskId']
    parts = {p['role']: p['partuuid'] for p in layout['partitions']}
    command = inputs[CMD].decode('ascii')
    need('\0' not in command and len(command.splitlines()) == 1, 'single normalized command line required')
    tokens = command.split()
    need([x for x in tokens if x.startswith('root=')] == ['root=PARTUUID=' + old + '-02'], 'unexpected root selection')
    need(tokens.count('rootfstype=ext4') == 1, 'ext4 root required')
    need(not any(x == '--' or x == 'rw' or x == 'noefi' or
                 x.startswith(('init=', 'rdinit=', 'systemd.run', 'efi=', 'pstore.', 'rootflags=',
                               'resume=', 'fsck.', 'ip=', 'nfsroot=', 'boot=', 'portable-volatile-root='))
                 for x in tokens), 'unreviewed boot policy')
    tokens = ['root=PARTUUID=' + parts['root'] if x.startswith('root=') else x for x in tokens]
    updated = (' '.join(tokens + ['efi=noruntime', 'pstore.backend=none']) + '\n').encode()
    output, seen = [], set()
    for line in inputs[FSTAB].decode('ascii').splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            output.append(line); continue
        f = line.split()
        need(len(f) == 6, 'unsupported fstab record')
        source, point, fs, opts, dump, check = f
        need(point not in seen, 'duplicate fstab mount'); seen.add(point)
        if point in ('/', '/boot/firmware'):
            role, suffix, expected = ('root', '-02', 'ext4') if point == '/' else ('boot', '-01', 'vfat')
            need(source == 'PARTUUID=' + old + suffix and fs == expected, 'unexpected fstab identity')
            need(opts in ('defaults', 'defaults,noatime') and dump == '0' and check in ('1', '2'), 'unsupported original fstab options')
            f = ['PARTUUID=' + parts[role], point, fs, 'ro,noload' if role == 'root' else 'ro', '0', '0']
            output.append('\t'.join(f))
        else:
            need(f == ['proc', '/proc', 'proc', 'defaults', '0', '0'], 'unsupported extra fstab mount')
            output.append(line)
    need({'/', '/boot/firmware'} <= seen, 'missing root or boot mount')
    return {CMD: updated, FSTAB: ('\n'.join(output) + '\n').encode(), MANIFEST: layout_raw}

def build(root, profile, profile_raw, layout_raw):
    need(root.is_absolute() and root != Path('/') and root.resolve() == root and root.is_dir()
         and not os.path.samefile(root, '/'), 'canonical offline root required')
    for part in (root, *root.parents):
        need(not part.is_symlink(), 'linked root ancestor')
    marker = n.safe(root, BACKUP, 'directory')
    need(not marker.exists() and not marker.is_symlink(), 'prior personalization intent; no replay')
    inputs, records = {}, {}
    for name in (CMD, FSTAB):
        path = n.safe(root, name); body = n.bounded(path)
        need(sha(body) == profile['inputSha256'][name], 'unreviewed input bytes: ' + name)
        inputs[name] = body
        records[name] = {'sha256': sha(body), 'mode': path.stat().st_mode & 0o777}
    target = n.safe(root, MANIFEST)
    need(not target.exists() and not target.is_symlink(), 'existing topology manifest refused')
    outputs = render(inputs, profile, layout_raw)
    for name in (CMD, FSTAB):
        tmp = n.safe(root, name + '.portable-personalization-new')
        need(not tmp.exists() and not tmp.is_symlink(), 'existing staging output')
    s = root.stat()
    plan = {'version': 1, 'root': str(root), 'rootDev': s.st_dev, 'rootInode': s.st_ino,
            'profileSha256': sha(profile_raw), 'topologySha256': sha(layout_raw),
            'sourceSha256': {str(p.relative_to(HERE.parent)): sha(p.read_bytes()) for p in
                             (Path(__file__).resolve(), HERE/'stage-pi-normalization.py', HERE.parent/'storage/topology.py')},
            'inputs': records, 'outputs': {k: sha(v) for k, v in outputs.items()},
            'qualification': 'candidate identities only; no filesystem UUID change, formatting or boot'}
    return plan, inputs, outputs

def apply(root, plan, inputs, outputs, profile_raw):
    n.write_new(root, BACKUP + '/intent.json', encode(plan), 0o600)
    n.write_new(root, BACKUP + '/profile.json', profile_raw, 0o600)
    for name, body in inputs.items():
        n.write_new(root, BACKUP + '/original/' + name, body, 0o600)
    for name, body in outputs.items():
        if name == MANIFEST:
            n.write_new(root, name, body, 0o644)
        else:
            n.write_new(root, name + '.portable-personalization-new', body, 0o644)
            os.replace(root / (name + '.portable-personalization-new'), root / name)
            fd = os.open((root / name).parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try: os.fsync(fd)
            finally: os.close(fd)
    n.write_new(root, BACKUP + '/completed.json', encode({'planSha256': sha(encode(plan))}), 0o600)

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--root', type=Path, required=True)
    ap.add_argument('--profile', type=Path, required=True)
    ap.add_argument('--profile-sha256', required=True)
    ap.add_argument('--topology', type=Path, required=True)
    ap.add_argument('--topology-sha256', required=True)
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--plan-sha256')
    a = ap.parse_args()
    profile, profile_raw = profile_read(a.profile, a.profile_sha256)
    raw = n.bounded(a.topology)
    need(sha(raw) == a.topology_sha256, 'topology digest mismatch')
    plan, inputs, outputs = build(a.root, profile, profile_raw, raw)
    digest = sha(encode(plan))
    if a.apply:
        need(os.getuid() == 0 and a.plan_sha256 == digest, 'root and exact plan approval required')
        apply(a.root, plan, inputs, outputs, profile_raw)
    print(json.dumps({'plan': plan, 'planSha256': digest, 'applied': a.apply}, indent=2))

if __name__ == '__main__':
    try: main()
    except (ValueError, OSError, UnicodeError) as error:
        raise SystemExit('REFUSED: ' + str(error))
