#!/usr/bin/python3
"""Root-owned embedding API. No CLI, credential reads, format, or mount operations."""
import ctypes
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import select
import signal
import socket
import stat
import subprocess
import sys
import time
import uuid
from topology import mount_records, unique_mount, visible_ancestors, require
from topology_collector import SystemIO

LOCK = '/run/.portable-vault-lifecycle.lock'
CONFIG = '/opt/portable/etc/vault.conf'
MOUNT = '/run/portable-vault'
RECORD = 'provider.json'
NODE = '/opt/portable/bin/node'
ENTRY = '/opt/portable/portable/funding/credit-lease-entry.mjs'


def bounded(path, limit=262144):
    with open(path, 'rb') as f:
        data = f.read(limit+1)
    require(len(data) <= limit, 'read bound')
    return data


def identity(fd):
    s = os.fstat(fd)
    base = (s.st_dev, s.st_ino, s.st_uid, s.st_gid, s.st_mode)
    return base if stat.S_ISDIR(s.st_mode) else base + (s.st_nlink, s.st_size, s.st_mtime_ns, s.st_ctime_ns)


def mount_id(fd):
    lines = bounded('/proc/self/fdinfo/'+str(fd), 4096).decode().splitlines()
    values = [line.split()[1] for line in lines if line.startswith('mnt_id:')]
    require(len(values) == 1 and values[0].isdigit(), 'FD mount identity')
    return int(values[0])


def view(kind='ext4'):
    records = mount_records(bounded('/proc/self/mountinfo').decode())
    visible_ancestors(records, (MOUNT,))
    m = unique_mount(records, MOUNT, kind)
    require({'rw', 'nodev', 'nosuid', 'noexec'} <= set(m['options']) and
            'ro' not in m['options'] and 'rw' in m['super'] and 'ro' not in m['super'], 'mount policy')
    require(not any(r['point'].startswith(MOUNT+'/') for r in records), 'nested mount')
    return m


def lifecycle_lock():
    require(os.getuid() == 0, 'root acquisition required')
    SystemIO()._trusted('/run', stat.S_ISDIR)
    fd = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, 0o600)
    try:
        s = os.fstat(fd); p = os.lstat(LOCK)
        require(stat.S_ISREG(s.st_mode) and s.st_uid == s.st_gid == 0 and
                stat.S_IMODE(s.st_mode) == 0o600 and s.st_nlink == 1 and
                (s.st_dev, s.st_ino) == (p.st_dev, p.st_ino), 'lifecycle lock identity')
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        return fd
    except BaseException:
        os.close(fd)
        raise


def production_admission():
    io = SystemIO()
    require(io.namespace('/proc/self/ns/mnt') == io.namespace('/proc/1/ns/mnt'), 'supervisor must own PID1 mount view')
    raw = io.trusted_read(CONFIG, 4096)
    require(stat.S_IMODE(os.lstat(CONFIG).st_mode) == 0o600, 'config mode')
    parser_path = Path(__file__).resolve().parent/'guest/vault-broker.py'
    io._trusted(str(parser_path), stat.S_ISREG)
    spec = importlib.util.spec_from_file_location('vault_lease_config', parser_path)
    parser = importlib.util.module_from_spec(spec); spec.loader.exec_module(parser)
    cfg = parser.parse_config(CONFIG)
    require(cfg['VAULT_MOUNTPOINT'] == MOUNT and cfg['VAULT_MOUNT_SUBDIR_CREDIT'] == 'credit' and
            cfg['VAULT_MAPPER_NAME'] == 'portable-vault' and cfg['VAULT_LUKS_UUID'], 'fixed vault profile')
    expected_uuid = cfg['VAULT_LUKS_UUID']
    matches = io.run('blkid', ['-t', 'UUID='+expected_uuid, '-o', 'device']).splitlines()
    require(len(matches) == 1, 'duplicate or missing container')
    backing = os.stat(matches[0])
    require(stat.S_ISBLK(backing.st_mode), 'backing block type')
    backing_id = f'{os.major(backing.st_rdev)}:{os.minor(backing.st_rdev)}'
    mapper = os.stat('/dev/mapper/portable-vault')
    require(stat.S_ISBLK(mapper.st_mode), 'mapper block type')
    mapper_id = f'{os.major(mapper.st_rdev)}:{os.minor(mapper.st_rdev)}'
    sys_path = io.sys_path(mapper_id)
    def check():
        require(io.namespace('/proc/self/ns/mnt') == io.namespace('/proc/1/ns/mnt'), 'mount view changed')
        require(io.trusted_read(CONFIG, 4096) == raw, 'config changed')
        m = view()
        require(m['device'] == mapper_id, 'mounted device changed')
        require(io.kernel_read(sys_path+'/dm/uuid', 256).strip() ==
                'CRYPT-LUKS2-'+expected_uuid.replace('-', '')+'-portable-vault', 'mapper UUID changed')
        slaves = list((Path(sys_path)/'slaves').iterdir())
        require(len(slaves) == 1 and bounded(str(slaves[0]/'dev'), 64).decode().strip() == backing_id, 'mapper backing changed')
        current = os.stat('/dev/mapper/portable-vault')
        require(current.st_rdev == mapper.st_rdev and stat.S_ISBLK(current.st_mode), 'mapper path changed')
        return m
    return check, {'configSHA256':hashlib.sha256(raw).hexdigest(), 'luksUUID':expected_uuid,
                   'backingDevice':backing_id, 'mapperDevice':mapper_id}


