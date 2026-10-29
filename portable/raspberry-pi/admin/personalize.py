#!/usr/bin/env python3
"""Offline, root-owned Dsmack demo LAN administration personalization.

No block-device selection. The caller must admit and mount the intended root.
Private Wi-Fi inputs and generated host keys must never enter release archives.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import subprocess

WIFI_UNIT = '''[Unit]
Description=Dsmack saved Wi-Fi association
Requires=tor-guest-firewall.service
After=tor-guest-firewall.service
Before=network-online.target
[Service]
Type=simple
ExecStartPre=/usr/sbin/rfkill unblock wifi
ExecStart=/usr/sbin/wpa_supplicant -i wlan0 -D nl80211 -c /etc/wpa_supplicant/wpa_supplicant-wlan0.conf
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
'''
SSH_UNIT = '''[Unit]
Description=Dsmack trusted LAN administrator SSH
Requires=tor-guest-firewall.service
After=tor-guest-firewall.service
[Service]
Type=simple
RuntimeDirectory=sshd
RuntimeDirectoryMode=0755
ExecStartPre=/usr/sbin/sshd -t -f /etc/ssh/portable-admin.conf
ExecStart=/usr/sbin/sshd -D -e -f /etc/ssh/portable-admin.conf
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
'''
SSHD = '''Port 22
AddressFamily inet
ListenAddress 0.0.0.0
HostKey /etc/ssh/portable-admin-host-ed25519-key
AuthorizedKeysFile /etc/ssh/portable-admin-authorized_keys
AllowUsers root
PermitRootLogin prohibit-password
AuthenticationMethods publickey
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM yes
PermitEmptyPasswords no
AllowTcpForwarding no
AllowStreamLocalForwarding no
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
PermitUserEnvironment no
PermitUserRC no
GatewayPorts no
MaxAuthTries 3
LoginGraceTime 20
MaxStartups 3:30:6
LogLevel ERROR
'''
NETWORK = '''[Match]
Name=wlan0
[Network]
DHCP=ipv4
IPv6AcceptRA=no
LinkLocalAddressing=no
LLDP=no
LLMNR=no
MulticastDNS=no
'''


def private_input(path):
    p = Path(path)
    parent = p.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid() or parent.st_mode & 0o077:
        raise ValueError("private input parent refused")
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid != os.geteuid() or s.st_mode & 0o077 or not 0 < s.st_size <= 16384:
            raise ValueError('private input metadata refused')
        raw = os.read(fd, 16385)
        if len(raw) != s.st_size:
            raise ValueError('private input length refused')
        return raw
    finally:
        os.close(fd)


def unique_object(pairs):
    out = {}
    for k, v in pairs:
        if k in out:
            raise ValueError('duplicate field')
        out[k] = v
    return out


def wifi_config(raw):
    value = json.loads(raw.decode('utf-8'), object_pairs_hook=unique_object)
    if set(value) != {'version', 'keyManagement', 'country', 'ssid', 'psk'} or type(value['version']) is not int or value['version'] != 1 or value['keyManagement'] != 'wpa-psk':
        raise ValueError('Wi-Fi schema refused')
    ssid, password, country = value['ssid'], value['psk'], value['country']
    if not isinstance(country, str) or not re.fullmatch('[A-Z]{2}', country):
        raise ValueError('Wi-Fi country refused')
    if not isinstance(ssid, str) or not 1 <= len(ssid.encode('utf-8')) <= 32 or not isinstance(password, str):
        raise ValueError('Wi-Fi fields refused')
    if re.fullmatch('[0-9a-fA-F]{64}', password):
        key = password.lower()
    elif 8 <= len(password) <= 63 and all(32 <= ord(c) < 127 for c in password):
        key = hashlib.pbkdf2_hmac('sha1', password.encode('ascii'), ssid.encode('utf-8'), 4096, 32).hex()
    else:
        raise ValueError('Wi-Fi password refused')
    return f'country={country}\nnetwork={{\n    ssid={ssid.encode("utf-8").hex()}\n    psk={key}\n}}\n'


def public_keys(raw):
    result = []
    for line in raw.decode('utf-8').splitlines():
        if not line.strip():
            continue
        fields = line.split()
        if len(fields) < 2 or fields[0] != 'ssh-ed25519':
            raise ValueError('public key type refused')
        try:
            blob = base64.b64decode(fields[1], validate=True)
        except Exception:
            raise ValueError('public key encoding refused') from None
        if blob != struct.pack('>I', 11) + b'ssh-ed25519' + struct.pack('>I', 32) + blob[-32:] or len(blob) != 51:
            raise ValueError('public key framing refused')
        canonical = 'ssh-ed25519 ' + base64.b64encode(blob).decode('ascii')
        if canonical not in result:
            result.append(canonical)
    if not 1 <= len(result) <= 16:
        raise ValueError('public key count refused')
    return '\n'.join(result) + '\n'


def trusted(path, directory=False):
    s = path.lstat()
    if s.st_uid != 0 or s.st_mode & 0o022 or (not stat.S_ISDIR(s.st_mode) if directory else not stat.S_ISREG(s.st_mode)):
        raise ValueError('trusted target metadata refused')
    return s


def destination(root, relative):
    parts = relative.split('/')
    p = root
    for part in parts[:-1]:
        p /= part
        if not p.exists():
            p.mkdir(mode=0o755)
            p.chmod(0o755)
        trusted(p, True)
    return root / relative


def write(root, name, data, mode):
    p = destination(root, name)
    if p.is_symlink():
        raise ValueError('symlink target refused')
    if p.exists():
        trusted(p)
    temporary = p.with_name(p.name + '.personalization-new')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb', closefd=False) as f:
            f.write(data.encode())
            f.flush()
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temporary, p)
    d = os.open(p.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(d)
    finally:
        os.close(d)


def configuration(wifi, keys, nft):
    """Pure fixed-target mapping; inputs must already pass schema/policy checks."""
    return {
        'etc/wpa_supplicant/wpa_supplicant-wlan0.conf': (wifi, 0o600),
        'etc/systemd/network/11-portable-wlan0.network': (NETWORK, 0o644),
        'etc/systemd/system/portable-demo-wifi.service': (WIFI_UNIT, 0o644),
        'etc/systemd/system/portable-admin-ssh.service': (SSH_UNIT, 0o644),
        'etc/ssh/portable-admin.conf': (SSHD, 0o600),
        'etc/ssh/portable-admin-authorized_keys': (keys, 0o600),
        'etc/tor-guest/tor-guest.nft': (nft, 0o644),
        'etc/tor-guest/tor-guest.nft.sha256': (hashlib.sha256(nft.encode('utf-8')).hexdigest() + '  tor-guest.nft\n', 0o644),
    }


def apply(root, wifi, keys, policy, policy_sha256, apply_changes=False):
    if os.geteuid() != 0 or root == Path('/') or not root.is_absolute():
        raise ValueError('offline root required')
    for ancestor in reversed((root, *root.parents)):
        trusted(ancestor, True)
    for relative in ('etc', 'etc/tor-guest', 'etc/systemd', 'etc/systemd/system', 'etc/ssh'):
        trusted(root / relative, True)
    # The fixed renderer is part of the public source closure. Rule inputs contain
    # no secrets. Require exactly the existing UID identity; do not guess from host.
    uids = root / 'etc/tor-guest/uids'
    trusted(uids)
    text = uids.read_text()
    tor = re.search(r'^tor_uid=(\d+)$', text, re.M)
    dhcp = re.search(r'^dhcp_uid=(\d+)$', text, re.M)
    if not tor or not dhcp or len(re.findall(r'^tor_uid=', text, re.M)) != 1 or len(re.findall(r'^dhcp_uid=', text, re.M)) != 1:
        raise ValueError('network UID identity refused')
    trusted(policy)
    rendered = policy.read_bytes()
    if len(rendered) > 32768 or hashlib.sha256(rendered).hexdigest() != policy_sha256:
        raise ValueError('policy hash or length refused')
    nft = rendered.decode('utf-8')
    if f'meta skuid {tor[1]} return' not in nft or f'meta skuid {dhcp[1]} meta nfproto ipv4 udp sport 68 udp dport 67 accept' not in nft or 'meta skuid 0 ct direction reply tcp sport 22 ip daddr' not in nft:
        raise ValueError('policy identity refused')
    writes = configuration(wifi, keys, nft)
    # Refuse unexpected preexisting personalization; a partial apply must be
    # diagnosed, never silently re-run with a different host key or Wi-Fi input.
    for name in writes:
        candidate = root / name
        temporary = candidate.with_name(candidate.name + '.personalization-new')
        if temporary.exists() or temporary.is_symlink():
            raise ValueError('existing temporary target refused')
        for ancestor in reversed(candidate.parent.parents):
            if ancestor == root or root in ancestor.parents:
                if ancestor.exists() or ancestor.is_symlink():
                    trusted(ancestor, True)
        if candidate.parent.exists() or candidate.parent.is_symlink():
            trusted(candidate.parent, True)
        if name not in ('etc/tor-guest/tor-guest.nft', 'etc/tor-guest/tor-guest.nft.sha256') and (candidate.exists() or candidate.is_symlink()):
            raise ValueError('existing personalization refused')
    nm = root / 'etc/systemd/system/NetworkManager.service'
    if not nm.is_symlink() or os.readlink(nm) != '/dev/null':
        raise ValueError('NetworkManager mask required')
    for service in ('portable-demo-wifi.service', 'portable-admin-ssh.service'):
        link = root / 'etc/systemd/system/multi-user.target.wants' / service
        if link.exists() or link.is_symlink():
            raise ValueError('existing enablement refused')
    host = root / 'etc/ssh/portable-admin-host-ed25519-key'
    if host.exists() or host.is_symlink() or Path(str(host) + '.pub').exists() or Path(str(host) + '.pub').is_symlink():
        raise ValueError('existing administrator host key refused')
    if not apply_changes:
        return
    # Generate once in the private mounted root, never copy shared image host keys.
    host = destination(root, 'etc/ssh/portable-admin-host-ed25519-key')
    if host.exists() or host.is_symlink() or Path(str(host) + '.pub').exists():
        raise ValueError('existing administrator host key refused')
    keygen = Path('/usr/bin/ssh-keygen')
    trusted(keygen)
    subprocess.run([str(keygen), '-q', '-t', 'ed25519', '-N', '', '-f', str(host)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
    os.chmod(host, 0o600)
    for name, (data, mode) in writes.items():
        write(root, name, data, mode)
    for service in ('portable-demo-wifi.service', 'portable-admin-ssh.service'):
        link = destination(root, 'etc/systemd/system/multi-user.target.wants/' + service)
        if link.exists() or link.is_symlink():
            raise ValueError('existing enablement refused')
        link.symlink_to('../' + service)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--wifi-file', required=True)
    parser.add_argument('--authorized-keys', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--policy-file', type=Path, required=True)
    parser.add_argument('--policy-sha256', required=True)
    args = parser.parse_args()
    wifi = wifi_config(private_input(args.wifi_file))
    keys = public_keys(private_input(args.authorized_keys))
    apply(args.root, wifi, keys, args.policy_file, args.policy_sha256, args.apply)
    print(json.dumps({'checked': True, 'applied': args.apply, 'administrator': 'root', 'keyAuthenticationOnly': True}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Dsmack LAN personalization refused') from None
