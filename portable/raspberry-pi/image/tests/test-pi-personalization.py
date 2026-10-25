"""Pure offline temporary-tree tests; never mount, format, boot or run services."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('personalizer', Path(__file__).resolve().parents[1]/'stage-pi-personalization.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class Personalization(unittest.TestCase):
    def setUp(self):
        self.mask = os.umask(0o022)
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)/'root'; self.root.mkdir()
        self.inputs = {m.CMD: b'console=tty1 root=PARTUUID=12345678-02 rootfstype=ext4 rootwait quiet\n',
                       m.FSTAB: b'proc /proc proc defaults 0 0\nPARTUUID=12345678-01 /boot/firmware vfat defaults 0 2\nPARTUUID=12345678-02 / ext4 defaults,noatime 0 1\n'}
        for name, body in self.inputs.items():
            p = self.root/name; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(body)
        self.profile = {'version':1, 'inputSha256':{k:m.sha(v) for k,v in self.inputs.items()}, 'oldDiskId':'12345678', 'provenance':{'fixture':True}}
        self.profile_raw = m.encode(self.profile)
        self.layout = {'schemaVersion':1,'personalizationId':'11111111-1111-4111-8111-111111111111','imageProfileId':'test','tableType':'dos','diskId':'abcdef01','logicalSectorBytes':512,'exactDiskSizeBytes':10485760,
          'partitions':[{'role':r,'number':i,'type':'0c' if i==1 else '83','start512':i*2048,'length512':2048,'partuuid':f'abcdef01-{i:02d}'} for i,r in enumerate(('boot','root','vault'),1)],'expectedLuksUuid':'22222222-2222-4222-8222-222222222222'}
        self.raw=m.encode(self.layout)
    def tearDown(self): self.tmp.cleanup();os.umask(self.mask)
    def build(self): return m.build(self.root,self.profile,self.profile_raw,self.raw)
    def test_dryplan_no_mutation_single_identity(self):
        plan,inputs,outputs=self.build()
        self.assertEqual((self.root/m.CMD).read_bytes(),inputs[m.CMD])
        self.assertIn(b'root=PARTUUID=abcdef01-02',outputs[m.CMD]); self.assertIn(b'efi=noruntime pstore.backend=none',outputs[m.CMD])
        self.assertEqual(outputs[m.MANIFEST],self.raw);self.assertIn(b'abcdef01-01',outputs[m.FSTAB]);self.assertIn(b'ro,noload',outputs[m.FSTAB])
        self.assertFalse((self.root/m.BACKUP).exists())
    def test_unknown_bytes_refused(self):
        (self.root/m.FSTAB).write_bytes(self.inputs[m.FSTAB]+b'# new\n')
        with self.assertRaises(ValueError):self.build()
    def test_unreviewed_mount_and_duplicate_root_refused_even_if_pinned(self):
        for bad in [self.inputs[m.FSTAB]+b'/dev/sda /data ext4 defaults 0 0\n',self.inputs[m.FSTAB]+b'PARTUUID=12345678-02 / ext4 defaults 0 1\n']:
            with self.assertRaises(ValueError):m.render({**self.inputs,m.FSTAB:bad},self.profile,self.raw)
    def test_conflicting_boot_and_layout_refused(self):
        for token in ('efi=runtime','pstore.backend=ramoops','init=/bin/sh','root=PARTUUID=12345678-02'):
            with self.assertRaises(ValueError):m.render({**self.inputs,m.CMD:self.inputs[m.CMD].rstrip()+b' '+token.encode()+b'\n'},self.profile,self.raw)
        self.layout['partitions'][1]['start512']=2048
        with self.assertRaises(ValueError):m.render(self.inputs,self.profile,m.encode(self.layout))
    def test_symlink_hardlink_and_existing_manifest_refused(self):
        p=self.root/m.FSTAB;p.unlink();p.symlink_to('/etc/fstab')
        with self.assertRaises(ValueError):self.build()
        p.unlink();p.write_bytes(self.inputs[m.FSTAB]);os.link(p,self.root/'alias')
        with self.assertRaises(ValueError):self.build()
        (self.root/'alias').unlink();target=self.root/m.MANIFEST;target.parent.mkdir(parents=True);target.write_text('{}')
        with self.assertRaises(ValueError):self.build()
    @unittest.skipUnless(os.getuid()==0,'mapped root apply exercised separately')
    def test_apply_077_exact_modes_backup_no_replay(self):
        plan,inputs,outputs=self.build();os.umask(0o077);m.apply(self.root,plan,inputs,outputs,self.profile_raw)
        for name,body in outputs.items():
            p=self.root/name;self.assertEqual(p.read_bytes(),body);self.assertEqual(p.stat().st_mode&0o777,0o644)
        self.assertEqual((self.root/'opt/portable/etc').stat().st_mode&0o777,0o755)
        self.assertTrue((self.root/m.BACKUP/'completed.json').exists())
        with self.assertRaises(ValueError):self.build()
    @unittest.skipUnless(os.getuid()==0,'mapped root fault exercised separately')
    def test_interruption_intent_blocks_replay(self):
        plan,inputs,outputs=self.build()
        with patch.object(m.os,'replace',side_effect=OSError('fault')):
            with self.assertRaises(OSError):m.apply(self.root,plan,inputs,outputs,self.profile_raw)
        self.assertTrue((self.root/m.BACKUP/'intent.json').exists());self.assertFalse((self.root/m.BACKUP/'completed.json').exists())
        with self.assertRaises(ValueError):self.build()

if __name__=='__main__':unittest.main()