class HeldLease:
    """Internal constructor receives a trusted verifier; public acquisition has no override."""
    def __init__(self, lock_fd, check_mount, facts):
        self.lock_fd = lock_fd; self.fds = []; self.closed = False
        self.check_mount = check_mount; self.facts = facts
        try:
            self.mount = check_mount()
            self.boot = bounded('/proc/sys/kernel/random/boot_id', 64).decode().strip()
            self.nonce = str(uuid.uuid4())
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
            self.root_fd = os.open(MOUNT, flags | os.O_DIRECTORY); self.fds.append(self.root_fd)
            s = os.fstat(self.root_fd)
            require(s.st_uid == 0 and not s.st_mode & 0o022, 'vault root ownership')
            self.dir_fd = os.open('credit', flags | os.O_DIRECTORY, dir_fd=self.root_fd); self.fds.append(self.dir_fd)
            s = os.fstat(self.dir_fd)
            require(s.st_uid == s.st_gid == 972 and stat.S_IMODE(s.st_mode) == 0o700, 'private credit directory')
            self.record_fd = os.open(RECORD, flags, dir_fd=self.dir_fd); self.fds.append(self.record_fd)
            s = os.fstat(self.record_fd)
            require(stat.S_ISREG(s.st_mode) and s.st_uid == s.st_gid == 972 and
                    stat.S_IMODE(s.st_mode) == 0o600 and s.st_nlink == 1 and 0 < s.st_size <= 16384, 'private readonly record')
            self.identities = [identity(fd) for fd in self.fds]
            require(all(mount_id(fd) == self.mount['id'] for fd in self.fds), 'record outside vault mount')
            self.assert_current()
        except BaseException:
            self.close(); raise

    def assert_current(self):
        require(not self.closed, 'lease closed')
        require(bounded('/proc/sys/kernel/random/boot_id', 64).decode().strip() == self.boot, 'boot changed')
        require(self.check_mount() == self.mount, 'mount generation changed')
        require([identity(fd) for fd in self.fds] == self.identities, 'record/directory changed')
        for name, parent, fd in ((MOUNT, None, self.root_fd), ('credit', self.root_fd, self.dir_fd), (RECORD, self.dir_fd, self.record_fd)):
            s = os.stat(name, dir_fd=parent, follow_symlinks=False); pinned = os.fstat(fd)
            require((s.st_dev, s.st_ino, s.st_mode) == (pinned.st_dev, pinned.st_ino, pinned.st_mode), 'path replaced')
            require(mount_id(fd) == self.mount['id'], 'mount FD changed')
        p = os.lstat(LOCK); s = os.fstat(self.lock_fd)
        require((p.st_dev,p.st_ino,p.st_uid,p.st_gid,stat.S_IMODE(p.st_mode),p.st_nlink) ==
                (s.st_dev,s.st_ino,0,0,0o600,1), 'lock replaced')
        return True

    def metadata(self):
        return {'version':1, 'nonce':self.nonce, 'bootId':self.boot, 'mountId':self.mount['id'],
                'device':self.mount['device'], 'recordDev':os.fstat(self.record_fd).st_dev,
                'recordIno':os.fstat(self.record_fd).st_ino}

    def close(self):
        if self.closed:return
        self.closed = True
        for fd in reversed(self.fds):os.close(fd)
        os.close(self.lock_fd)


def acquire():
    """Only production admission. Never discovers or reads credential contents."""
    lock = lifecycle_lock()
    try:check, facts = production_admission()
    except BaseException:os.close(lock);raise
    return HeldLease(lock, check, facts)


