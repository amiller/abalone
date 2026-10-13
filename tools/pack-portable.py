#!/usr/bin/env python3
"""Repack a pinned runtime and public coupon files; never execute the runtime."""
import argparse
import copy
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import tarfile

PUBLIC = ('trial.json', 'issuer-pin.json', 'staging-approval.json', 'readiness.json')


def digest(stream):
    h = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        h.update(chunk)
    return h.hexdigest()


def public_bundle(directory):
    files = {}
    for name in PUBLIC:
        item = directory / name
        if item.is_symlink() or not item.is_file() or item.stat().st_size > 2 * 1024 * 1024:
            raise ValueError('Use bounded regular public trial files.')
        raw = item.read_bytes()
        if len(raw) > 2 * 1024 * 1024 or not isinstance(json.loads(raw), dict):
            raise ValueError('Use bounded JSON objects for public trial files.')
        files[name] = raw
    trial = json.loads(files['trial.json'])
    if (trial.get('platform') != 'linux-node24-owned-host' or
            trial.get('issuer', {}).get('pin') != 'issuer-pin.json' or
            trial.get('issuer', {}).get('approval') != 'staging-approval.json'):
        raise ValueError('Use the owned-host profile and exact public sibling filenames.')
    hashes = {name: hashlib.sha256(raw).hexdigest() for name, raw in files.items()}
    identity = hashlib.sha256(('\n'.join(hashes.values()) + '\n').encode()).hexdigest()[:16]
    return files, hashes, identity


def checked_members(archive):
    members = archive.getmembers()
    names = set()
    links = {}
    for m in members:
        p = PurePosixPath(m.name)
        canonical = m.name.rstrip('/')
        if (p.is_absolute() or '..' in p.parts or not p.parts or p.parts[0] != 'abalone' or
                any(ord(c) < 32 or ord(c) == 127 for c in m.name) or str(p) != canonical or canonical in names):
            raise ValueError('Runtime archive contains an unsafe or duplicate path.')
        if len(p.parts) > 1 and p.parts[1] in {'state', 'local-data', 'secrets', 'runner-home', '.git'}:
            raise ValueError('Runtime archive includes local state or development storage.')
        if not (m.isfile() or m.isdir() or m.issym() or m.islnk()):
            raise ValueError('Runtime archive contains a special file.')
        names.add(canonical)
        if m.issym() or m.islnk():
            if PurePosixPath(m.linkname).is_absolute() or any(ord(c) < 32 for c in m.linkname):
                raise ValueError('Runtime archive contains an unsafe link.')
            target = posixpath.normpath(posixpath.join(str(p.parent), m.linkname) if m.issym() else m.linkname)
            if target != 'abalone' and not target.startswith('abalone/'):
                raise ValueError('Runtime archive link escapes its runtime.')
            links[canonical] = m
    # Resolve each component through the archive graph BEFORE interpreting '..'.
    # Lexically normalizing link/../x is unsafe when link changes the parent.
    def resolved(link):
        current = [] if link.islnk() else list(PurePosixPath(link.name).parent.parts)
        pending = link.linkname.split('/')
        expansions = 0
        while pending:
            part = pending.pop(0)
            if part in ('', '.'):
                continue
            if part == '..':
                if len(current) <= 1:
                    raise ValueError('Runtime archive link escapes its runtime.')
                current.pop()
                continue
            current.append(part)
            if current[0] != 'abalone':
                raise ValueError('Runtime archive link escapes its runtime.')
            nested = links.get('/'.join(current))
            if nested:
                if link.islnk() and nested.issym():
                    raise ValueError('Runtime hard link traverses a symbolic link.')
                expansions += 1
                if expansions > 40:
                    raise ValueError('Runtime archive contains a cyclic or excessive link chain.')
                current = [] if nested.islnk() else current[:-1]
                pending = nested.linkname.split('/') + pending
        return '/'.join(current)
    regular_names = {m.name for m in members if m.isfile()}
    for link in links.values():
        target = resolved(link)
        if link.islnk() and target not in regular_names:
            raise ValueError('Runtime hard link does not resolve to a regular runtime file.')
    for m in members:
        if any(str(parent) in links for parent in PurePosixPath(m.name).parents):
            raise ValueError('Runtime archive writes through a link.')
    required = {'abalone/bin/abalone', 'abalone/lib/config.mjs', 'abalone/lib/credit.mjs', 'abalone/lib/credit-store.mjs', 'abalone/lib/state-path.mjs'}
    regular = {m.name for m in members if m.isfile()}
    if not required.issubset(regular):
        raise ValueError('Pinned archive lacks the portable-aware client and durable-credit runtime.')
    return members


