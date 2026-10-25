#!/usr/bin/python3
"""Standalone read-only root collector; no CLI overrides or lifecycle wiring."""
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import sys
import time
from topology import (BOOT, LOWER, UPPER, Refusal, dev, integer, keys,
                      mount_records, options, parse_manifest, require,
                      unique_mount, validate_observations, visible_ancestors)

MANIFEST = LOWER+'/opt/portable/etc/vault-topology.json'
MOUNTINFO = '/proc/self/mountinfo'
TOOLS = {'sfdisk':'/usr/sbin/sfdisk','blkid':'/usr/sbin/blkid',
         'cryptsetup':'/usr/sbin/cryptsetup','lsblk':'/usr/bin/lsblk'}


class SystemIO:
    """Actual fixed system reads. Only offline tests inject a different object."""
    def uid(self): return os.getuid()
    def namespace(self, path):
        value=os.stat(path)
        return value.st_dev,value.st_ino
    def _trusted(self, path, leaf_mode, block_leaf=False):
        require(path.startswith('/') and '..' not in Path(path).parts, 'untrusted path')
        current=Path('/')
        root=os.lstat('/')
        require(root.st_uid==0 and stat.S_ISDIR(root.st_mode) and not root.st_mode & 0o022, 'untrusted root directory')
        for index, part in enumerate(Path(path).parts[1:]):
            current=current/part
            value=os.lstat(current)
            final=index==len(Path(path).parts)-2
            mask=0o002 if final and block_leaf else 0o022
            require(value.st_uid==0 and not value.st_mode & mask, 'untrusted path ownership/mode')
            if final and block_leaf and value.st_mode & 0o020:
                require(value.st_gid in (0,6), 'untrusted block writer group')
            require((leaf_mode(value.st_mode) if final else stat.S_ISDIR(value.st_mode)), 'untrusted path type/symlink')
        return value
    def trusted_read(self,path,limit):
        before=self._trusted(path,stat.S_ISREG)
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
        try:
            after=os.fstat(fd)
            require((before.st_dev,before.st_ino)==(after.st_dev,after.st_ino), 'trusted file changed')
            require(stat.S_ISREG(after.st_mode) and after.st_size<=limit, 'trusted file size/type')
            data=os.read(fd,limit+1)
            require(len(data)<=limit,'trusted file overflow')
            return data
        finally: os.close(fd)
    def kernel_read(self,path,limit=262144):
        require(path==MOUNTINFO or path.startswith('/sys/devices/'), 'unexpected kernel read')
        with open(path,'rb') as source:data=source.read(limit+1)
        require(len(data)<=limit,'kernel read overflow')
        return data.decode('ascii')
    def block_path(self,identity):
        dev(identity)
        path=os.path.realpath('/dev/block/'+identity)
        require(path.startswith('/dev/') and '/mapper/' not in path, 'unexpected block path')
        value=self._trusted(path,stat.S_ISBLK,block_leaf=True)
        require(f'{os.major(value.st_rdev)}:{os.minor(value.st_rdev)}'==identity,'block dev_t mismatch')
        return path
    def sys_path(self,identity):
        dev(identity)
        path=os.path.realpath('/sys/dev/block/'+identity)
        require(path.startswith('/sys/devices/') and path!=('/sys/dev/block/'+identity),'unresolved sysfs device')
        require(os.path.isdir(path),'missing sysfs device')
        return path
    def partition_children(self,parent):
        result=[]
        for name in os.listdir(parent):
            path=parent+'/'+name
            try:value=os.lstat(path+'/partition')
            except (FileNotFoundError,NotADirectoryError):continue
            require(stat.S_ISREG(value.st_mode),'invalid partition attribute')
            result.append(path)
        require(len(result)<=4,'unsupported partition count')
        return result
    def holders(self,path): return os.listdir(path+'/holders')
    def run(self,tool,args):
        binary=TOOLS[tool]
        value=self._trusted(binary,stat.S_ISREG)
        require(value.st_mode & 0o111,'probe binary not executable')
        process=subprocess.Popen([binary,*args],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,cwd='/',env={'PATH':'/usr/sbin:/usr/bin','LC_ALL':'C'},close_fds=True)
        selector=selectors.DefaultSelector();output=bytearray();errors=bytearray()
        selector.register(process.stdout,selectors.EVENT_READ,output)
        selector.register(process.stderr,selectors.EVENT_READ,errors)
        deadline=time.monotonic()+3
        try:
            while selector.get_map():
                require(time.monotonic()<deadline,'probe timeout')
                for key,_ in selector.select(.05):
                    chunk=os.read(key.fileobj.fileno(),4096)
                    if not chunk:selector.unregister(key.fileobj);continue
                    key.data.extend(chunk)
                    require(len(key.data)<=(1048576 if key.data is output else 4096),'probe output overflow')
            remaining=deadline-time.monotonic()
            require(remaining>0,'probe timeout')
            code=process.wait(timeout=remaining)
            require(code==0,'probe failed: '+tool)
            return bytes(output).decode('utf-8')
        finally:
            if process.poll() is None:process.kill()
            try:process.wait(timeout=.5)
            except subprocess.TimeoutExpired:raise Refusal('probe cleanup incomplete')
            finally:
                selector.close();process.stdout.close();process.stderr.close()


