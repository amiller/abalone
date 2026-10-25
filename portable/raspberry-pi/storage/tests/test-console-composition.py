# SPDX-License-Identifier: MIT
import importlib.util,pathlib,sys,threading,time,tempfile,unittest,unittest.mock as mock,os,socket,json
P=pathlib.Path(__file__).resolve().parents[4]
def load(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
b=load('broker',P/'portable/raspberry-pi/storage/guest/vault-broker.py');o=load('operator',P/'portable/raspberry-pi/storage/operator-vt.py')
def fixture():
 x=object.__new__(b.Broker);x.compose_lock=threading.Lock();x.credit_session=True;x.events=[]
 def dispatch(op,secret,timeout=None):x.events.append(op);return ('ok','state: unlocked' if op!='lock' else 'locked: no mapping, no mount')
 def supervisor(op,timeout,properties=()):x.events.append(op);return 0,b'',b'',False
 x.dispatch=dispatch;x.run_supervisor=supervisor;x.show_credit=lambda props,t:({k:{'ActiveState':'active','MainPID':'9','ConditionResult':'yes','ControlGroup':'/system.slice/portable-credit.service'}[k] for k in props},'');x.credit_cgroup_empty=lambda cg:(True,'empty');return x
class Tests(unittest.TestCase):
 def test_unlock_start_and_condition_skip(self):
  x=fixture();self.assertEqual(x.composed_unlock(b'synthetic',time.monotonic()+5),('ok','vault unlocked; credit service started'));self.assertEqual(x.events,['unlock','status','start'])
  x=fixture();x.show_credit=lambda p,t:({'ActiveState':'inactive','MainPID':'0','ConditionResult':'no'},'');r=x.composed_unlock(b'synthetic',time.monotonic()+5);self.assertEqual(r[0],'ok');self.assertIn('credit unavailable',r[1]);self.assertNotIn('lock',x.events)
 def test_no_start_without_verified_unlock(self):
  for status,detail in [('error','wrong passphrase'),('ok','prefix state: unlocked'),('ok','state: partial'),('ok','state: unsafe')]:
   x=fixture();x.dispatch=lambda *a,**k:(status,detail);r=x.composed_unlock(b'synthetic',time.monotonic()+5);self.assertNotIn('start',x.events)
 def test_stop_failure_never_locks(self):
  for rc,timeout in [(1,False),(None,True)]:
   x=fixture();x.run_supervisor=lambda *a,**k:(rc,b'',b'',timeout);r=x.composed_lock(time.monotonic()+5);self.assertEqual(r[0],'error');self.assertNotIn('lock',x.events)
  for props in [{'ActiveState':'active','MainPID':'0','ControlGroup':''},{'ActiveState':'inactive','MainPID':'1','ControlGroup':''}]:
   x=fixture();x.show_credit=lambda p,t:(props,'');self.assertEqual(x.composed_lock(time.monotonic()+5)[0],'error');self.assertNotIn('lock',x.events)
  x=fixture();x.show_credit=lambda p,t:({'ActiveState':'inactive','MainPID':'0','ControlGroup':'/system.slice/portable-credit.service'},'');x.credit_cgroup_empty=lambda c:(False,'populated');self.assertEqual(x.composed_lock(time.monotonic()+5)[0],'error');self.assertNotIn('lock',x.events)
 def test_stop_drains_before_lock(self):
  x=fixture();x.show_credit=lambda p,t:({'ActiveState':'inactive','MainPID':'0','ControlGroup':'/system.slice/portable-credit.service'},'');self.assertEqual(x.composed_lock(time.monotonic()+5)[0],'ok');self.assertEqual(x.events,['stop','lock'])
 def test_failed_state_drained_allows_ordinary_lock(self):
  x=fixture();order=[]
  def sup(op,t,properties=()):order.append(op);return (0,b'',b'',False)
  def show(p,t):
   order.append('verify');return ({'ActiveState':'failed','MainPID':'0','ControlGroup':'/system.slice/portable-credit.service'},'')
  def cg(c):
   order.append('cgroup');return (True,'unit cgroup empty')
  def dsp(op,s,timeout=None):
   order.append(op);return ('ok','locked: no mapping, no mount') if op=='lock' else ('ok','state: unlocked')
  x.run_supervisor=sup;x.show_credit=show;x.credit_cgroup_empty=cg;x.dispatch=dsp
  self.assertEqual(x.composed_lock(time.monotonic()+5),('ok','locked: no mapping, no mount'));self.assertEqual(order,['stop','verify','cgroup','lock'])
 def test_failed_not_drained_unknown_or_stopfailure_refuses(self):
  D='/system.slice/portable-credit.service';cases=[]
  def mk(name,**kw):cases.append((name,kw))
  mk('failed-mainpid',props={'ActiveState':'failed','MainPID':'7','ControlGroup':D})
  mk('failed-cgroup-nonempty',props={'ActiveState':'failed','MainPID':'0','ControlGroup':D},cgroup=(False,'1 process(es) remain in the unit cgroup'))
  mk('failed-cgroup-unknown',props={'ActiveState':'failed','MainPID':'0','ControlGroup':D},cgroup=(False,'credit cgroup population unknown'))
  mk('unknown-state',props={'ActiveState':'activating','MainPID':'0','ControlGroup':D})
  mk('stop-exit',rc=1)
  mk('stop-timeout',timed=True)
  mk('show-timeout',props=None,show_err='timeout (unit property query exceeded its budget)')
  mk('budget-exhausted',deadline=-1)
  for name,kw in cases:
   x=fixture()
   if kw.get('rc') is not None or kw.get('timed'):x.run_supervisor=lambda *a,**k:(kw.get('rc'),b'',b'',bool(kw.get('timed')))
   if 'props' in kw:x.show_credit=lambda p,t:((kw['props'],'') if kw['props'] is not None else (None,kw.get('show_err','failed')))
   if 'cgroup' in kw:x.credit_cgroup_empty=lambda c:kw['cgroup']
   r=x.composed_lock(time.monotonic()+kw.get('deadline',5));self.assertEqual(r[0],'error',name);self.assertNotIn('lock',x.events,name);self.assertIn('lock NOT run',r[1],name)
 def test_lock_helper_refusal_propagates(self):
  x=fixture();x.show_credit=lambda p,t:({'ActiveState':'failed','MainPID':'0','ControlGroup':'/system.slice/portable-credit.service'},'')
  def dsp(op,s,timeout=None):
   x.events.append(op);return ('error','exit=1 umount refused') if op=='lock' else ('ok','state: unlocked')
  x.dispatch=dsp
  self.assertEqual(x.composed_lock(time.monotonic()+5),('error','exit=1 umount refused'));self.assertEqual(x.events,['stop','lock'])
 def test_busy_is_immediate_and_never_queued(self):
  x=fixture();entered=threading.Event();release=threading.Event();original=x.dispatch
  def gate(op,*a,**kw):
   if op=='unlock':entered.set();assert release.wait(2)
   return original(op,*a,**kw)
  x.dispatch=gate;t=threading.Thread(target=lambda:x.composed_unlock(b'synthetic',time.monotonic()+5));t.start();self.assertTrue(entered.wait(1));start=time.monotonic();r=x.composed_lock(time.monotonic()+5);self.assertLess(time.monotonic()-start,.1);self.assertIn('busy',r[1]);release.set();t.join(2);self.assertFalse(t.is_alive());self.assertNotIn('lock',x.events)
 def test_cgroup_fixed_path_and_descendants(self):
  x=fixture()
  with tempfile.TemporaryDirectory() as d,mock.patch.object(b,'CGROUP_ROOT',d):
   self.assertFalse(b.Broker.credit_cgroup_empty(x,'/')[0]);self.assertFalse(b.Broker.credit_cgroup_empty(x,'/other')[0]);self.assertTrue(b.Broker.credit_cgroup_empty(x,'')[0]);p=pathlib.Path(d)/'system.slice/portable-credit.service';p.mkdir(parents=True);(p/'cgroup.procs').write_text('');(p/'cgroup.events').write_text('populated 1\n');self.assertFalse(b.Broker.credit_cgroup_empty(x,'')[0]);(p/'cgroup.events').write_text('populated 0\n');self.assertTrue(b.Broker.credit_cgroup_empty(x,'')[0]);(p/'cgroup.procs').write_text('42\n');self.assertFalse(b.Broker.credit_cgroup_empty(x,'')[0])
 def test_fixed_executor_no_arbitrary_unit_or_verb(self):
  x=fixture();self.assertEqual(x.supervisor_argv('start'),['/usr/bin/systemctl','start','portable-credit.service'])
  with self.assertRaises(b.ConfigError):x.supervisor_argv('restart')
  with self.assertRaises(b.ConfigError):x.supervisor_argv('show',['ExecStart'])
 def test_capture_bound_and_timeout_actual_children(self):
  rc,out,err,failed=b.bounded_process([sys.executable,'-c','print("x"*100000)'],{'PATH':'/usr/bin:/bin'},2);self.assertTrue(failed);self.assertLessEqual(len(out),4096)
  start=time.monotonic();rc,out,err,failed=b.bounded_process([sys.executable,'-c','import time;time.sleep(10)'],{'PATH':'/usr/bin:/bin'},.05);self.assertTrue(failed);self.assertLess(time.monotonic()-start,2)
 def test_default_wire_never_calls_supervisor(self):
  x=fixture();x.credit_session=False;x.peer_allowed=lambda c:True;x.run_supervisor=lambda *a:(_ for _ in ()).throw(AssertionError('supervisor called'));a,c=socket.socketpair();c.settimeout(1);c.sendall(b'status\n');x.handle(a,None);self.assertTrue(c.recv(1024).startswith(b'ok '));c.close();self.assertEqual(x.events,['status'])
 def test_standby_wait_before_input_and_flush_failure(self):
  with mock.patch.object(o,'vt_active',side_effect=[1,1,2]),mock.patch.object(o.time,'sleep') as sleep,mock.patch.object(o.termios,'tcflush') as flush,mock.patch.object(o.os,'read',side_effect=AssertionError('input')),mock.patch.object(o,'run_operation',side_effect=AssertionError('broker')):
   o.wait_for_active_vt(0);self.assertEqual(sleep.call_count,2);flush.assert_called_once()
  with mock.patch.object(o,'vt_active',return_value=2),mock.patch.object(o.termios,'tcflush',side_effect=o.termios.error('fixture')):
   with self.assertRaises(o.OperatorError):o.wait_for_active_vt(0)
 def test_standby_signal_restores_handlers(self):
  with mock.patch.object(o,'vt_active',return_value=1),mock.patch.object(o.time,'sleep',side_effect=o.TerminalAborted('stop')):
   with self.assertRaises(o.TerminalAborted):o.wait_for_active_vt(0)
 def test_simple_banner_and_base_unit_no_optin(self):
  self.assertIn('Vault control',o.BANNER);self.assertNotIn('proposal',o.BANNER);s=(P/'portable/raspberry-pi/storage/units/portable-vault-broker.service').read_text();self.assertIn('LimitCORE=0',s.splitlines());self.assertNotIn('--credit-session',next(x for x in s.splitlines() if x.startswith('ExecStart=')))
if __name__=='__main__':unittest.main(verbosity=2)
