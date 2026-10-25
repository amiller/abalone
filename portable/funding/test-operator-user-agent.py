# SPDX-License-Identifier: MIT
import importlib.util,json,pathlib,sys,unittest
from unittest.mock import patch
P=pathlib.Path(__file__).parent/'near_fund';sys.path.insert(0,str(P))
import context,payment
class Client:
 def __init__(self):self.requests=[]
 def open(self,request,timeout=None):self.requests.append(request);return context.Response(b'{}',200)
class Tests(unittest.TestCase):
 def test_new_account_user_agent_on_both_auth_origins(self):
  config={'organizationId':'a'*36,'session':{'access_token':'synthetic','refresh_token':'synthetic-refresh'},'userAgent':'dsmack-portable-account/1.0'};client=Client()
  with patch.object(context,'_CONFIG',config),patch.object(context,'client',client),patch.object(payment,'client',client):
   context.call('/v1/organizations/'+config['organizationId']+'/usage/balance','synthetic');payment.cloud('/api/pingpay/payment')
  self.assertEqual([r.get_header('User-agent') for r in client.requests],['dsmack-portable-account/1.0']*2)
 def test_legacy_dashboard_default_preserved(self):
  client=Client()
  with patch.object(context,'_CONFIG',{'session':{'access_token':'synthetic','refresh_token':'synthetic'}}),patch.object(payment,'client',client):payment.cloud('/api/pingpay/payment')
  self.assertEqual(client.requests[0].get_header('User-agent'),'dsmack-incoming-funding/1.0')
if __name__=='__main__':unittest.main()
