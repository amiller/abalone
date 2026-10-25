# SPDX-License-Identifier: MIT
import contextlib,importlib.util,io,json,os,signal,subprocess,sys,tempfile,time,unittest
from unittest.mock import patch
from pathlib import Path
s=importlib.util.spec_from_file_location('funding_operator',Path(__file__).with_name('operator.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def child(self,code):return subprocess.Popen([sys.executable,'-u','-c',code],stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
 def test_command_binding(self):
  m.validate('fresh',None);m.validate('send-reviewed','a'*64);m.validate('fund',None);m.validate('fund','5');m.validate('fund','10')
  for c,h in [('fund','0'),('fund','11'),('fund','05'),('fund','5.5'),('new-demo','5'),('send-reviewed',None),('fresh','a'*64),('arbitrary',None),('send-reviewed','x'*64)]:
   with self.assertRaises(ValueError):m.validate(c,h)
 def test_actual_child_json_and_reap(self):
  p=self.child('print(\'{"state":"known"}\')');calls=[]
  self.assertEqual(m.collect(p,lambda:calls.append(True),2),{'state':'known'});self.assertEqual(p.returncode,0);self.assertTrue(calls)
 def test_deadline_drains_before_return(self):
  p=self.child('import time;time.sleep(30)')
  with self.assertRaises(ValueError):m.collect(p,lambda:None,.02)
  self.assertIsNotNone(p.returncode)
  with self.assertRaises(ChildProcessError):os.waitpid(p.pid,os.WNOHANG)
 def test_admission_loss_drains(self):
  p=self.child('import time;time.sleep(30)')
  def refuse():raise ValueError('lost')
  with self.assertRaises(ValueError):m.collect(p,refuse,2)
  self.assertIsNotNone(p.returncode)
 def test_bad_output_no_raw_error(self):
  p=self.child('print("synthetic-secret-canary")')
  with self.assertRaises(ValueError):m.collect(p,lambda:None,2)
  self.assertIsNotNone(p.returncode)
 def main_lines(self,code):
  m.SHOWN.clear();out=io.StringIO()
  with patch.object(m,'run',lambda *a:m.collect(self.child(code),lambda:None,2,m.say)),patch.object(sys,'argv',['operator.py','fund']),contextlib.redirect_stdout(out):rc=m.main()
  return rc,[json.loads(line) for line in out.getvalue().splitlines()]
 def test_child_failure_reported_once(self):
  rc,lines=self.main_lines('import sys;print(\'{"state":"unknown","reason":"step"}\');sys.exit(1)')
  self.assertEqual((rc,lines),(1,[{'state':'unknown','reason':'step'}]))
 def test_final_result_shown_once(self):
  self.assertEqual(self.main_lines('print(\'{"phase":"standing"}\');print(\'{"state":"known"}\')'),(0,[{'phase':'standing'},{'state':'known'}]))
 def test_silent_failure_gets_generic_report(self):
  self.assertEqual(self.main_lines('import sys;sys.exit(1)'),(1,[{'state':'unknown','reason':'operator-refused-or-interrupted','retryPerformed':False}]))
HOLDER="""import importlib.util,os,pathlib,subprocess,sys
s=importlib.util.spec_from_file_location('op',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
os.setgroups=os.setgid=os.setuid=lambda *a:None
marker=pathlib.Path(sys.argv[2])
def run(*a):
 child=subprocess.Popen([sys.executable,'-c','import json,time;print(json.dumps({"phase":"deposit"}),flush=True);time.sleep(60)'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,preexec_fn=m.child_identity,start_new_session=True)
 marker.write_text(str(child.pid));return m.collect(child,lambda:None,60,m.say)
m.run=run;sys.argv=['operator.py','fund'];sys.exit(m.main())
"""
class Interrupted(unittest.TestCase):
 """~/fund over SSH: a dropped terminal must not leave the funding child holding the attempt."""
 def interrupt(self,signum):
  with tempfile.TemporaryDirectory() as d:
   marker=Path(d)/'child';p=subprocess.Popen([sys.executable,'-c',HOLDER,str(Path(__file__).with_name('operator.py')),str(marker)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
   try:
    end=time.monotonic()+5
    while not marker.exists() or not marker.read_text():self.assertLess(time.monotonic(),end);time.sleep(.01)
    child=int(marker.read_text());self.assertEqual(os.getpgid(child),child);time.sleep(.3)
    p.send_signal(signum);p.communicate(timeout=10)
    end=time.monotonic()+5
    while Path('/proc/%d'%child).exists() and Path('/proc/%d/stat'%child).read_text().split(')')[1].split()[0]!='Z':self.assertLess(time.monotonic(),end,'funding child outlived ~/fund');time.sleep(.05)
   finally:
    if p.poll() is None:p.kill();p.wait()
 def test_hangup_ends_child(self):self.interrupt(signal.SIGHUP)
 def test_ctrl_c_ends_child(self):self.interrupt(signal.SIGINT)
 def test_killed_operator_ends_child(self):self.interrupt(signal.SIGKILL)
if __name__=='__main__':unittest.main()