def number(raw,label,high=2**63-1):
    require(type(raw) is str and re.fullmatch(r'[0-9]{1,19}\n?',raw) is not None,label+' syntax')
    value=int(raw);integer(value,0,high,label);return value


def strict_json(raw):
    require(type(raw) is str and len(raw.encode())<=1048576,'table output bounds')
    def pairs(items):
        result={}
        for key,value in items:
            require(key not in result,'duplicate table JSON key');result[key]=value
        return result
    def invalid(_):raise Refusal('noninteger table number')
    try:return json.loads(raw,object_pairs_hook=pairs,parse_float=invalid,parse_constant=invalid)
    except (ValueError,RecursionError) as error:raise Refusal('invalid partition table JSON') from error


def table(raw,parent_path):
    data=strict_json(raw);keys(data,'partitiontable','sfdisk root');value=data['partitiontable']
    keys(value,'label id device unit sectorsize partitions','sfdisk table')
    require(value['label']=='dos','unsupported partition table (DOS/MBR required)')
    require(value['unit']=='sectors','unsupported sfdisk units')
    integer(value['sectorsize'],512,512,'sfdisk logical sector')
    require(value['device']==parent_path,'sfdisk parent target mismatch')
    require(type(value['id']) is str and re.fullmatch(r'0x[0-9a-fA-F]{8}',value['id']),'sfdisk disk ID')
    require(type(value['partitions']) is list and len(value['partitions'])==3,'sfdisk partition count')
    result=[]
    for entry in value['partitions']:
        require(type(entry) is dict,'sfdisk partition object')
        require(set(entry) in ({'node','start','size','type'},{'node','start','size','type','bootable'}),'sfdisk partition fields')
        if 'bootable' in entry:require(type(entry['bootable']) is bool,'sfdisk bootable type')
        require(type(entry['node']) is str and len(entry['node'])<=128,'sfdisk partition node')
        integer(entry['start'],1,2**32-1,'sfdisk start');integer(entry['size'],1,2**32-1,'sfdisk size')
        require(type(entry['type']) is str and re.fullmatch(r'[0-9a-fA-F]{1,2}',entry['type']),'sfdisk type')
        # Units explicitly proven equal to kernel 512-byte units; no guess/conversion.
        result.append({'node':entry['node'],'start512':entry['start'],'length512':entry['size'],
                       'type':entry['type'].lower().zfill(2)})
    return value['id'][2:].lower(),result


