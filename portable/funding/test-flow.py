# SPDX-License-Identifier: MIT
import importlib.util,pathlib,unittest
p=pathlib.Path(__file__).parent/'near_fund/flow.py';s=importlib.util.spec_from_file_location('fundflow',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def pending(accept,seconds=600):return {'incoming':{'swapState':'PENDING_DEPOSIT','acceptNewDeposit':accept,'secondsRemaining':seconds,'depositAddress':'t1old'},'payment':{}}
def credited():return {'incoming':{'swapState':'SUCCESS'},'payment':{'invoiceLinkedAndCreditIncreaseObserved':True,'invoiceId':'owned','accountCredit':{'state':'known'}}}
class Clock:
 def __init__(self,ticks):self.t=0;self.ticks=ticks
 def __call__(self):
  self.t+=1
  if self.t>self.ticks:return 10**6
  return self.t
class Tests(unittest.TestCase):
 def run_flow(self,states,existing=False,complete=lambda _:{'activated':True},ticks=100):
  calls=[];events=[];retired=[];states=iter(states)
  def run(c,sha=None):
   calls.append((c,sha))
   if c=='status':return next(states)
   if c=='prepare-payment':return {'paymentUSDCUnits':2000000,'estimatedMaximumGasWei':'123','planSha256':'a'*64}
   if c=='new':return {'depositAddress':'t1new%d'%sum(x=='new' for x,_ in calls)}
   return {}
  try:result=m.fund(run,lambda:None,complete,retired.append,events.append,existing=existing,sleep=lambda _:None,clock=Clock(ticks))
  except ValueError as e:result=e
  return result,[c for c,_ in calls],[e for e in events if e['phase']=='deposit'],retired
 def test_complete_one_quote_one_send_after_incoming(self):
  r,calls,deposits,_=self.run_flow([pending(True),{'incoming':{'swapState':'SUCCESS','incomingUSDCObserved':True},'payment':{}},credited()])
  self.assertEqual(r,{'activated':True});self.assertEqual(calls.count('new'),1);self.assertEqual(calls.count('send-reviewed'),1);self.assertEqual(len(deposits),1)
 def test_ambiguous_send_is_not_retried(self):
  calls=[]
  def run(c,sha=None):
   calls.append(c)
   if c=='status':return {'incoming':{'swapState':'SUCCESS','incomingUSDCObserved':True},'payment':{}}
   if c=='prepare-payment':return {'paymentUSDCUnits':2000000,'estimatedMaximumGasWei':'1','planSha256':'a'*64}
   if c=='send-reviewed':raise ValueError('unknown')
   return {}
  with self.assertRaises(ValueError):m.fund(run,lambda:None,lambda _:self.fail('complete'),lambda _:self.fail('retire'),lambda _:None,existing=True,sleep=lambda _:None)
  self.assertEqual(calls.count('send-reviewed'),1)
 def test_resumed_open_quote_is_shown_without_requote(self):
  r,calls,deposits,retired=self.run_flow([pending(True)]*3,existing=True,ticks=3)
  self.assertIsInstance(r,ValueError);self.assertNotIn('new',calls);self.assertEqual([d['depositAddress'] for d in deposits],['t1old']);self.assertEqual(retired,[])
 def test_closing_quote_is_watched_not_replaced(self):
  r,calls,deposits,retired=self.run_flow([pending(False,300)]*3,existing=True,ticks=3)
  self.assertIsInstance(r,ValueError);self.assertNotIn('new',calls);self.assertEqual(deposits,[]);self.assertEqual(retired,[])
 def test_expired_quote_retired_once_and_replaced(self):
  r,calls,deposits,retired=self.run_flow([pending(False,0),pending(True),pending(True)],existing=True,ticks=3)
  self.assertEqual(retired,['expired']);self.assertEqual(calls.count('new'),1);self.assertEqual([d['depositAddress'] for d in deposits],['t1new1'])
 def test_replenished_attempt_is_followed_by_fresh_quote(self):
  done=[]
  r,calls,deposits,_=self.run_flow([credited(),pending(True),pending(True)],existing=True,complete=lambda p:done.append(p['invoiceId']),ticks=3)
  self.assertEqual(done,['owned']);self.assertEqual(calls.count('new'),1);self.assertEqual([d['depositAddress'] for d in deposits],['t1new1'])
 def test_refunded_requires_review(self):
  r,calls,_,retired=self.run_flow([{'incoming':{'swapState':'REFUNDED'},'payment':{}}],existing=True)
  self.assertIsInstance(r,ValueError);self.assertNotIn('new',calls);self.assertEqual(retired,[])
if __name__=='__main__':unittest.main()
