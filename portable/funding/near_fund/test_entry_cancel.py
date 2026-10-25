# SPDX-License-Identifier: MIT
"""Actual entry signal guards and curl finally, separate-session synthetic child only."""
import ast,json,os,signal,subprocess,sys,tempfile,time,unittest
from pathlib import Path
BASE=Path(__file__).resolve().parents[1]
class Tests(unittest.TestCase):
 def exercise(self,name):
  source=(BASE/name).read_text();tree=ast.parse(source)
  # Execute the EXACT installed signal handler and __main__ exception boundary.
  selected=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='cancelled' or isinstance(n,ast.If) and ast.unparse(n.test)=="__name__ == '__main__'"]
  self.assertEqual(len(selected),2)
  entry=ast.unparse(ast.Module(body=selected,type_ignores=[]))
  with tempfile.TemporaryDirectory() as directory:
   marker=Path(directory)/'curl-pid'
   fixture="""import json,os,pathlib,signal,subprocess,sys,urllib.request
sys.path.insert(0,sys.argv[1]);import context
original=subprocess.Popen
marker=sys.argv[2]
def spawn(argv,**kw):
 child='import os,pathlib,sys,time;sys.stdin.buffer.read();pathlib.Path(sys.argv[1]).write_text(str(os.getpid()));time.sleep(60)'
 return original([sys.executable,'-I','-c',child,marker],**kw)
context.subprocess.Popen=spawn
def main():return context.curl_request(urllib.request.Request('https://base-rpc.publicnode.com'))
"""+entry
   process=subprocess.Popen([sys.executable,'-I','-c',fixture,str(BASE/'near_fund'),str(marker)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
   curl=None
   try:
    end=time.monotonic()+5
    while not marker.exists():
     self.assertIsNone(process.poll());self.assertLess(time.monotonic(),end);time.sleep(.01)
    curl=int(marker.read_text());self.assertEqual(os.getpgid(curl),curl)
    os.killpg(process.pid,signal.SIGTERM)
    out,err=process.communicate(timeout=5)
    self.assertEqual(process.returncode,1);self.assertEqual(err,b'')
    self.assertIsInstance(json.loads(out),dict)
    with self.assertRaises(ProcessLookupError):os.kill(curl,0)
   finally:
    if process.poll() is None:os.killpg(process.pid,signal.SIGKILL);process.wait()
    if curl:
     try:os.killpg(curl,signal.SIGKILL)
     except ProcessLookupError:pass
 def test_operator_term_reaps_separate_session_transport_before_exit(self):self.exercise('operator-session.py')
 def test_activation_term_reaps_separate_session_transport_before_exit(self):self.exercise('activation-command.py')
if __name__=='__main__':unittest.main()