def add_bytes(archive, name, raw, mode=0o600):
    entry = tarfile.TarInfo(name)
    entry.mode = mode
    entry.size = len(raw)
    archive.addfile(entry, io.BytesIO(raw))


def pack(args):
    if not re.fullmatch(r'[0-9a-f]{7,40}', args.rev) or not re.fullmatch(r'[0-9a-f]{64}', args.runtime_sha256):
        raise ValueError('Use a Git revision and exact runtime SHA256.')
    public, hashes, identity = public_bundle(args.trial_dir)
    prefix = f'abalone-{args.rev}-portable'
    target = args.out / f'{prefix}.tar.gz'
    checksum = args.out / f'{target.name}.sha256'
    if target.exists() or checksum.exists():
        raise ValueError('Output exists; use a fresh output directory.')
    # Open once so a replacement path cannot change which bytes were pinned.
    fd = os.open(args.runtime_archive, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as source:
        if digest(source) != args.runtime_sha256:
            raise ValueError('Runtime archive does not match its pinned SHA256.')
        source.seek(0)
        with tarfile.open(fileobj=source, mode='r:gz') as runtime:
            members = checked_members(runtime)
            args.out.mkdir(parents=True, exist_ok=True)
            try:
                with target.open('xb') as output, gzip.GzipFile(fileobj=output, mode='wb', filename='', mtime=0) as zipped:
                    with tarfile.open(fileobj=zipped, mode='w') as result:
                        for name in (prefix, f'{prefix}/public-credit', f'{prefix}/public-credit/{identity}', f'{prefix}/work'):
                            entry = tarfile.TarInfo(name)
                            entry.type = tarfile.DIRTYPE
                            entry.mode = 0o700
                            result.addfile(entry)
                        for original in members:
                            entry = copy.copy(original)
                            entry.pax_headers = {k: v for k, v in original.pax_headers.items() if k not in {'path', 'linkpath'}}
                            entry.name = f'{prefix}/{original.name}'
                            if entry.islnk():
                                entry.linkname = f'{prefix}/{original.linkname}'
                            result.addfile(entry, runtime.extractfile(original) if original.isfile() else None)
                        metadata = {'kind': 'abalone-portable', 'version': 1, 'revision': args.rev,
                                    'runtimeSha256': args.runtime_sha256, 'profile': 'linux-node24-owned-host',
                                    'publicFileSha256': hashes}
                        add_bytes(result, f'{prefix}/portable.json', (json.dumps(metadata, indent=2) + '\n').encode())
                        for name, raw in public.items():
                            add_bytes(result, f'{prefix}/public-credit/{identity}/{name}', raw)
                        instructions = f'''Dsmack optional client — source/release qualification is separate.
Check this archive's SHA256 against trusted release notes before extracting it.
From this folder: ./abalone/bin/abalone (uses work/ as its initial workspace).
Saved access and non-temporary state: {prefix}/state/ (created 0700 on first use).
Set ABALONE_DIR explicitly to use another state directory.
Keep this whole folder together when moving it. State may contain credentials.
Conversation state uses the selected client policy; workspace edits and terminal output can remain.
Coupon sessions require Linux x86_64, Node 24, flock and tmpfs; local tools are not OS-isolated.
readiness.json is an unsigned observation, not a promise of available credit.
No launcher installation is needed. See abalone/docs/portable-client.md.
'''
                        add_bytes(result, f'{prefix}/RUN-ME.txt', instructions.encode())
            except BaseException:
                target.unlink(missing_ok=True)
                raise
    with target.open('rb') as stream:
        sha = digest(stream)
    with checksum.open('x') as output:
        output.write(f'{sha}  {target.name}\n')
    print(f'{target}\nSHA256 {sha}\nPublic bundle {identity}; no runtime program was executed.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-archive', type=Path, required=True)
    parser.add_argument('--runtime-sha256', required=True)
    parser.add_argument('--trial-dir', type=Path, required=True)
    parser.add_argument('--rev', required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    try:
        pack(args)
    except (ValueError, OSError, tarfile.TarError) as error:
        parser.exit(1, f'Portable packaging refused: {error}\n')
