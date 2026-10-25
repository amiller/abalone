# SPDX-License-Identifier: MIT
"""Fixed same-medium blank partition admission; distinct from locked LUKS policy."""
import fcntl,hashlib,json,os,stat,struct,time
from pathlib import Path
from topology_collector import SystemIO,MANIFEST,MOUNTINFO,number,table,strict_json
from topology import *
import re

class BlankIO(SystemIO):
    def scan_zero(self,path,identity,size):
        require(size==2*1024*1024*1024,'only declared2GiB enrollment vault supported')
        self._trusted(path,stat.S_ISBLK,block_leaf=True)
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
        try:
            st=os.fstat(fd)
            require(stat.S_ISBLK(st.st_mode) and f'{os.major(st.st_rdev)}:{os.minor(st.st_rdev)}'==identity,'zero scan identity')
            require(struct.unpack('Q',fcntl.ioctl(fd,0x80081272,bytes(8)))[0]==size,'zero scan device size')
            left=size;deadline=time.monotonic()+180;zero=bytes(1024*1024)
            while left:
                require(time.monotonic()<deadline,'zero scan deadline')
                data=os.read(fd,min(left,len(zero)));require(bool(data) and data==zero[:len(data)],'vault not fully zero')
                left-=len(data)
            require(struct.unpack('Q',fcntl.ioctl(fd,0x80081272,bytes(8)))[0]==size,'zero scan device changed')
            return size
        finally:os.close(fd)

def _admit_blank(io):
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
    require(not any(r['device'] in (vault,parent_dev) for r in records),'vault or raw parent mounted')
    listing=strict_json(io.run('lsblk',['--list','--json','--output','MAJ:MIN,UUID,PARTUUID']))
    keys(listing,'blockdevices','inventory')
    require(type(listing['blockdevices']) is list and len(listing['blockdevices'])<=256,'inventory bounds')
    found={p['partuuid']:[] for p in manifest['partitions']}
    for row in listing['blockdevices']:
        keys(row,'maj:min uuid partuuid','inventory row');identity=dev(row['maj:min'])
        require(row['uuid'] is None or type(row['uuid']) is str and len(row['uuid'])<=128,'UUID field')
        require(row['partuuid'] is None or type(row['partuuid']) is str and len(row['partuuid'])<=128,'PARTUUID field')
        require(row['uuid']!=manifest['expectedLuksUuid'],'existing expected LUKS UUID anywhere')
        if row['partuuid'] in found:found[row['partuuid']].append(identity)
    for part in parts:require(found[part['partuuid']]==[part['majorMinor']],'missing or duplicate global PARTUUID')
    size=manifest['partitions'][2]['length512']*512
    require(io.scan_zero(vault_path,vault,size)==size,'incomplete zero scan')
    require(io.kernel_read(MOUNTINFO)==mountinfo,'mount topology changed during scan')
    require(table(io.run('sfdisk',['--json',parent_path]),parent_path)==(disk_id,entries),'partition table changed during scan')
    require(strict_json(io.run('lsblk',['--list','--json','--output','MAJ:MIN,UUID,PARTUUID']))==listing,'global inventory changed during scan')
    require(io.namespace('/proc/self/ns/mnt')==namespace==io.namespace('/proc/1/ns/mnt'),'namespace changed')
    require(io.sys_path(parent_dev)==parent_sys and io.block_path(parent_dev)==parent_path,'parent changed')
    require(number(io.kernel_read(parent_sys+'/size',32),'parent recheck')==sectors,'parent size changed')
    require(not io.holders(parent_sys) and not io.holders(vault_sys),'new device holder')
    for identity,(path,entry) in by_dev.items():
        require(io.sys_path(identity)==path and io.block_path(identity) in path_to_dev,'device changed')
        for filename,field in (('partition','number'),('start','start512'),('size','length512')):
            require(number(io.kernel_read(path+'/'+filename,32),'kernel recheck')==entry[field],'geometry changed')
    return {'manifest':manifest,'manifestSha256':hashlib.sha256(io.trusted_read(MANIFEST,16384)).hexdigest(),
            'vaultPath':vault_path,'vaultMajorMinor':vault,'parentMajorMinor':parent_dev,'blankBytes':size,'authenticatedMedium':False}

def admit_blank():
    try:return _admit_blank(BlankIO())
    except (OSError,UnicodeError) as e:raise Refusal('blank observation failed') from e
