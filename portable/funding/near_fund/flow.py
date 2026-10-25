# SPDX-License-Identifier: MIT
"""Single foreground funding journey using the existing one-attempt CLI contracts."""
import time

def fund(run,prepare_account,complete,retire,emit,existing=False,sleep=time.sleep,clock=time.monotonic):
 """No quote/payment POST is retried. Re-entry reconciles saved IDs only.
 A completed attempt is retired and replaced by a fresh quote; so is a quote whose
 deposit deadline passed with no deposit. Neither address is ever shown again."""
 deadline=clock()+7200;prepare_account();last_progress=None;shown=False
 def quote():
  emit({'phase':'deposit',**run('new')});return True
 if not existing:shown=quote()
 while clock()<deadline:
  result=run('status');incoming=result['incoming'];payment=result['payment']
  if payment.get('invoiceLinkedAndCreditIncreaseObserved') is True:
   receipt=complete(payment)
   if receipt is not None:return receipt
   shown=quote();last_progress=None;continue
  if incoming['swapState']=='PENDING_DEPOSIT' and incoming['acceptNewDeposit'] is not True and incoming['secondsRemaining']<=0:
   retire('expired');shown=quote();last_progress=None;continue
  if not shown and incoming['swapState']=='PENDING_DEPOSIT' and incoming['acceptNewDeposit'] is True:
   emit({'phase':'deposit',**incoming});shown=True
  progress={'phase':'waiting','swapState':incoming['swapState'],'acceptNewDeposit':incoming.get('acceptNewDeposit'),'invoicePaid':payment.get('invoicePaid',False),'accountCredit':payment.get('accountCredit',{'state':'unknown'})}
  progress_key={**progress,'accountCredit':{k:v for k,v in progress['accountCredit'].items() if k!='observedUTC'}}
  if progress_key!=last_progress:emit(progress);last_progress=progress_key
  if incoming['swapState'] in ('FAILED','REFUNDED','INCOMPLETE_DEPOSIT'):raise ValueError('incoming requires review')
  if incoming.get('incomingUSDCObserved') is True and 'transactionHash' not in payment:
   # Any prepare/broadcast ambiguity stops this run; existing intent prevents a new transaction.
   plan=run('prepare-payment');emit({'phase':'payment-plan','paymentUSDCUnits':plan['paymentUSDCUnits'],'estimatedMaximumGasWei':plan['estimatedMaximumGasWei'],'planSha256':plan['planSha256']})
   run('send-reviewed',plan['planSha256'])
  elif payment.get('transactionState')=='failed':raise ValueError('known transaction failed')
  sleep(5)
 raise ValueError('funding observation deadline; retain same attempt')