def supervise(lease, *, deadline_seconds=300):
    """Fixed deployed consumer; until that entry is deployed this refuses startup."""
    require(type(deadline_seconds) is int and 1 <= deadline_seconds <= 3600, 'supervisor deadline')
    return _supervise_trusted(lease, deadline_seconds)


def supervise_until_lock(lease):
    """Trusted installed profile only: revoke on lock, caller death or identity change.

    No consumer request can extend custody. The keeper retains its lifecycle
    lock until child drain; the caller unit must retain bounded stop handling.
    """
    return _supervise_trusted(lease, None)


def _supervise_trusted(lease, deadline_seconds):
    io = SystemIO()
    try:
        for p in (NODE, ENTRY):io._trusted(p, stat.S_ISREG)
        return _keep(lease, [NODE, ENTRY], deadline_seconds)
    except BaseException:
        lease.close();raise


def _keep(lease, argv, deadline_seconds):
    """Retain the unit main PID until keeper drain, including ordinary SIGTERM.

    The root-only pipe requests shutdown; it grants no consumer authority. Caller
    SIGKILL still reaches the existing pidfd path. Keeper SIGKILL is not orderly.
    """
    stop_r, stop_w = os.pipe2(os.O_CLOEXEC | os.O_NONBLOCK)
    signals = {signal.SIGTERM, signal.SIGINT}
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, signals)
    previous_handlers = {sig: signal.getsignal(sig) for sig in signals}
    parent_fd = None
    try:
        parent_fd = os.pidfd_open(os.getpid())
        pid = os.fork()
    except BaseException:
        if parent_fd is not None: os.close(parent_fd)
        os.close(stop_r); os.close(stop_w)
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        raise
    if pid == 0:
        os.close(stop_w)
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        code = 1
        try:
            require(ctypes.CDLL(None,use_errno=True).prctl(36,1,0,0,0) == 0, 'subreaper')
            code = 0 if _supervise(lease, argv, deadline_seconds, parent_fd, stop_r) else 1
        except BaseException:
            code = 1
        finally:
            os.close(parent_fd); os.close(stop_r)
        os._exit(code)
    os.close(stop_r); os.close(parent_fd)
    requested = False
    def request_stop(signum, frame):
        nonlocal requested
        if not requested:
            requested = True
            try: os.write(stop_w, b'S')
            except OSError: pass
    try:
        for sig in signals: signal.signal(sig, request_stop)
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        lease.close()
        _, status = os.waitpid(pid, 0)
        return os.waitstatus_to_exitcode(status) == 0
    finally:
        signal.pthread_sigmask(signal.SIG_BLOCK, signals)
        os.close(stop_w)
        for sig, handler in previous_handlers.items(): signal.signal(sig, handler)
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)


def _process_start(pid):
    try:
        text=bounded('/proc/'+str(pid)+'/stat',4096).decode('ascii')
        value=text[text.rfind(')')+2:].split()[19]
        return value if value.isdigit() else None
    except BaseException:return None


