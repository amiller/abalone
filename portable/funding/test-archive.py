# SPDX-License-Identifier: MIT
import json,os,pathlib,sys,tempfile,unittest
P=pathlib.Path(__file__).parent/'near_fund';sys.path.insert(0,str(P));import archive,context
class Tests(unittest.TestCase):
 def test_closed_only_preserves_transit_and_active_provider(self):
  with tempfile.TemporaryDirectory() as d:
   base=pathlib.Path(d);base.chmod(0o700)
   for n in archive.NAMES:
    if n in ('account','attempts'):(base/n).mkdir(mode=0o700)
    else:context.save(base/n,{'state':'funded-and-service-started'} if n=='activation-complete.json' else {'synthetic':True})
   context.save(base/'transit-private.json',{'synthetic':'transit'})
   context.save(base/'account/session.json',{'synthetic':'current-B'})
   (base/'prior-account').mkdir(mode=0o700);context.save(base/'prior-account/session.json',{'synthetic':'prior-A'})
   current_inode=(base/'account').stat().st_ino;prior_inode=(base/'prior-account').stat().st_ino
   anchor=os.open(base/'account',os.O_RDONLY|os.O_DIRECTORY)
   try:
    before=(base/'transit-private.json').read_bytes();r=archive.closed_cycle(base)
    fd=os.open('session.json',os.O_RDONLY|os.O_NOFOLLOW,dir_fd=anchor)
    try:self.assertEqual(json.loads(os.read(fd,4096)),{'synthetic':'current-B'})
    finally:os.close(fd)
   finally:os.close(anchor)
   self.assertTrue(r['archivedCompletedCycle']);self.assertEqual((base/'transit-private.json').read_bytes(),before)
   histories=list((base/'history').iterdir());self.assertEqual(len(histories),1);self.assertEqual((histories[0]/'prior-account').stat().st_ino,prior_inode);self.assertFalse((histories[0]/'account').exists());self.assertEqual((base/'prior-account').stat().st_ino,current_inode);self.assertFalse((base/'account').exists());self.assertTrue((base/'attempts').is_dir())
 def test_unknown_never_archived(self):
  with tempfile.TemporaryDirectory() as d:
   base=pathlib.Path(d);base.chmod(0o700);context.save(base/'activation-complete.json',{'state':'unknown'})
   with self.assertRaises(ValueError):archive.closed_cycle(base)
   self.assertFalse((base/'history').exists())
 def test_partial_reset_never_replayed(self):
  with tempfile.TemporaryDirectory() as d:
   base=pathlib.Path(d);base.chmod(0o700);context.save(base/'new-demo-intent.json',{'state':'unknown'})
   with self.assertRaises(ValueError):archive.closed_cycle(base)
if __name__=='__main__':unittest.main()
