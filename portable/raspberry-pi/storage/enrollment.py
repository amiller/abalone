# SPDX-License-Identifier: MIT
"""First local-enrollment transaction slice; no CLI or installed entry point.

The root supervisor supplies the trusted native adapter described in
ENROLLMENT.md. This module cannot select a device from user input. A native
adapter/format-write-bound qualification is required before deployment.
"""
import hashlib
import json
import os
import re
import stat

VAULT_BYTES = 2 * 1024 * 1024 * 1024
MARKER_BYTES = 4096
MAPPER = 'portable-vault'
MOUNT = '/run/portable-vault'
# Candidate human-passphrase policy, deliberately not the synthetic PBKDF2/1000.
# Native Pi timing/resource qualification is still required.
KDF = ('--pbkdf', 'argon2id', '--pbkdf-memory', '262144',
       '--pbkdf-parallel', '2', '--pbkdf-force-iterations', '4')

class Refused(Exception):
    """Fixed public failure; never attach credential/command output."""

class Partial(Refused):
    def __init__(self, phase):
        self.phase = phase
        super().__init__('Enrollment incomplete; inspect state before any further action')

def require(condition):
    if not condition:
        raise Refused('Enrollment refused')

def credentials(passphrase, confirmation, api_key, provider='zai', account=None):
    """Trusted tty collector supplies exact bytearrays after noecho entry.
    No normalization/stripping; reference dropping is not secure zeroization.
    """
    require(type(passphrase) is bytearray and type(confirmation) is bytearray)
    require(8 <= len(passphrase) <= 512 and b'\0' not in passphrase)
    require(passphrase == confirmation)
    require(type(api_key) is bytearray and
            re.fullmatch(rb'[A-Za-z0-9._-]{1,512}', api_key) is not None)
    require(provider in ('zai', 'near'))
    record = {'version': 1, 'provider': provider, 'model': 'glm-5.3' if provider == 'zai' else 'z-ai/glm-5.3-flash',
              'apiKey': api_key.decode('ascii')}
    if account is not None:
        require(provider == 'near' and type(account) is dict and set(account) == {'organizationId', 'accessToken'})
        require(type(account['organizationId']) is str and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', account['organizationId']) is not None)
        require(type(account['accessToken']) is str and re.fullmatch(r'[A-Za-z0-9._~-]{1,8192}', account['accessToken']) is not None)
        record['account'] = dict(account)
    return json.dumps(record, separators=(',', ':')).encode()

def marker(admission):
    """Public interruption marker, not a credential or authorization token."""
    require(admission['blankBytes'] == VAULT_BYTES)
    require(re.fullmatch('[0-9a-f]{64}', admission['manifestSha256']) is not None)
    uuid = admission['manifest']['expectedLuksUuid']
    require(re.fullmatch('[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', uuid) is not None)
    body = json.dumps({'version': 1, 'state': 'enrollment-attempted',
                       'manifestSha256': admission['manifestSha256'],
                       'expectedLuksUuid': uuid}, sort_keys=True).encode()
    raw = b'PORTABLE-ENROLLMENT-V1\n' + body + b'\nsha256=' + hashlib.sha256(body).hexdigest().encode() + b'\n'
    require(len(raw) < MARKER_BYTES)
    return raw.ljust(MARKER_BYTES, b'\0')

def write_tail_intent(fd, admission):
    """Retained exact partition FD; called under lifecycle lock AFTER full scan.
    Native adapter must revalidate size/geometry/identity before this call and
    qualify format's bounded writes so this tail survives until header fsync.
    """
    s = os.fstat(fd)
    require(stat.S_ISBLK(s.st_mode))
    require(f'{os.major(s.st_rdev)}:{os.minor(s.st_rdev)}' == admission['vaultMajorMinor'])
    raw = marker(admission)
    offset = VAULT_BYTES - MARKER_BYTES
    require(os.pread(fd, MARKER_BYTES, offset) == bytes(MARKER_BYTES))
    view = memoryview(raw)
    while view:
        n = os.pwrite(fd, view, offset)
        require(n > 0)
        offset += n
        view = view[n:]
    os.fsync(fd)
    require(os.pread(fd, MARKER_BYTES, VAULT_BYTES - MARKER_BYTES) == raw)
    # No clear/reset operation exists, even on format failure.

def enroll(io, passphrase, confirmation, api_key, *, provider='zai', account=None):
    """Single root-supervised transaction. No automatic retry/resume/erase.

    io is trusted construction authority, NOT a caller-selected wire object.
    Its lifecycle context owns retained target/key FDs and cleanup. It must
    refuse any prior marker/signature via a whole-partition zero scan.
    """
    record = credentials(passphrase, confirmation, api_key, provider, account)
    phase = 'preflight'
    try:
        with io.lifecycle():
            io.require_local_custody()  # root, same mount view, no swap/dumps
            admission = io.admit_blank()  # existing immutable topology + full zero scan
            require(admission['blankBytes'] == VAULT_BYTES)
            marker(admission)  # validate public binding before any write
            io.admit_format_write_bound()  # exact executable/closure proof, no fallback
            target_fd = io.retain_target(admission)
            key_fd = io.retain_secret(passphrase)
            require(type(target_fd) is int and type(key_fd) is int and target_fd >= 3 and key_fd >= 3 and target_fd != key_fd)
            io.revalidate(admission, target_fd)
            phase = 'intent'
            io.persist_intent(target_fd, admission)  # write+fsync+readback or refuse
            phase = 'format'
            target, key = f'/proc/self/fd/{target_fd}', f'/proc/self/fd/{key_fd}'
            io.command(['/usr/sbin/cryptsetup', 'luksFormat', '--batch-mode',
                        '--type', 'luks2', '--uuid', admission['manifest']['expectedLuksUuid'],
                        '--offset', '32768', '--luks2-metadata-size', '16384',
                        '--luks2-keyslots-size', '16744448', *KDF, '--key-file', key, target], (target_fd, key_fd))
            phase = 'header'
            io.sync_and_verify_header(target_fd, admission, KDF)
            # Must positively establish durable correct LUKS2 header/KDF/UUID
            # before mkfs may discard/overwrite the encrypted tail marker.
            phase = 'test-passphrase'
            io.command(['/usr/sbin/cryptsetup', 'open', '--test-passphrase', '--type', 'luks2',
                        '--key-file', key, target], (target_fd, key_fd))
            phase = 'open'
            io.command(['/usr/sbin/cryptsetup', 'open', '--type', 'luks2',
                        '--key-file', key, target, MAPPER], (target_fd, key_fd))
            io.verify_mapper(admission)
            phase = 'filesystem'
            io.command(['/usr/sbin/mke2fs', '-t', 'ext4', '-F', '-q', '-m', '0',
                        '/dev/mapper/' + MAPPER], ())
            io.mount_verified(admission)
            phase = 'record'
            io.install_record(record)  # fixed credit/provider.json UID9720700/0600, fsync
            io.verify_record(record)
            phase = 'close'
            io.unmount_verified(admission)  # ordinary only, never lazy/force
            io.close_verified(admission)
            phase = 'complete'
            return {'state': 'enrolled-locked', 'provider': provider,
                    'expectedLuksUuid': admission['manifest']['expectedLuksUuid']}
    except Refused:
        if phase == 'preflight':
            raise
        raise Partial(phase) from None
    except Exception:
        raise Partial(phase) from None
    finally:
        record = None