def _collect(io):
    """Trusted in-process test seam. NEVER expose io/observations over IPC/CLI."""
    require(io.uid()==0,'root collector required')
    namespace=io.namespace('/proc/self/ns/mnt')
    require(namespace==io.namespace('/proc/1/ns/mnt'),'collector not in PID1 mount namespace')
    mountinfo=io.kernel_read(MOUNTINFO)
    records=mount_records(mountinfo);visible_ancestors(records,(LOWER,UPPER,BOOT))
    require(not any(record['point'].startswith(LOWER+'/') for record in records),'immutable manifest path covered')
    lower=unique_mount(records,LOWER,'ext4');options(lower,True)
    require('ro' in lower['super'] and 'rw' not in lower['super'] and
            ('noload' in lower['super'] or 'norecovery' in lower['super']),'untrusted lower write policy')
    overlay=unique_mount(records,'/','overlay');options(overlay,False)
    upper=unique_mount(records,UPPER,'tmpfs');options(upper,False)
    for expected in ('lowerdir='+LOWER,'upperdir='+UPPER+'/upper','workdir='+UPPER+'/work'):
        key=expected.split('=',1)[0]+'='
        require([opt for opt in overlay['super'] if opt.startswith(key)]==[expected], 'manifest lower not active overlay backing')
    manifest=parse_manifest(io.trusted_read(MANIFEST,16384))
    root_sys=io.sys_path(lower['device']);parent_sys=str(Path(root_sys).parent)
    require(parent_sys.startswith('/sys/devices/'),'invalid sysfs parent')
    require(re.fullmatch(r'(?:sd[a-z]+|vd[a-z]+|mmcblk[0-9]+|nvme[0-9]+n[0-9]+)',Path(parent_sys).name),'unsupported parent class')
    parent_dev=dev(io.kernel_read(parent_sys+'/dev',32).strip())
    require(io.sys_path(parent_dev)==parent_sys,'parent sysfs/dev_t mismatch')
    parent_path=io.block_path(parent_dev)
    sectors=number(io.kernel_read(parent_sys+'/size',32),'parent size')
    sector_size=number(io.kernel_read(parent_sys+'/queue/logical_block_size',32),'logical sector')
    require(sector_size==512,'unsupported kernel sector size')
    require(not io.holders(parent_sys),'held parent unsupported')
    children=io.partition_children(parent_sys);require(root_sys in children,'lower is not a parent partition')
    require(len(children)==3,'kernel partition count')
    sysfs=[];path_to_dev={};by_dev={}
    for child in children:
        require(str(Path(child).parent)==parent_sys,'non-sibling sysfs partition')
        identity=dev(io.kernel_read(child+'/dev',32).strip())
        require(io.sys_path(identity)==child,'partition sysfs/dev_t mismatch')
        entry={'majorMinor':identity,'parentMajorMinor':parent_dev,
            'number':number(io.kernel_read(child+'/partition',32),'partition number',4),
            'start512':number(io.kernel_read(child+'/start',32),'partition start',2**32-1),
            'length512':number(io.kernel_read(child+'/size',32),'partition size',2**32-1)}
        path=io.block_path(identity)
        require(identity not in by_dev and path not in path_to_dev,'duplicate kernel partition identity')
        path_to_dev[path]=identity;by_dev[identity]=(child,entry);sysfs.append(entry)
    disk_id,entries=table(io.run('sfdisk',['--json',parent_path]),parent_path)
    parts=[]
    for entry in entries:
        require(entry['node'] in path_to_dev,'sfdisk partition not a kernel sibling')
        identity=path_to_dev[entry['node']];kernel=by_dev[identity][1]
        require(kernel['start512']==entry['start512'] and kernel['length512']==entry['length512'],
                'kernel/table geometry disagreement before probe')
        parts.append({'number':kernel['number'],'type':entry['type'],'start512':entry['start512'],
            'length512':entry['length512'],'partuuid':disk_id+'-%02d'%kernel['number'],'majorMinor':identity})
    vaults=[entry for entry in sysfs if entry['number']==3];require(len(vaults)==1,'missing/duplicate vault partition')
    vault=vaults[0]['majorMinor'];vault_sys=by_dev[vault][0];vault_path=io.block_path(vault)
    boot=unique_mount(records,BOOT,'vfat');options(boot,True)
    require('ro' in boot['super'] and 'rw' not in boot['super'],'boot filesystem write policy')
    for role,identity in ((1,boot['device']),(2,lower['device'])):
        matching=[entry for entry in sysfs if entry['number']==role]
        require(len(matching)==1 and matching[0]['majorMinor']==identity, 'mounted role identity mismatch')
    require(not io.holders(vault_sys),'vault already held')
    # Full structural policy is checked below; probe only the declared sibling,
    # never an arbitrary global UUID match. Refuse wrong geometry before probing.
    for expected in manifest['partitions']:
        found=[entry for entry in parts if entry['number']==expected['number']]
        require(len(found)==1,'missing/duplicate partition role')
        for field in ('type','start512','length512','partuuid'):
            require(found[0][field]==expected[field],'declared partition mismatch before probe')
    require(disk_id==manifest['diskId'] and sectors*512==manifest['exactDiskSizeBytes'],'parent mismatch before probe')
    raw_probe=io.run('blkid',['-p','-o','export',vault_path]);probe={}
    for line in raw_probe.splitlines():
        require('=' in line,'invalid blkid output');key,value=line.split('=',1)
        require(key not in probe,'duplicate blkid field');probe[key]=value
    require(probe.get('TYPE')=='crypto_LUKS' and probe.get('UUID')==manifest['expectedLuksUuid'],'direct LUKS probe mismatch')
    io.run('cryptsetup',['isLuks','--type','luks2',vault_path])
    inventory=io.run('lsblk',['--list','--noheadings','--output','MAJ:MIN,UUID'])
    matches=[]
    for line in inventory.splitlines():
        fields=line.split();require(1<=len(fields)<=2,'invalid UUID inventory')
        dev(fields[0])
        if len(fields)==2 and fields[1]==manifest['expectedLuksUuid']:matches.append(fields[0])
    observed={'mountinfo':mountinfo,'parent':{'majorMinor':parent_dev,'type':'disk','tableType':'dos',
        'diskId':disk_id,'logicalSectorBytes':sector_size,'sizeBytes':sectors*512},
        'partitions':parts,'sysfs':sysfs,'vaultProbe':{'majorMinor':vault,'type':probe['TYPE'],
        'uuid':probe['UUID'],'luksVersion':2,'holders':io.holders(vault_sys)},
        'uuidMatches':matches,'probeErrors':[]}
    result=validate_observations(manifest,observed)
    # Reject observed mount/namespace churn. This is not an atomic hotplug lock.
    require(io.kernel_read(MOUNTINFO)==mountinfo,'mount topology changed during collection')
    require(io.namespace('/proc/self/ns/mnt')==namespace==io.namespace('/proc/1/ns/mnt'),'mount namespace changed')
    require(io.sys_path(parent_dev)==parent_sys and io.block_path(parent_dev)==parent_path,'parent changed')
    require(number(io.kernel_read(parent_sys+'/size',32),'parent recheck')==sectors and
            number(io.kernel_read(parent_sys+'/queue/logical_block_size',32),'sector recheck')==sector_size,
            'parent geometry changed')
    require(not io.holders(vault_sys),'vault acquired holder during collection')
    for identity,(path,entry) in by_dev.items():
        require(io.sys_path(identity)==path and io.block_path(identity) in path_to_dev,'device changed')
        for filename,field in (('partition','number'),('start','start512'),('size','length512')):
            require(number(io.kernel_read(path+'/'+filename,32),'recheck')==entry[field],'kernel geometry changed')
    return result


def collect():
    """Production entry: no caller-selected roots, paths, profiles or devices."""
    try:return _collect(SystemIO())
    except (OSError,UnicodeError,subprocess.SubprocessError) as error:
        raise Refusal('system observation failed') from error


if __name__=='__main__':
    if len(sys.argv)!=1:raise SystemExit('collector accepts no arguments')
    try:print(json.dumps(collect(),sort_keys=True))
    except Refusal as error:raise SystemExit('topology refused: '+str(error))
