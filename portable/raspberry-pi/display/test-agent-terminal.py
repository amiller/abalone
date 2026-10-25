# SPDX-License-Identifier: MIT
import unittest,uuid,unicodedata,time
from unittest.mock import patch
import importlib.util,sys,pathlib
spec=importlib.util.spec_from_file_location("terminal_agent",pathlib.Path(__file__).with_name("agent-terminal.py"))
m=importlib.util.module_from_spec(spec);sys.modules["terminal_agent"]=m;spec.loader.exec_module(m)

ID=str(uuid.uuid4())
class Fake:
 def __init__(self):self.posts=[];self.deletes=[];self.rows=[];self.response={'events':[],'offset':0,'state':'running'};self.ambiguous=False
 def status(self):return {'mode':'service','csrfToken':'secret-test-token','agent':{'available':True,'mode':'scripted'}}
 def list_agents(self):return {'agents':self.rows}
 def post_agent(self,p,t):
  self.posts.append((p,t))
  if self.ambiguous:raise TimeoutError()
  return {'id':ID}
 def events(self,i,o,t):return self.response
 def delete_agent(self,i,t):self.deletes.append(i);raise TimeoutError()
class Tests(unittest.TestCase):
 def setup_ctl(self):
  f=Fake();c=m.Controller(f,threaded=False);c._handle('reconcile',None);return f,c
 def test_idle_warming_status_preserves_reason_and_blocks_post(self):
  f=Fake();f.status=lambda:{'mode':'service','csrfToken':'synthetic','agent':{'available':False,'kind':'warming'}}
  c=m.Controller(f,threaded=False);c._status()
  self.assertEqual(c.status_msg,'Agent warming; shell is available');self.assertFalse(c.available);self.assertTrue(c.submit('wait'));c.pump();self.assertFalse(f.posts);self.assertEqual(c.status_msg,'not ready; prompt retained')
 def test_stale_cached_view_queues_once_then_fresh_status_decides(self):
  for ready in (True,False):
   with self.subTest(ready=ready):
    f,c=self.setup_ctl()
    # Typing can outlive the display projection TTL; submit must refresh it.
    c.view.observe(f.status(),0,0)
    self.assertFalse(c.view.render(time.monotonic())['ready'])
    f.status=lambda:{'mode':'service','csrfToken':'fresh','agent':{'available':ready,'mode':'scripted'}}
    self.assertTrue(c.submit('retained task'));self.assertFalse(c.submit('duplicate'));self.assertEqual(c.q.qsize(),1)
    c.pump();self.assertEqual(len(f.posts),1 if ready else 0)
    if not ready:
     self.assertEqual(c.prompt,'retained task');self.assertEqual(c.status_msg,'not ready; prompt retained');self.assertFalse(c.sent_post)
 def test_existing_id_blocks_even_without_post_latch(self):
  f,c=self.setup_ctl();c.agent_id=ID;c.sent_post=False
  self.assertFalse(c.submit('duplicate'));self.assertTrue(c.q.empty());self.assertFalse(f.posts)
 def test_actual_event_shape_and_manager_terminal_only(self):
  f,c=self.setup_ctl();self.assertTrue(c.submit('read seed'));c.pump()
  f.response={'events':[{'type':'agent_event','event':'text_delta','delta':'hello'},{'type':'worker_reported_done','lastText':'fake'}],'offset':50,'state':'running'}
  c._handle('events',None);self.assertEqual(c.lines,['hello']);self.assertEqual(c.state,'running')
  f.response={'events':[],'offset':50,'state':'done'};c._handle('events',None)
  self.assertEqual(c.state,'terminal-done');self.assertTrue(c.submit('second task'));c.pump();self.assertEqual(len(f.posts),2)
 def test_ambiguous_post_never_replayed_even_empty_list(self):
  f,c=self.setup_ctl();f.ambiguous=True;c.submit('retain draft');c.pump();self.assertEqual(c.state,'unknown_start')
  for _ in range(3):c._handle('reconcile',None);self.assertFalse(c.submit('retain draft'))
  self.assertEqual(len(f.posts),1);self.assertEqual(c.prompt,'retain draft')
  f.rows=[{'id':ID,'alive':True,'state':'running'}];c._handle('reconcile',None);self.assertEqual(c.agent_id,ID)
 def test_malformed_success_post_is_unknown(self):
  f,c=self.setup_ctl();f.post_agent=lambda p,t:{'id':'not-a-uuid'};c.submit('task');c.pump()
  self.assertEqual(c.state,'unknown_start');self.assertFalse(c.submit('again'))
 def test_startup_reconnect_lists_and_multiple_selection(self):
  f=Fake();other=str(uuid.uuid4());f.rows=[{'id':ID,'alive':True},{'id':other,'alive':True}];c=m.Controller(f,threaded=False);c._handle('reconcile',None)
  self.assertEqual(c.state,'ambiguous');self.assertFalse(c.submit('new'));c.select(1);c.pump();self.assertEqual(c.agent_id,other);self.assertFalse(f.posts)
 def test_stop_once_unknown_keeps_polling(self):
  f,c=self.setup_ctl();c.submit('task');c.pump();c.stop();c.stop();c.pump();self.assertEqual(f.deletes,[ID]);self.assertIn('unknown',c.status_msg)
  c.stop();self.assertTrue(c.q.empty());self.assertEqual(c.agent_id,ID)
 def test_malformed_events_do_not_advance(self):
  f,c=self.setup_ctl();c._attach(ID);c.offset=10
  for bad in [True,-1,'20']:
   f.response={'events':[],'offset':bad,'state':'running'};c._handle('events',None);self.assertEqual(c.offset,10)
  f.response={'events':['bad'],'offset':20,'state':'running'};c._handle('events',None);self.assertEqual(c.offset,10)
 def test_unicode_and_osc_are_inert(self):
  text='\x1b]52;c;payload\x07\r\x9b\u2066\u061c\ud800visible\ttext\n'
  clean=m.safe_text(text);self.assertIn('visible',clean)
  self.assertTrue(all(x=='\n' or unicodedata.category(x) not in {'Cc','Cf','Cs'} for x in clean))
 def test_tiny_resize(self):
  for h,w in [(1,1),(2,2),(24,80),(0,0)]:
   lines=m.layout(['a'*200,'\x1b[31munsafe'],h,w);self.assertLessEqual(len(lines),max(0,h-7));self.assertTrue(all('\x1b' not in x for x in lines))
 def test_idle_worker_polls_without_keys_and_drains(self):
  f=Fake();f.rows=[{'id':ID,'alive':True}];f.response={'events':[{'type':'agent_event','event':'text_delta','delta':'autonomous'}],'offset':9,'state':'done'}
  c=m.Controller(f);end=time.monotonic()+2
  try:
   while 'autonomous' not in c.snapshot()['lines'] and time.monotonic()<end:time.sleep(.01)
   self.assertIn('autonomous',c.snapshot()['lines']);self.assertEqual(f.posts,[])
  finally:c.close()
  self.assertFalse(c.worker.is_alive())
 def test_fixed_http_token_and_no_redirect(self):
  calls=[]
  class Response:
   status=201
   def read(self,n):self.n=n;return ('{"id":"'+ID+'"}').encode()
  class Connection:
   def __init__(self,*a,**kw):calls.append((a,kw))
   def request(self,*a,**kw):calls.append((a,kw))
   def getresponse(self):return Response()
   def close(self):pass
  with patch.object(m.http.client,'HTTPConnection',Connection):self.assertEqual(m.AgentClient().post_agent('task','token')['id'],ID)
  self.assertEqual(calls[0],(('127.0.0.1',8765),{'timeout':3}));headers=calls[1][1]['headers'];self.assertEqual(headers['Origin'],m.ORIGIN);self.assertEqual(headers['x-workspace-token'],'token');self.assertEqual(headers['Content-Type'],'application/json')
  Response.status=302
  with patch.object(m.http.client,'HTTPConnection',Connection),self.assertRaises(m.ApiError):m.AgentClient().status()


