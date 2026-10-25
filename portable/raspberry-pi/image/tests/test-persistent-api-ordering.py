#!/usr/bin/env python3
"""Offline graph regression on exported actual systemd252 units; no service starts.
Usage: --fixtures /reviewed/exported/systemd-units. Never invent target-unit data.
"""
import argparse,hashlib,importlib.util,pathlib,tempfile,unittest,json,sys
P=pathlib.Path;IMAGE=P(__file__).resolve().parents[1]
ap=argparse.ArgumentParser();ap.add_argument('--fixtures',type=P,required=True);args,rest=ap.parse_known_args()
spec=importlib.util.spec_from_file_location('stage',IMAGE/'stage-persistent-api.py');stage=importlib.util.module_from_spec(spec);spec.loader.exec_module(stage)
GATE='portable-persistent-api.service'
FIXTURES=['systemd-networkd.service','systemd-networkd.socket','network-pre.target','sysinit.target','systemd-user-sessions.service','getty@.service']

def unit(texts):
 result={};section=''
 for text in texts:
  for raw in text.splitlines():
   line=raw.strip()
   if not line or line.startswith(('#',';')):continue
   if line.startswith('['):section=line;continue
   if section!='[Unit]' or '=' not in line:continue
   key,value=line.split('=',1)
   if key in ('Requires','After','Before','Wants'):result.setdefault(key,set()).update(value.split())
   elif key=='DefaultDependencies':result[key]=value
 return result

def admitted(units,name):
 # systemd's Requires start-failure exclusion needs ordering as well: Before
 # or Wants alone do not establish this condition. This is a bounded graph
 # contract check, not an emulated systemd manager or runtime failure proof.
 u=units[name]
 return GATE in u.get('Requires',set()) and GATE in u.get('After',set())

def ordering_cycle(units):
 edges={}
 def edge(a,b):edges.setdefault(a,set()).add(b);edges.setdefault(b,set())
 for name,u in units.items():
  for other in u.get('After',set()):edge(other,name)
  for other in u.get('Before',set()):edge(name,other)
  if u.get('DefaultDependencies','yes')!='no':
   if name.endswith('.service'):
    edge('sysinit.target',name);edge('basic.target',name)
   if name.endswith('.target'):
    for other in u.get('Requires',set())|u.get('Wants',set()):edge(other,name)
 visiting=set();done=set()
 def visit(name):
  if name in visiting:return True
  if name in done:return False
  visiting.add(name)
  if any(visit(other) for other in edges[name]):return True
  visiting.remove(name);done.add(name);return False
 return any(visit(name) for name in edges)
class Ordering(unittest.TestCase):
 def setUp(self):
  self.actual={name:(args.fixtures/name).read_text() for name in FIXTURES}
  self.assertEqual(unit([self.actual['systemd-networkd.service']])['DefaultDependencies'],'no')
  self.assertEqual(unit([self.actual['systemd-networkd.socket']])['DefaultDependencies'],'no')
  portable=IMAGE.parent
  for name,path in {'tor-guest-firewall.service':portable/'network/units/tor-guest-firewall.service','tor-guest.service':portable/'network/units/tor-guest.service','portable-agent.service':portable.parent/'workspace-service/units/portable-agent.service','portable-display.service':portable/'display/portable-display.service'}.items():self.actual[name]=path.read_text()
  self.actual[GATE]=(IMAGE/'units'/GATE).read_text()
  with tempfile.TemporaryDirectory() as tmp:
   files,_,_=stage.plan(P(tmp),'fixture','CONFIG_PSTORE=y\nCONFIG_EFI=y\nCONFIG_TMPFS=y\nCONFIG_SYSFS=y\n','efi=noruntime pstore.backend=none\n')
  self.drops={name:files['etc/systemd/system/'+name+'.d/50-portable-persistent-api.conf'][0].decode() for name in stage.CONSUMERS}
  self.effective={name:unit([text,self.drops.get(name,'')]) for name,text in self.actual.items()}
 def test_previous_sysinit_only_policy_reproduces_gap(self):
  for name in ('systemd-networkd.service','systemd-networkd.socket','tor-guest-firewall.service'):
   old={**self.effective,name:unit([self.actual[name]])};self.assertFalse(admitted(old,name),name)
 def test_actual_early_and_interactive_consumers_require_success(self):
  for name in self.actual:
   if name in stage.CONSUMERS:self.assertTrue(admitted(self.effective,name),name)
  # Also verify every supported output, including templates and independent UI.
  for name,text in self.drops.items():self.assertTrue(admitted({name:unit([text])},name),name)
 def test_before_or_wants_only_mutations_fail_contract(self):
  for broken in ('[Unit]\nAfter='+GATE+'\n','[Unit]\nWants='+GATE+'\nAfter='+GATE+'\n','[Unit]\nRequires='+GATE+'\n'):
   name='systemd-networkd.socket';changed={**self.effective,name:unit([self.actual[name],broken])};self.assertFalse(admitted(changed,name))
 def test_effective_ordering_no_cycle_and_bad_after_sysinit_detected(self):
  self.assertFalse(ordering_cycle(self.effective))
  broken={**self.effective,GATE:unit([self.actual[GATE],'[Unit]\nAfter=sysinit.target\n'])}
  self.assertTrue(ordering_cycle(broken))
if __name__=='__main__':
 print(json.dumps({'actualFixtureSha256':{n:hashlib.sha256((args.fixtures/n).read_bytes()).hexdigest() for n in FIXTURES},'scope':'offline actual-unit graph; no systemd252 execution'},sort_keys=True),flush=True)
 unittest.main(argv=[sys.argv[0],*rest],verbosity=2)
