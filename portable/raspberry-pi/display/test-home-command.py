# SPDX-License-Identifier: MIT
import importlib.util,os,unittest
from pathlib import Path
from unittest.mock import patch,Mock
P=Path(__file__).resolve().parent
s=importlib.util.spec_from_file_location('home',P/'home-command.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Home(unittest.TestCase):
 def test_rejects_unprivileged_and_selectors(self):
  with patch.object(m.os,'getresuid',return_value=(970,970,970)):
   with self.assertRaises(ValueError):m.main(['agent'])
  with self.assertRaises(ValueError):m.main(['agent','--socket','evil'])
 def test_agent_session_words_only(self):
  with patch.object(m.os,'getresuid',return_value=(0,0,0)),patch.object(m.resource,'setrlimit'),patch.object(m.ctypes,'CDLL',return_value=Mock(prctl=Mock(return_value=0))),patch.object(m,'launch_pi',return_value=0) as launch:
   for args,mode in ((['agent'],None),(['agent','save'],'save'),(['agent','resume'],'resume')):
    self.assertEqual(m.main(args),0);self.assertEqual(launch.call_args.args,(mode,))
   for bad in (['agent','Save'],['agent','save','resume'],['agent','--session-dir','/tmp'],['agent','continue'],['agent',''],['save'],['status','save']):
    with self.assertRaises(ValueError):m.main(bad)
  self.assertEqual(launch.call_count,3)
 def test_session_argv_per_mode(self):
  import tempfile
  for mode,want in ((None,['--no-session']),('save',['--session-dir','/run/portable-vault/agent/sessions']),('resume',['--session-dir','/run/portable-vault/agent/sessions','--resume'])):
   with tempfile.TemporaryDirectory() as d:
    argv=m.pi_argv(Path(d),mode);self.assertEqual(argv[3:3+len(want)],want);self.assertEqual(argv[3+len(want)],'--no-extensions')
    self.assertEqual([a for a in argv if a.startswith(('--no-session','--session','--resume','--continue'))],[a for a in want if a.startswith('--')])
  self.assertIn('NOT SAVED',m.SESSION_LINES[None]);self.assertIn('SAVED to the encrypted vault',m.SESSION_LINES['save'])
 def test_drop_order_and_environment(self):
  events=[]
  with patch.dict(os.environ,{'SECRET':'private'},clear=True),patch.object(m.os,'setgroups',side_effect=lambda v:events.append(('groups',v))),patch.object(m.os,'setgid',side_effect=lambda v:events.append(('gid',v))),patch.object(m.os,'setuid',side_effect=lambda v:events.append(('uid',v))),patch.object(m.ctypes,'CDLL',return_value=Mock(prctl=Mock(return_value=0))):
   m.drop(971,[974]);self.assertEqual(events,[('groups',[974]),('gid',971),('uid',971)]);self.assertNotIn('SECRET',os.environ)
 def test_unlock_one_request_after_drop_no_secret_argv(self):
  events=[];vault=Mock();vault.read_passphrase_noecho.return_value=b'public-test';vault.run_operation.side_effect=lambda *a:events.append(('request',a)) or ('unknown','timeout');vault.sanitise.side_effect=lambda x:x
  with patch.object(m.os,'getresuid',return_value=(0,0,0)),patch.object(m.resource,'setrlimit'),patch.object(m.ctypes,'CDLL',return_value=Mock(prctl=Mock(return_value=0))),patch.object(m.os,'isatty',return_value=True),patch.object(m.stat,'S_ISCHR',return_value=True),patch.object(m,'load',return_value=vault),patch.object(m,'drop',side_effect=lambda *a:events.append(('drop',a))),patch.object(m,'exchange_home',side_effect=lambda v,*a:events.append(('request',a)) or ('unknown','timeout')):
   self.assertEqual(m.main(['unlock']),1)
  self.assertEqual(events,[('drop',(972,[973])),('request',('unlock',b'public-test'))])
 def test_shell_exchange_peer_check_before_secret_no_vt2(self):
  vault=Mock();vault.REQUEST_DEADLINE_S=190;vault.SOCKET_PATH='/run/portable-control/broker.sock';vault.build_request.return_value=b'unlock\n7075626c6963\n';vault.peer_uid.return_value=0;vault.exchange_on_connected.return_value=('ok','unlocked')
  channel=Mock();factory=Mock();factory.return_value.__enter__=Mock(return_value=channel);factory.return_value.__exit__=Mock(return_value=False)
  with patch.object(m.os,'getresuid',return_value=(972,972,972)),patch.object(m.socket,'socket',factory):
   self.assertEqual(m.exchange_home(vault,'unlock',b'public'),('ok','unlocked'));vault.require_active_vt.assert_not_called();vault.exchange_on_connected.assert_called_once()
   vault.exchange_on_connected.reset_mock();vault.peer_uid.return_value=971
   self.assertEqual(m.exchange_home(vault,'unlock',b'public')[0],'error');vault.exchange_on_connected.assert_not_called()
 def test_fund_new_exact_mapping(self):
  with patch.object(m.os,'getresuid',return_value=(0,0,0)),patch.object(m.resource,'setrlimit'),patch.object(m.ctypes,'CDLL',return_value=Mock(prctl=Mock(return_value=0))),patch.object(m.os,'execve',side_effect=SystemExit) as execute:
   with self.assertRaises(SystemExit):m.main(['fund','--new'])
   self.assertEqual(execute.call_args.args[1][-1],'new-demo')
  with self.assertRaises(ValueError):m.main(['unlock','--new'])
 def test_desktop_starts_display_unit_without_waiting(self):
  with patch.object(m.os,'getresuid',return_value=(0,0,0)),patch.object(m.resource,'setrlimit'),patch.object(m.ctypes,'CDLL',return_value=Mock(prctl=Mock(return_value=0))),patch.object(m.os,'execv',side_effect=SystemExit) as execute:
   with self.assertRaises(SystemExit):m.main(['desktop'])
  self.assertEqual(execute.call_args.args,('/usr/bin/systemctl',['systemctl','--no-block','start','portable-display.service']))
 def test_pi_argv_settings_and_env(self):
  import json,tempfile
  with tempfile.TemporaryDirectory() as d:
   home=Path(d);argv=m.pi_argv(home)
   self.assertEqual(json.loads((home/'agent/settings.json').read_text())['retry']['maxRetries'],0)
   self.assertEqual(oct((home/'agent/settings.json').stat().st_mode&0o777),'0o600')
   self.assertEqual(argv[:2],['node','/opt/portable/vendor/pi/sdk-broker-v4/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'])
   self.assertIn('--no-session',argv);self.assertEqual(argv[argv.index('--provider')+1],'portable-broker')
   self.assertEqual(m.pi_env(home,'foot'),{'PATH':'/opt/portable/bin:/usr/bin:/bin','LANG':'C.UTF-8','TERM':'foot','HOME':d,'PI_CODING_AGENT_DIR':d+'/agent','PI_TELEMETRY':'0'})
 def test_shell_and_wrappers(self):
  unit=(P/'portable-operator-shell.service').read_text();self.assertIn('User=root',unit);self.assertIn('TTYPath=/dev/tty1',unit);self.assertNotIn('agetty',unit)
  for c in m.COMMANDS:self.assertIn('home-command.py '+c+' "$@"',(P/'operator-home'/c).read_text())
if __name__=='__main__':unittest.main()