def _supervise(lease, argv, deadline_seconds, owner_pidfd, stop_fd=None):
    """Trusted internal test seam; never reachable through CLI or consumer request."""
    parent, child_socket = socket.socketpair(); child = None; keeper_pid = os.getpid(); released = False; leader_code = None
    phase='initial-admission'; failure=None; child_start=None
    def drop():
        # Only these capability descriptors cross privilege drop. SO_PEERCRED on
        # this socketpair denotes its root creator, NOT per-message consumer UID.
        control = os.dup(child_socket.fileno()); record = os.dup(lease.record_fd)
        os.dup2(control, 3); os.dup2(record, 4)
        for fd in {control,record,child_socket.fileno(),lease.record_fd} - {3,4}: os.close(fd)
        libc = ctypes.CDLL(None,use_errno=True)
        require(libc.prctl(8,0,0,0,0) == 0, 'disable keepcaps')
        require(libc.prctl(47,4,0,0,0) == 0, 'clear ambient capabilities')
        os.setgroups([]); os.setgid(972); os.setuid(972)
        class Header(ctypes.Structure):_fields_=[('version',ctypes.c_uint32),('pid',ctypes.c_int)]
        class Data(ctypes.Structure):_fields_=[('effective',ctypes.c_uint32),('permitted',ctypes.c_uint32),('inheritable',ctypes.c_uint32)]
        header=Header(0x20080522,0); data=(Data*2)()
        require(libc.capset(ctypes.byref(header),ctypes.byref(data)) == 0, 'clear capabilities')
        capabilities=dict(line.split(':',1) for line in bounded('/proc/self/status',16384).decode().splitlines() if ':' in line)
        require(all(capabilities[name].strip() == '0000000000000000' for name in ('CapPrm','CapEff','CapInh','CapAmb')), 'residual capabilities')
        require(libc.prctl(38,1,0,0,0) == 0, 'no_new_privs')
        require(libc.prctl(1,signal.SIGKILL,0,0,0) == 0, 'parent death signal')
        require(os.getppid() == keeper_pid, 'keeper already exited')
        os.umask(0o077)
    try:
        lease.assert_current()
        child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'}, cwd='/', start_new_session=True,
            pass_fds=(child_socket.fileno(),lease.record_fd,3,4), preexec_fn=drop)
        child_start=_process_start(child.pid)
        child_socket.close();parent.settimeout(.2)
        parent.sendall((json.dumps(lease.metadata())+'\n').encode())
        end = None if deadline_seconds is None else time.monotonic()+deadline_seconds; buffer=b''; released=False; last_rid=0; stop_at=None
        while end is None or time.monotonic()<end:
            if os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT):failure='child-exited';break
            if select.select([owner_pidfd],[],[],0)[0]:failure='owner-lost';break
            if stop_fd is not None and stop_at is None and select.select([stop_fd],[],[],0)[0]:
                require(os.read(stop_fd, 16) == b'S', 'fixed stop notification')
                stop_at = time.monotonic()+10
                try: os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError: pass
            if stop_at is not None and time.monotonic() >= stop_at:failure='stop-grace-expired';break
            # Keep assertion/release ACKs alive while the consumer closes its
            # sockets and drains work. The original bounded admission deadline
            # above still applies; ordinary stop never extends it.
            phase='admission';lease.assert_current()
            phase='control';
            try:chunk=parent.recv(1024)
            except socket.timeout:continue
            if not chunk:failure='control-eof';break
            buffer+=chunk;require(len(buffer)<=1024,'control frame bound')
            if b'\n' not in buffer:continue
            require(buffer.count(b'\n')==1 and buffer.endswith(b'\n'),'one control frame')
            request=json.loads(buffer);buffer=b''
            require(type(request) is dict and set(request)=={'op','rid','nonce'} and request['nonce']==lease.nonce and
                    type(request['rid']) is int and request['rid']==last_rid+1 and request['op'] in ('assert','release'), 'control request')
            last_rid=request['rid'];phase='admission';lease.assert_current()
            # recv/assert_current can cross an admission boundary. Never grant a
            # late assertion; a release frame still permits orderly drain.
            if request['op']=='assert':
                now=time.monotonic()
                if (end is not None and now>=end) or (stop_at is not None and now>=stop_at):failure='admission-expired';break
            parent.sendall((json.dumps({'rid':last_rid,'ok':True})+'\n').encode())
            if request['op']=='release':released=True;break
        if failure is None and not released:failure='admission-expired'
        # Keep leader unreaped until escalation: its PID anchors this process group.
        if released:
            grace=time.monotonic()+.5
            while time.monotonic()<grace and not os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT):time.sleep(.01)
    except BaseException:
        failure='admission-invalid' if phase in ('initial-admission','admission') else 'control-invalid'
        raise
    finally:
        child_socket.close();parent.close()
        if child is not None:
            try:os.killpg(child.pid,signal.SIGTERM)
            except ProcessLookupError:pass
            time.sleep(.1)
            try:os.killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            # As subreaper, wait for the leader AND adopted descendants. A
            # non-reapable/detached descendant holds the keeper/lock indefinitely
            # rather than reporting success/unlocking early. Unit-level cgroup
            # cleanup remains required for deliberate setsid escape.
            leader_code = child.wait()
            while True:
                try: os.waitpid(-1, 0)
                except ChildProcessError: break
        if not released or leader_code != 0:
            # Fixed enums/numeric identity only; never emit exception text or frames.
            try:
                event={'version':1,'bootId':lease.boot,'keeperPID':os.getpid(),'keeperStartTicks':_process_start(os.getpid()),'consumerPID':child.pid if child else None,'consumerStartTicks':child_start,'phase':phase,'reason':failure or 'child-exited','exitCode':leader_code}
                print('portableLeaseFailure '+json.dumps(event,separators=(',',':')),file=sys.stderr,flush=True)
            except BaseException:pass
        lease.close()

    return released and leader_code == 0
