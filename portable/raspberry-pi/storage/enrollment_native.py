# SPDX-License-Identifier: MIT
"""Fixed root native enrollment adapter. No CLI/device selector/automatic start."""
import contextlib,ctypes,fcntl,hashlib,importlib.util,json,os,resource,selectors,signal,stat,struct,subprocess,time
from pathlib import Path
import enrollment as e
from enrollment_blank import admit_blank
from topology import mount_records,unique_mount,visible_ancestors
from topology_collector import SystemIO
from financial_lease import LOCK,CONFIG,bounded

class Native:
 def __init__(self):
  self.fds=[];self.secret_fd=None;self.target=None;self.admission=None;self.open_attempt=False;self.mounted=False
 @contextlib.contextmanager
 def lifecycle(self):
  io=SystemIO();io._trusted('/run',stat.S_ISDIR)
  fd=os.open(LOCK,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,0o600)
  try:
   s=os.fstat(fd);p=os.lstat(LOCK)
   e.require(stat.S_ISREG(s.st_mode) and s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o600 and s.st_nlink==1 and (s.st_dev,s.st_ino)==(p.st_dev,p.st_ino))
   fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
   try:yield
   finally:
    try:
     if self.open_attempt and os.path.exists('/dev/mapper/'+e.MAPPER):
      self.verify_mapper(self.admission)
      if any(x['point']==e.MOUNT for x in self.mounts()):self.unmount_verified(self.admission)
      self.close_verified(self.admission)
    finally:
     for owned in self.fds:os.close(owned)
     self.fds=[]
  finally:os.close(fd)
 def require_local_custody(self):
  e.require(os.getuid()==os.geteuid()==0)
  io=SystemIO();e.require(io.namespace('/proc/self/ns/mnt')==io.namespace('/proc/1/ns/mnt'))
  rows=bounded('/proc/swaps',16384).decode('ascii').splitlines()
  e.require(rows and rows[0].split()==['Filename','Type','Size','Used','Priority'] and all(not x.strip() for x in rows[1:]))
  resource.setrlimit(resource.RLIMIT_CORE,(0,0))
  libc=ctypes.CDLL(None,use_errno=True);e.require(libc.prctl(4,0,0,0,0)==0 and libc.prctl(3,0,0,0,0)==0)
 def admit_blank(self):
  io=SystemIO();io.trusted_read(CONFIG,4096);e.require(stat.S_IMODE(os.lstat(CONFIG).st_mode)==0o600)
  parser=Path(__file__).resolve().parent/'guest/vault-broker.py';raw=io.trusted_read(str(parser),262144)
  ns={'__name__':'enrollment_vault_config','__file__':str(parser)};exec(compile(raw,str(parser),'exec'),ns)
  cfg=ns['parse_config'](CONFIG)
  a=admit_blank()
  e.require(cfg['VAULT_LUKS_UUID']==a['manifest']['expectedLuksUuid'] and cfg['VAULT_MAPPER_NAME']==e.MAPPER and cfg['VAULT_MOUNTPOINT']==e.MOUNT and cfg['VAULT_FSTYPE']=='ext4' and cfg['VAULT_MOUNT_SUBDIR_CREDIT']=='credit')
  e.require(not os.path.lexists('/dev/mapper/'+e.MAPPER));return a
 def admit_format_write_bound(self):
  # Image admission pins the distribution closure. No per-operation new library
  # hash framework. Version is a necessary check, not standalone source proof.
  out=self.command(['/usr/sbin/cryptsetup','--version'],())
  e.require(out.strip().startswith(b'cryptsetup 2.6.1 '))
 def retain_target(self,a):
  fd=os.open(a['vaultPath'],os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
  self.fds.append(fd);self.target=fd;self.admission=a;self.check_fd(a,fd);return fd
 def check_fd(self,a,fd):
  s=os.fstat(fd);e.require(stat.S_ISBLK(s.st_mode) and f'{os.major(s.st_rdev)}:{os.minor(s.st_rdev)}'==a['vaultMajorMinor'])
  e.require(struct.unpack('Q',fcntl.ioctl(fd,0x80081272,bytes(8)))[0]==e.VAULT_BYTES)
 def retain_secret(self,key):
  fd=os.memfd_create('portable-enrollment-passphrase',os.MFD_CLOEXEC|os.MFD_ALLOW_SEALING);self.fds.append(fd);os.fchmod(fd,0o600)
  view=memoryview(key)
  while view:
   n=os.write(fd,view);e.require(n>0);view=view[n:]
  fcntl.fcntl(fd,fcntl.F_ADD_SEALS,fcntl.F_SEAL_WRITE|fcntl.F_SEAL_GROW|fcntl.F_SEAL_SHRINK|fcntl.F_SEAL_SEAL);os.lseek(fd,0,0);self.secret_fd=fd;return fd
 def revalidate(self,a,fd):
  self.check_fd(a,fd);e.require(self.admit_blank()==a)
 def persist_intent(self,fd,a):self.check_fd(a,fd);e.write_tail_intent(fd,a)
 def command(self,argv,fds):
  self.require_local_custody()
  e.require(argv[0] in ('/usr/sbin/cryptsetup','/usr/sbin/mke2fs','/usr/bin/mount','/usr/bin/umount','/usr/bin/udevadm'))
  SystemIO()._trusted(argv[0],stat.S_ISREG)
  if '--key-file' in argv:
   e.require(argv[0]=='/usr/sbin/cryptsetup' and argv.count('--key-file')==1 and self.secret_fd is not None and self.secret_fd in fds)
   e.require(argv[argv.index('--key-file')+1]=='/proc/self/fd/'+str(self.secret_fd))
   os.lseek(self.secret_fd,0,os.SEEK_SET)
  if argv[0].endswith('cryptsetup') and argv[1]=='open' and '--test-passphrase' not in argv:self.open_attempt=True
  p=subprocess.Popen(argv,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=fds,start_new_session=True,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'},cwd='/')
  sel=selectors.DefaultSelector();out=bytearray();total=0;deadline=time.monotonic()+120
  for pipe in (p.stdout,p.stderr):sel.register(pipe,selectors.EVENT_READ)
  try:
   while sel.get_map():
    e.require(time.monotonic()<deadline)
    for key,_ in sel.select(min(.1,max(0,deadline-time.monotonic()))):
     b=os.read(key.fd,4096)
     if not b:sel.unregister(key.fileobj);continue
     total+=len(b);e.require(total<=65536)
     if key.fileobj is p.stdout:out.extend(b)
   while os.waitid(os.P_PID,p.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT) is None:
    e.require(time.monotonic()<deadline);time.sleep(.01)
  finally:
   try:os.killpg(p.pid,signal.SIGKILL)
   except ProcessLookupError:pass
   code=p.wait(timeout=5);sel.close();p.stdout.close();p.stderr.close()
  e.require(code==0);return bytes(out)
 def sync_and_verify_header(self,fd,a,kdf):
  self.check_fd(a,fd);os.fsync(fd)
  e.require(os.pread(fd,e.MARKER_BYTES,e.VAULT_BYTES-e.MARKER_BYTES)==e.marker(a))
  target='/proc/self/fd/'+str(fd)
  self.command(['/usr/sbin/cryptsetup','isLuks','--type','luks2',target],(fd,))
  e.require(self.command(['/usr/sbin/cryptsetup','luksUUID',target],(fd,)).strip().decode('ascii')==a['manifest']['expectedLuksUuid'])
  meta=json.loads(self.command(['/usr/sbin/cryptsetup','luksDump','--dump-json-metadata',target],(fd,)))
  e.require(set(meta['keyslots'])=={'0'} and set(meta['segments'])=={'0'})
  k=meta['keyslots']['0']['kdf'];segment=meta['segments']['0']
  e.require(k['type']=='argon2id' and k['memory']==262144 and k['cpus']==2 and k['time']==4)
  e.require(segment['type']=='crypt' and segment['offset']=='16777216')
 def identity(self,path):
  s=os.stat(path);e.require(stat.S_ISBLK(s.st_mode));return f'{os.major(s.st_rdev)}:{os.minor(s.st_rdev)}'
 def verify_mapper(self,a):
  self.command(['/usr/bin/udevadm','settle','--timeout=10'],())
  p=(Path('/sys/dev/block')/self.identity('/dev/mapper/'+e.MAPPER)).resolve();e.require(str(p).startswith('/sys/devices/'))
  e.require((p/'dm/uuid').read_text().strip()=='CRYPT-LUKS2-'+a['manifest']['expectedLuksUuid'].replace('-','')+'-'+e.MAPPER)
  slaves=list((p/'slaves').iterdir());e.require(len(slaves)==1 and (slaves[0]/'dev').read_text().strip()==a['vaultMajorMinor'])
 def mounts(self):
  records=mount_records(SystemIO().kernel_read('/proc/self/mountinfo'));visible_ancestors(records,(e.MOUNT,));return records
 def assert_mounted(self):
  records=self.mounts();m=unique_mount(records,e.MOUNT,'ext4')
  e.require(m['root']=='/' and m['device']==self.identity('/dev/mapper/'+e.MAPPER) and {'rw','nodev','nosuid','noexec'}<=set(m['options']) and 'rw' in m['super'] and 'ro' not in m['super'])
  e.require(not any(x['point'].startswith(e.MOUNT+'/') for x in records))
 def mount_verified(self,a):
  self.verify_mapper(a);e.require(not any(x['point']==e.MOUNT or x['point'].startswith(e.MOUNT+'/') for x in self.mounts()))
  Path(e.MOUNT).mkdir(mode=0o700,exist_ok=True);SystemIO()._trusted(e.MOUNT,stat.S_ISDIR);e.require(stat.S_IMODE(os.lstat(e.MOUNT).st_mode)==0o700)
  self.command(['/usr/bin/mount','-t','ext4','-o','nosuid,nodev,noexec','/dev/mapper/'+e.MAPPER,e.MOUNT],());self.assert_mounted();self.mounted=True
 def install_record(self,raw):
  self.assert_mounted();root=os.open(e.MOUNT,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  directory=record=None
  try:
   os.mkdir('credit',mode=0o700,dir_fd=root);directory=os.open('credit',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=root);os.fchmod(directory,0o700)
   record=os.open('provider.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=directory);os.fchmod(record,0o600);os.fchown(record,972,972)
   view=memoryview(raw)
   while view:
    n=os.write(record,view);e.require(n>0);view=view[n:]
   os.fsync(record)
   os.fchown(directory,972,972)
   for fd in (directory,root):os.fsync(fd)
  finally:
   for fd in (record,directory,root):
    if fd is not None:os.close(fd)
  self.assert_mounted()
 def verify_record(self,raw):
  self.assert_mounted();directory=os.open(e.MOUNT+'/credit',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);fd=None
  try:
   d=os.fstat(directory);e.require(d.st_uid==d.st_gid==972 and stat.S_IMODE(d.st_mode)==0o700)
   fd=os.open('provider.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory);s=os.fstat(fd)
   e.require(stat.S_ISREG(s.st_mode) and s.st_uid==s.st_gid==972 and stat.S_IMODE(s.st_mode)==0o600 and s.st_nlink==1 and s.st_size==len(raw))
   e.require(os.read(fd,len(raw)+1)==raw)
  finally:
   if fd is not None:os.close(fd)
   os.close(directory)
 def unmount_verified(self,a):
  self.verify_mapper(a);self.assert_mounted();self.command(['/usr/bin/umount',e.MOUNT],());e.require(not any(x['point']==e.MOUNT for x in self.mounts()));self.mounted=False
 def close_verified(self,a):
  self.verify_mapper(a);e.require(not any(x['point']==e.MOUNT for x in self.mounts()));self.command(['/usr/sbin/cryptsetup','close',e.MAPPER],());e.require(not os.path.lexists('/dev/mapper/'+e.MAPPER));self.open_attempt=False