import http.client,json,select,subprocess
class ActualHTTP(unittest.TestCase):
 def test_actual_router_turn_reconnect_ambiguity_stop_and_csrf(self):
  p=subprocess.Popen(['node',str(pathlib.Path(__file__).with_name('agent-terminal-http-fixture.mjs'))],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  def cmd(**v):
   p.stdin.write(json.dumps(v)+'\n');p.stdin.flush()
   self.assertTrue(select.select([p.stdout],[],[],5)[0],'fixture control deadline')
   line=p.stdout.readline()
   if not line:raise AssertionError('fixture exited: '+p.stderr.read(4096))
   r=json.loads(line);self.assertNotIn('fixtureError',r);return r
  def fresh():
   c=m.Controller(threaded=False);c._handle('reconcile',None);self.assertTrue(c.available);return c
  try:
   # No listener owned by this test yet. Refuse instead of taking an existing service.
   probe=http.client.HTTPConnection(m.HOST,m.PORT,timeout=.2)
   try:
    probe.connect();self.fail('fixed port already occupied; test refuses interference')
   except ConnectionRefusedError:pass
   finally:probe.close()
   c=m.Controller(threaded=False);c._handle('status',None);self.assertFalse(c.available)
   cmd(op='listen');c._handle('reconcile',None);self.assertTrue(c.available)
   # Real router rejects wrong Origin and missing CSRF, before backend admission.
   conn=http.client.HTTPConnection(m.HOST,m.PORT,timeout=3)
   conn.request('POST','/api/agents',body='{"prompt":"blocked"}',headers={'Origin':'http://evil.invalid','Content-Type':'application/json'})
   r=conn.getresponse();self.assertEqual(r.status,403);r.read();conn.close()
   conn=http.client.HTTPConnection(m.HOST,m.PORT,timeout=3)
   conn.request('POST','/api/agents',body='{"prompt":"blocked"}',headers={'Origin':m.ORIGIN,'Content-Type':'application/json'})
   r=conn.getresponse();self.assertEqual(r.status,403);r.read();conn.close()
   self.assertEqual(cmd(op='counts')['starts'],0)
   self.assertTrue(c.submit('synthetic task'));c.pump();self.assertEqual(cmd(op='counts')['starts'],1)
   c._handle('events',None);self.assertEqual(c.state,'running');self.assertGreater(c.offset,0);self.assertIn('actual HTTP text',c.lines[0]);self.assertNotIn('\x1b',''.join(c.lines))
   before=list(c.lines);c._handle('events',None);self.assertEqual(c.lines,before)
   reconnect=fresh();self.assertEqual(reconnect.agent_id,c.agent_id);self.assertEqual(cmd(op='counts')['starts'],1)
   cmd(op='finish');c._handle('events',None);self.assertEqual(c.state,'terminal-done')
   # Backend effect occurred, but router returned 503: ambiguous, no repost.
   cmd(op='reset',startFault=True);c=fresh();c.submit('once');c.pump();self.assertEqual(c.state,'unknown_start')
   c.reconcile();c.pump();self.assertEqual(c.state,'running');self.assertFalse(c.submit('once'));self.assertEqual(cmd(op='counts')['starts'],1)
   c.stop();c.stop();c.pump();self.assertEqual(cmd(op='counts')['stops'],1);c._handle('events',None);self.assertEqual(c.state,'terminal-aborted')
   # Stop failure stays uncertain and never sends another DELETE.
   cmd(op='reset',stopFault=True);c=fresh();c.submit('stop uncertainty');c.pump();c.stop();c.pump();self.assertIn('unknown',c.status_msg);c.stop();self.assertTrue(c.q.empty());self.assertEqual(cmd(op='counts')['stops'],1)
   cmd(op='close');c._handle('events',None);self.assertIn('unavailable',c.status_msg)
   cmd(op='listen');c.reconcile();c.pump();self.assertIsNotNone(c.agent_id);self.assertEqual(cmd(op='counts')['starts'],1)
   cmd(op='exit');p.stdin.close();self.assertEqual(p.wait(timeout=5),0)
  finally:
   if p.poll() is None:p.terminate();p.wait(timeout=5)
   for stream in (p.stdin,p.stdout,p.stderr):stream.close()


class PublicView(unittest.TestCase):
 def value(self):
  return {'mode':'service','csrfToken':'DO-NOT-RETAIN','backend':{'available':True},'agent':{'available':True,'mode':'broker'},'desktop':{'validForMs':15000,'tor':{'state':'bootstrapped','progress':100}},'credit':{'state':'configured','session':ID,'validForMs':1000,'accountBalance':{'provider':'near','scope':'account','currency':'USD','amountDecimal':'0.940572612','observedAt':'2026-10-15T12:00:00.000Z','providerAsOf':None,'freshness':'fresh','source':'provider-reported'},'allowance':{'state':'unknown','reason':'journal-not-bound'},'funding':{'state':'not-configured'}}}
 def test_credit_separate_ttl_age_and_no_token_retention(self):
  value=self.value();v=m.DsmackPublicStatus();v.observe(value,100,100.5)
  self.assertEqual(v.render(100.6)['credit'],'Provider account USD 0.940572612')
  self.assertEqual(v.render(101)['credit'],'Provider account unknown')
  self.assertTrue(v.render(101)['ready']);self.assertNotIn('DO-NOT-RETAIN',repr(vars(v)))
  self.assertFalse(v.render(106)['ready'])
 def test_malformed_or_stale_credit_never_fresh(self):
  for change in [lambda x:x['credit'].update(session='not-uuid'),lambda x:x['credit']['accountBalance'].update(amountDecimal='-2'),lambda x:x['credit']['accountBalance'].update(observedAt='2026-99-99T12:00:00.000Z'),lambda x:x['credit']['accountBalance'].update(extra='no'),lambda x:x['credit'].update(validForMs=True),lambda x:x['credit'].update(allowance={'state':'available'})]:
   value=self.value();change(value);v=m.DsmackPublicStatus();v.observe(value,100,100);self.assertEqual(v.render(100)['credit'],'Provider account unknown')
  value=self.value();value['credit']['accountBalance']['freshness']='stale';v.observe(value,100,100);self.assertEqual(v.render(100)['credit'],'Provider account stale')
 def test_tor_ready_exact_and_warming_unlock(self):
  value=self.value();v=m.DsmackPublicStatus()
  for tor in [{'state':'starting','progress':95},{'state':'bootstrapped','progress':99},{'state':'stopped','progress':None},{'state':'bootstrapped','progress':True}]:
   value['desktop']['tor']=tor;v.observe(value,100,100);self.assertFalse(v.render(100)['ready'])
  value['agent']={'mode':'broker','available':False,'detail':'Unlock storage to connect the inference provider'};v.observe(value,100,100);self.assertEqual('Unlock storage: run ~/unlock',v.render(100)['agent'])
  value['agent']={'available':False,'kind':'warming'};v.observe(value,100,100);self.assertIn('warming',v.render(100)['agent'])
  value['agent']={'mode':'scripted','available':True};v.observe(value,100,100);self.assertTrue(v.render(100)['ready'])
  value['backend']['available']=False;v.observe(value,100,100);self.assertFalse(v.render(100)['ready']);self.assertEqual(v.render(100)['agent'],'Workspace reconnecting')
 def test_stream_chunks_join_and_tool_boundaries(self):
  t=m.DsmackTranscript()
  for e in [{'type':'agent_event','event':'message_start','role':'assistant'},*({'type':'agent_event','event':'text_delta','delta':x} for x in ['Hel','lo\n','next',' line']),{'type':'agent_event','event':'message_end'},{'type':'agent_event','event':'tool_start','tool':'read'},{'type':'agent_event','event':'tool_end','tool':'read'},{'type':'agent_event','event':'text_delta','delta':'Finished'},{'type':'worker_reported_done','lastText':'NOT-FINAL'}]:t.feed(e)
  self.assertEqual(t.snapshot(),['Hello','next line','[tool_start read]','[tool_end read]','Finished'])
  t.feed({'type':'agent_event','event':'text_delta','delta':'\x1b]52;c;BAD\x07'+'界'*100000})
  self.assertLessEqual(sum(len(x.encode())+1 for x in t.snapshot()),65536)
  self.assertNotIn('\x1b',''.join(t.snapshot()))
 def test_display_source_bindings_and_profile_warning(self):
  sway=pathlib.Path(__file__).with_name('sway.config').read_text()
  self.assertNotIn('agent-terminal.py',sway);self.assertIn('bindsym $mod+a workspace 1:agent, exec $term --hold',sway)
  self.assertIn('bindsym $mod+Return fullscreen disable',sway);self.assertIn('bindsym $mod+f fullscreen toggle',sway)
  self.assertIn('bindsym $mod+b workspace 2:browser',sway)

import fcntl,os,pty,signal,struct,termios
class ActualPTY(unittest.TestCase):
 def test_curses_stream_header_resize_exit(self):
  master,slave=pty.openpty();p=None;output=bytearray()
  source=str(pathlib.Path(__file__).with_name('agent-terminal.py'))
  script='''import importlib.util,sys,curses
s=importlib.util.spec_from_file_location('agent',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Fake:
 def status(self):return {'mode':'service','csrfToken':'token','agent':{'available':True,'mode':'scripted'}}
 def list_agents(self):return {'agents':[]}
c=m.Controller(Fake());c.emit('model\\x1b]52;c;ATTACK\\x07 text')
curses.wrapper(lambda screen:m.run_ui(c,screen,True,True))
assert not c.worker.is_alive()
'''
  try:
   fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,100,0,0))
   p=subprocess.Popen([sys.executable,'-I','-c',script,source],stdin=slave,stdout=slave,stderr=slave,env={'PATH':'/usr/bin:/bin','TERM':'xterm-256color','LANG':'C.UTF-8'},start_new_session=True)
   os.close(slave);slave=None;end=time.monotonic()+5
   while b'Super+A agent' not in output:
    self.assertLess(time.monotonic(),end)
    if select.select([master],[],[],.1)[0]:output.extend(os.read(master,65536))
   self.assertIn(b'Ctrl+Alt+F4 funding',output);self.assertIn(b'NEAR: GPU revocation not checked',output);self.assertNotIn(b'firmware',output);self.assertIn(b'Provider account unknown',output)
   fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',2,2,0,0));os.kill(p.pid,signal.SIGWINCH);time.sleep(.1)
   fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',24,100,0,0));os.kill(p.pid,signal.SIGWINCH)
   os.write(master,b'\x11');self.assertEqual(p.wait(timeout=5),0);self.assertNotIn(b'\x1b]52;c;ATTACK',output)
  finally:
   if p is not None and p.poll() is None:p.kill();p.wait()
   os.close(master)
   if slave is not None:os.close(slave)

if __name__=='__main__':unittest.main()
