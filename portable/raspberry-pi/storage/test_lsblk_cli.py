"""Read-only actual CLI regression; inventory contents never printed."""
import unittest,subprocess
from test_topology_collector import FixtureIO
from topology_collector import _collect
class Cli(unittest.TestCase):
 def test_actual_collector_argv_and_old_conflict(self):
  io=FixtureIO();_collect(io)
  args=[c[2] for c in io.calls if c[:2]==('run','lsblk')]
  self.assertEqual(len(args),1)
  result=subprocess.run(['/usr/bin/lsblk',*args[0]],capture_output=True,timeout=5,env={'LC_ALL':'C','PATH':'/usr/bin:/usr/sbin'})
  self.assertEqual(result.returncode,0,result.stderr.decode())
  self.assertTrue(result.stdout)
  for line in result.stdout.decode().splitlines():
   fields=line.split();self.assertIn(len(fields),(1,2));self.assertRegex(fields[0],r'^\d+:\d+$')
  bad=subprocess.run(['/usr/bin/lsblk','--raw',*args[0]],capture_output=True,timeout=5,env={'LC_ALL':'C','PATH':'/usr/bin:/usr/sbin'})
  self.assertNotEqual(bad.returncode,0);self.assertIn(b'mutually exclusive',bad.stderr)
if __name__=='__main__':unittest.main()
