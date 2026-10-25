# SPDX-License-Identifier: MIT
import importlib.util,json,os,pathlib,stat,sys,tempfile,types,unittest
from unittest.mock import patch
P=pathlib.Path(__file__).parent;sys.path.insert(0,str(P.parent/'raspberry-pi/storage'))
s=importlib.util.spec_from_file_location('activate_fixture',P/'activate.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def exercise(self,stop=0,drained=True,sidecar=None):
  events=[]
  class Broker:
   def run_supervisor(self,verb,*args):events.append(verb);return (stop if verb=='stop' else 0,b'',b'',False)
   def show_credit(self,props,*args):return ({'ActiveState':'inactive' if 'ControlGroup' in props else 'active','MainPID':'0' if 'ControlGroup' in props else '23','ControlGroup':''},'')
   def credit_cgroup_empty(self,c):return drained,'fixture'
  with tempfile.TemporaryDirectory() as d:
   base=pathlib.Path(d)/'funding';credit=pathlib.Path(d)/'credit';base.mkdir();credit.mkdir()
   record={'version':1,'provider':'near','model':'z-ai/glm-5.3-flash','apiKey':'synthetic-only'}
   old='old-fixture'
   if sidecar is not None:
    record['account']={'organizationId':'22222222-2222-2222-2222-222222222222','accessToken':'new-token'}
    old=json.dumps(dict(record,account={'organizationId':'11111111-1111-1111-1111-111111111111','accessToken':'old-token'}))
    (credit/'near-account.json').write_text(json.dumps({'organizationId':sidecar,'accessToken':'renewed-token'}))
   (base/'provider-next.json').write_text(json.dumps(record));(credit/'provider.json').write_text(old)
   original=pathlib.Path.lstat
   def lstat(p):
    if p in (base,credit):return types.SimpleNamespace(st_mode=stat.S_IFDIR|0o700,st_uid=972,st_gid=972)
    return original(p)
   def private(p):return p.read_bytes(),(1,2)
   spec=types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda _:None))
   with patch.object(m.os,'fchown'),patch.object(m,'BASE',base),patch.object(m,'CREDIT',credit),patch.object(m.os,'getuid',return_value=0),patch.object(pathlib.Path,'lstat',lstat),patch.object(m,'private',private),patch.object(m.importlib.util,'spec_from_file_location',return_value=spec),patch.object(m.importlib.util,'module_from_spec',return_value=types.SimpleNamespace(Broker=Broker)):
    if stop or not drained or (sidecar is not None and sidecar!='11111111-1111-1111-1111-111111111111'):
     with self.assertRaises(ValueError):m.switch(lambda:None)
     self.assertEqual((credit/'provider.json').read_text(),old);self.assertFalse((base/'activation-intent.json').exists())
    else:
     r=m.switch(lambda:None);self.assertEqual(r['state'],'funded-and-service-started');self.assertEqual((base/'provider-previous.json').read_text(),old);self.assertEqual(json.loads((credit/'provider.json').read_text()),record)
     self.assertFalse((credit/'near-account.json').exists())
  return events
 def test_switch_preserves_old_then_starts(self):self.assertEqual(self.exercise(),['stop','start'])
 def test_account_switch_removes_old_sidecar(self):self.assertEqual(self.exercise(sidecar='11111111-1111-1111-1111-111111111111'),['stop','start'])
 def test_wrong_sidecar_org_refuses_before_intent(self):self.assertEqual(self.exercise(sidecar='33333333-3333-3333-3333-333333333333'),['stop'])
 def test_stop_failure_no_replace(self):self.assertEqual(self.exercise(stop=1),['stop'])
 def test_undrained_no_replace(self):self.assertEqual(self.exercise(drained=False),['stop'])
if __name__=='__main__':unittest.main()
