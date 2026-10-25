# SPDX-License-Identifier: MIT
"""Operator terminal wording for ~/fund events; the JSON events stay authoritative."""
import datetime,json
import qr
SWAP={'PENDING_DEPOSIT':'waiting for your ZEC','KNOWN_DEPOSIT_TX':'ZEC deposit seen, confirming','PROCESSING':'swapping ZEC to USDC','SUCCESS':'swap complete'}
def usd(nano):return '$%.3f'%(nano/1e9)
def hhmm(iso):return datetime.datetime.fromisoformat(iso).strftime('%H:%M UTC')
def key(k):
 if k is None:return 'Agent key: not issued yet (issued with the first funding)'
 return 'Agent key allowance: %s left (%s used of %s cap)'%(usd(k['limitNanoUSD']-k['usageNanoUSD']),usd(k['usageNanoUSD']),usd(k['limitNanoUSD']))
def render(v):
 phase=v.get('phase');state=v.get('state')
 if phase=='standing':
  last=v['lastFunding']
  return '\n'.join(('Account balance: '+usd(v['account']['remaining']),key(v['key']),'Last funding: '+('+$%s credited, seen %s'%(last['creditUSD'],last['observedUTC'][:16].replace('T',' ')) if last else 'none recorded on this stick')))
 if phase=='deposit':
  safe=int(v['secondsRemaining'])-int(v['requiredRemainingSeconds'])
  return '\n'.join((qr.terminal('zcash:%s?amount=%s'%(v['depositAddress'],v['amountZEC'])),
   'Add $%s of credit: send exactly %s ZEC to'%(v['intendedNEARCreditUSD'],v['amountZEC']),v['depositAddress'],
   'before %s (%d min). This address belongs to this quote only; never reuse it after then.'%(hhmm(v['safeSendBeforeUTC']),safe//60),
   'Ctrl+C stops watching; ~/fund resumes the same quote.'))
 if phase=='waiting':
  text='Pending funding: '+SWAP.get(v['swapState'],v['swapState'].lower())
  if v['swapState']=='PENDING_DEPOSIT' and v['acceptNewDeposit'] is False:text+=' (quote closed to new deposits; a fresh one follows its deadline)'
  return text+('; invoice paid, waiting for credit' if v['invoicePaid'] else '')
 if phase=='payment-plan':return 'USDC arrived; paying the invoice (gas at most %s wei)'%v['estimatedMaximumGasWei']
 if phase=='funded':return 'Funded: +$%s. '%v['creditUSD']+(key(v['key']) if v['key'] else 'Installing the agent key next.')
 if phase=='retired':return {'funded':'Completed funding recorded.','expired':'Previous quote expired unpaid; issuing a fresh one.','unissued':'Discarded an attempt that never showed an address.'}[v['kind']]
 if state=='account-activation':return 'Activating a new NEAR account (0.01 NEAR from the transit wallet)...'
 if state=='account-activated-authenticating':return 'Account active; signing in...'
 if state=='funded-and-service-started':return 'Agent key installed and inference service restarted.'
 if state=='key-limit-set':return key(v['key'])
 if state=='funding-not-set-up':return 'Funding is not set up on this stick: the vault holds no funding wallet. Nothing was quoted or sent.'
 if state in ('unknown','unknown-reconcile-same-attempt'):
  return 'Funding stopped (%s). Nothing was retried.%s%s'%(v.get('reason','unknown'),' Error: '+v['error'] if v.get('error') else '',' Transport: '+json.dumps(v['transportDiagnostic']) if v.get('transportDiagnostic') else '')
 return json.dumps(v)
