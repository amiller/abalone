# SPDX-License-Identifier: MIT
import json,subprocess,sys,unittest,urllib.request
from unittest.mock import patch
from . import context
class Tests(unittest.TestCase):
 def run_response(self,status=201,exitcode=0,sink=None):
  original=subprocess.Popen
  code='import sys;sys.stdin.buffer.read();sys.stdout.write('+repr('PRIVATE_BODY\n'+str(status))+');sys.stderr.write("PRIVATE_ERROR");sys.exit('+str(exitcode)+')'
  def spawn(_argv,**kw):return original([sys.executable,'-I','-c',code],**kw)
  with patch.object(context.subprocess,'Popen',side_effect=spawn):return context.curl_request(urllib.request.Request('https://1click.chaindefuser.com/v0/quote',data=b'{}'),response_sink=sink)
 def test_created_response_preserved_before_caller_validation(self):
  saved=[];body,status=self.run_response(sink=lambda b,c:saved.append((b,c)))
  self.assertEqual((body,status),(b'PRIVATE_BODY',201));self.assertEqual(saved,[(body,status)])
  self.assertEqual(context.transport_diagnostic(),{'origin':'oneclick','phase':'response','curlCode':0,'httpStatus':201})
 def test_error_body_preserved_once_before_status_refusal(self):
  saved=[]
  with self.assertRaises(ValueError):self.run_response(403,sink=lambda b,c:saved.append((b,c)))
  self.assertEqual(saved,[(b'PRIVATE_BODY',403)])
  d=context.transport_diagnostic();self.assertEqual(d,{'origin':'oneclick','phase':'http-status','curlCode':0,'httpStatus':403});self.assertNotIn('PRIVATE',json.dumps(d))
 def test_curl_exit_is_safe_and_no_response_callback(self):
  saved=[]
  with self.assertRaises(ValueError):self.run_response(0,28,sink=lambda b,c:saved.append((b,c)))
  self.assertEqual(saved,[]);self.assertEqual(context.transport_diagnostic(),{'origin':'oneclick','phase':'exit','curlCode':28,'httpStatus':None})
 def test_sink_failure_refuses_and_retains_status(self):
  def bad(_b,_c):raise ValueError('PRIVATE')
  with self.assertRaises(ValueError):self.run_response(sink=bad)
  self.assertEqual(context.transport_diagnostic(),{'origin':'oneclick','phase':'response-sink','curlCode':0,'httpStatus':201})
 def test_validation_failure_replaces_older_response_diagnostic(self):
  self.run_response()
  with self.assertRaises(ValueError):context.curl_request(urllib.request.Request('https://evil.invalid'))
  self.assertEqual(context.transport_diagnostic(),{'origin':None,'phase':'request-validation','curlCode':None,'httpStatus':None})
if __name__=='__main__':unittest.main()
