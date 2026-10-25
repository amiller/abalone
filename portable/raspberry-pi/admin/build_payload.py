#!/usr/bin/env python3
"""Build private personalization files for a separately admitted offline image.

The result contains Wi-Fi credentials and a host private key. Keep it private;
never include it in release archives. This tool does not open an OS/device image.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
from personalize import configuration, private_input, public_keys, trusted, wifi_config


def build(output, wifi_file, keys_file, policy_file, policy_sha256):
    parent = output.parent.lstat()
    if not output.is_absolute() or not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid() or parent.st_mode & 0o077:
        raise ValueError('private output parent required')
    if output.exists() or output.is_symlink():
        raise ValueError('fresh output required')
    wifi = wifi_config(private_input(wifi_file))
    keys = public_keys(private_input(keys_file))
    # Public generated policy is separately source-bound by the image controller.
    fd = os.open(policy_file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid not in (0, os.geteuid()) or metadata.st_mode & 0o022 or not 1 <= metadata.st_size <= 32768:
            raise ValueError('policy metadata refused')
        raw = os.read(fd, 32769)
    finally:
        os.close(fd)
    if len(raw) != metadata.st_size or hashlib.sha256(raw).hexdigest() != policy_sha256:
        raise ValueError('policy identity refused')
    nft = raw.decode('utf-8')
    if 'meta skuid 105 return' not in nft or 'meta skuid 998 meta nfproto ipv4 udp sport 68 udp dport 67 accept' not in nft or 'meta skuid 0 ct direction reply tcp sport 22 ip daddr' not in nft:
        raise ValueError('native network UID policy refused')
    keygen = Path('/usr/bin/ssh-keygen')
    trusted(keygen)
    output.mkdir(mode=0o700)
    output.chmod(0o700)
    files = {}
    for index, (target, (content, mode)) in enumerate(configuration(wifi, keys, nft).items()):
        source = f'file-{index:02d}'
        fd = os.open(output / source, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            os.fchmod(fd, 0o600)
            data = content.encode('utf-8')
            with os.fdopen(fd, 'wb', closefd=False) as stream:
                stream.write(data)
                stream.flush()
            os.fsync(fd)
        finally:
            os.close(fd)
        files['/' + target] = dict(source=source, sha256=hashlib.sha256(data).hexdigest(), mode=mode, uid=0, gid=0)
    host = output / 'host-ed25519'
    subprocess.run([str(keygen), '-q', '-t', 'ed25519', '-N', '', '-f', str(host)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
    for source, target, mode in (
        ('host-ed25519', '/etc/ssh/portable-admin-host-ed25519-key', 0o600),
        ('host-ed25519.pub', '/etc/ssh/portable-admin-host-ed25519-key.pub', 0o644),
    ):
        path = output / source
        path.chmod(0o600)
        with path.open('rb') as stream:
            os.fsync(stream.fileno())
            digest = hashlib.sha256(stream.read()).hexdigest()
        files[target] = dict(source=source, sha256=digest, mode=mode, uid=0, gid=0)
    manifest = dict(version=1, privatePersonalization=True, files=files,
        directories={'/etc/wpa_supplicant': dict(mode=0o755, uid=0, gid=0)},
        symlinks={'/etc/systemd/system/multi-user.target.wants/' + name: '../' + name for name in ('portable-demo-wifi.service', 'portable-admin-ssh.service')})
    data = (json.dumps(manifest, indent=2) + '\n').encode()
    fd = os.open(output / 'manifest.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(data)
            stream.flush()
        os.fsync(fd)
    finally:
        os.close(fd)
    d = os.open(output, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(d)
    finally:
        os.close(d)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--payload-dir', type=Path, required=True)
    parser.add_argument('--wifi-file', required=True)
    parser.add_argument('--authorized-keys', required=True)
    parser.add_argument('--policy-file', type=Path, required=True)
    parser.add_argument('--policy-sha256', required=True)
    args = parser.parse_args()
    manifest = build(args.payload_dir, args.wifi_file, args.authorized_keys, args.policy_file, args.policy_sha256)
    print(json.dumps({'privatePayloadReady': True, 'fileCount': len(manifest['files']), 'imageOpened': False}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Dsmack private personalization build refused') from None
