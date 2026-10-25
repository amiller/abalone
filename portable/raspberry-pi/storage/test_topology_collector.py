"""Offline collector tests: injected trusted reads, plus bounded synthetic processes."""
import copy
import json
import os
import stat
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from test_topology import fixture
from topology import Refusal
from topology_collector import _collect, SystemIO, MANIFEST, MOUNTINFO, table


class FixtureIO:
    def __init__(self):
        self.manifest,self.observed=fixture();self.calls=[];self.errors=set()
        self.parent='/sys/devices/pci0000:00/virtio0/block/vda'
        self.paths={'8:0':self.parent,**{'8:'+str(n):self.parent+'/vda'+str(n) for n in (1,2,3)}}
        self.nodes={'8:'+str(n):'/dev/vda'+(str(n) if n else '') for n in range(4)}
        self.values={self.parent+'/dev':'8:0\n',self.parent+'/size':str(self.manifest['exactDiskSizeBytes']//512)+'\n',
                     self.parent+'/queue/logical_block_size':'512\n'}
        for part in self.observed['sysfs']:
            base=self.paths[part['majorMinor']]
            for name,field in (('dev','majorMinor'),('partition','number'),('start','start512'),('size','length512')):
                self.values[base+'/'+name]=str(part[field])+'\n'
        self.partition_table={'partitiontable':{'label':'dos','id':'0x12345678','device':'/dev/vda',
            'unit':'sectors','sectorsize':512,'partitions':[{'node':'/dev/vda'+str(p['number']),
             'start':p['start512'],'size':p['length512'],'type':'c' if p['number']==1 else '83'} for p in self.manifest['partitions']]}}
        self.ns=(1,2);self.held={};self.inventory='8:0\n8:1 FATUUID\n8:2 ROOTUUID\n8:3 '+self.manifest['expectedLuksUuid']+'\n'
        self.mount_reads=0;self.changed_mount=None;self.changed_values={}
    def uid(self):return 0
    def namespace(self,path):self.calls.append(('ns',path));return self.ns
    def trusted_read(self,path,limit):
        self.calls.append(('manifest',path));assert path==MANIFEST and limit==16384
        return json.dumps(self.manifest).encode()
    def kernel_read(self,path,limit=262144):
        self.calls.append(('read',path))
        if path==MOUNTINFO:
            self.mount_reads+=1
            return self.changed_mount if self.mount_reads>1 and self.changed_mount is not None else self.observed['mountinfo']
        if self.mount_reads>1 and path in self.changed_values:return self.changed_values[path]
        return self.values[path]
    def block_path(self,identity):self.calls.append(('block',identity));return self.nodes[identity]
    def sys_path(self,identity):return self.paths[identity]
    def partition_children(self,parent):assert parent==self.parent;return [self.paths['8:'+str(n)] for n in (1,2,3)]
    def holders(self,path):return self.held.get(path,[])
    def run(self,tool,args):
        self.calls.append(('run',tool,args))
        if tool in self.errors:raise Refusal('synthetic probe failure')
        if tool=='sfdisk':assert args==['--json','/dev/vda'];return json.dumps(self.partition_table)
        if tool=='blkid':assert args==['-p','-o','export','/dev/vda3'];return 'TYPE=crypto_LUKS\nUUID='+self.manifest['expectedLuksUuid']+'\n'
        if tool=='cryptsetup':assert args==['isLuks','--type','luks2','/dev/vda3'];return ''
        if tool=='lsblk':assert args==['--list','--noheadings','--output','MAJ:MIN,UUID'];return self.inventory
        raise AssertionError(tool)


class CollectorTests(unittest.TestCase):
    def test_positive_is_identity_only_and_fixed_manifest(self):
        io=FixtureIO();result=_collect(io)
        self.assertEqual(result['vaultMajorMinor'],'8:3');self.assertFalse(result['authenticatedMedium'])
        self.assertIn(('manifest',MANIFEST),io.calls)
        self.assertEqual(sum(call[:2]==('run','blkid') for call in io.calls),1)

    def test_namespace_refusal_precedes_manifest_read(self):
        io=FixtureIO();io.namespace=lambda path:(1,2) if path.startswith('/proc/self') else (1,3)
        with self.assertRaises(Refusal):_collect(io)
        self.assertFalse(any(call[0]=='manifest' for call in io.calls))

    def test_shadowed_manifest_or_wrong_overlay_refused_before_read(self):
        for mutation in ('shadow','backing'):
            io=FixtureIO()
            if mutation=='shadow':io.observed['mountinfo']+='\n9 1 0:99 / /run/portable-volatile-lower/opt rw - tmpfs tmpfs rw'
            else:io.observed['mountinfo']=io.observed['mountinfo'].replace('lowerdir=/run/portable-volatile-lower','lowerdir=/other')
            with self.assertRaises(Refusal):_collect(io)
            self.assertFalse(any(call[0]=='manifest' for call in io.calls))

    def test_wrong_table_units_sizes_duplicates_unknown_fields(self):
        for field,value in [('label','gpt'),('unit','bytes'),('sectorsize',4096),('sectorsize',True),('device','/dev/vdb'),('extra',True)]:
            io=FixtureIO();io.partition_table['partitiontable'][field]=value
            with self.subTest(field=field),self.assertRaises(Refusal):_collect(io)
            self.assertFalse(any(call[:2]==('run','blkid') for call in io.calls))
        io=FixtureIO();raw=json.dumps(io.partition_table)
        with self.assertRaises(Refusal):table(raw.replace('"unit": "sectors"','"unit": "sectors", "unit": "sectors"'),'/dev/vda')
        with self.assertRaises(Refusal):table(raw.replace('"start": 2048','"start": 2048.0'),'/dev/vda')

    def test_kernel_parent_and_table_disagreement(self):
        for mode in ('table-range','node','kernel-range','parent-size','held-parent','sector-size'):
            io=FixtureIO()
            if mode=='table-range':io.partition_table['partitiontable']['partitions'][2]['start']+=2048
            if mode=='node':io.partition_table['partitiontable']['partitions'][2]['node']='/dev/vdb3'
            if mode=='kernel-range':io.values[io.paths['8:3']+'/start']='2048\n'
            if mode=='parent-size':io.values[io.parent+'/size']='999\n'
            if mode=='held-parent':io.held[io.parent]=['dm-0']
            if mode=='sector-size':io.values[io.parent+'/queue/logical_block_size']='4096\n'
            with self.subTest(mode=mode),self.assertRaises(Refusal):_collect(io)

    def test_every_probe_failure_refuses(self):
        for tool in ('sfdisk','blkid','cryptsetup','lsblk'):
            io=FixtureIO();io.errors.add(tool)
            with self.subTest(tool=tool),self.assertRaises(Refusal):_collect(io)

    def test_inventory_is_only_negative_guard(self):
        for inventory in ('8:19 {uuid}\n','8:3 {uuid}\n8:19 {uuid}\n'):
            io=FixtureIO();io.inventory=inventory.format(uuid=io.manifest['expectedLuksUuid'])
            with self.assertRaises(Refusal):_collect(io)
            self.assertEqual([call[2][-1] for call in io.calls if call[:2]==('run','blkid')],['/dev/vda3'])

    def test_changed_mount_and_geometry_during_observation(self):
        io=FixtureIO();io.changed_mount=io.observed['mountinfo']+'\n'
        with self.assertRaises(Refusal):_collect(io)
        io=FixtureIO();io.changed_values[io.paths['8:3']+'/size']='2048\n'
        with self.assertRaises(Refusal):_collect(io)

    def test_partition_table_order_does_not_select_wrong_device(self):
        io=FixtureIO();io.partition_table['partitiontable']['partitions'].reverse()
        self.assertEqual(_collect(io)['vaultMajorMinor'],'8:3')

    def test_trusted_binary_permissions_and_block_node_policy(self):
        def status(path,leaf_mode=stat.S_IFREG|0o755,uid=0,gid=0):
            return SimpleNamespace(st_uid=uid if str(path)=='/usr/sbin/sfdisk' else 0,
                st_gid=gid,st_mode=leaf_mode if str(path)=='/usr/sbin/sfdisk' else stat.S_IFDIR|0o755)
        for mode,uid in ((stat.S_IFLNK|0o777,0),(stat.S_IFREG|0o775,0),(stat.S_IFREG|0o755,970)):
            with patch('topology_collector.os.lstat',side_effect=lambda path:status(path,mode,uid)):
                with self.assertRaises(Refusal):SystemIO()._trusted('/usr/sbin/sfdisk',stat.S_ISREG)
        with patch('topology_collector.os.lstat',side_effect=status):SystemIO()._trusted('/usr/sbin/sfdisk',stat.S_ISREG)
        # Debian disk group6 owns standard0660 nodes; no arbitrary group/world writer.
        for gid,accepted in ((6,True),(970,False)):
            with patch('topology_collector.os.lstat',side_effect=lambda path:status(path,stat.S_IFBLK|0o660,0,gid)):
                if accepted:SystemIO()._trusted('/usr/sbin/sfdisk',stat.S_ISBLK,block_leaf=True)
                else:
                    with self.assertRaises(Refusal):SystemIO()._trusted('/usr/sbin/sfdisk',stat.S_ISBLK,block_leaf=True)

    def test_actual_subprocess_output_error_and_timeout_are_bounded(self):
        # Trusted test injection only: never accepted as a CLI capability.
        with patch.dict('topology_collector.TOOLS',{'sfdisk':sys.executable}),patch.object(SystemIO,'_trusted',return_value=SimpleNamespace(st_mode=0o755)):
            for program in ("import sys; print('PRIVATE_SYNTHETIC',file=sys.stderr);sys.exit(1)","import sys;sys.stdout.write('x'*1100000)"):
                with self.assertRaises(Refusal) as error:SystemIO().run('sfdisk',['-c',program])
                self.assertNotIn('PRIVATE_SYNTHETIC',str(error.exception))
            started=time.monotonic()
            with self.assertRaisesRegex(Refusal,'timeout'):SystemIO().run('sfdisk',['-c','import time;time.sleep(20)'])
            self.assertLess(time.monotonic()-started,4)


if __name__=='__main__':unittest.main()
