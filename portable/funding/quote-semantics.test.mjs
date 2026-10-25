import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateNativeFundingQuote} from './quote-semantics.mjs';
function fixture() {
  const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const sha=b=>createHash('sha256').update(b).digest();
  function addr(prefix) {
    const p=Buffer.concat([Buffer.from(prefix),Buffer.alloc(20)]),raw=Buffer.concat([p,sha(sha(p)).subarray(0,4)]);
    let n=BigInt('0x'+raw.toString('hex')),s='';while(n){s=alphabet[Number(n%58n)]+s;n/=58n;}return s;
  }
  const now=Date.parse('2030-01-01T00:00:00.000Z'),zec=addr([0x1c,0xb8]),ltc=addr([0x30]);
  const request={dry:false,swapType:'EXACT_OUTPUT',slippageTolerance:100,originAsset:'nep141:zec.omft.near',depositType:'ORIGIN_CHAIN',destinationAsset:'nep141:ltc.omft.near',amount:'2000000',refundTo:zec,refundType:'ORIGIN_CHAIN',recipient:ltc,recipientType:'DESTINATION_CHAIN',deadline:new Date(now+3600000).toISOString()};
  const response={quoteRequest:{...request},quote:{depositAddress:zec,amountIn:'1000000',minAmountIn:'1000000',amountInFormatted:'0.01',amountInUsd:'1',amountOut:'2000000',minAmountOut:'2000000',amountOutFormatted:'0.02',amountOutUsd:'2',deadline:new Date(now+1800000).toISOString(),timeWhenInactive:new Date(now+1700000).toISOString(),timeEstimate:60,refundFee:'1000',withdrawFee:'1000'},timestamp:new Date(now).toISOString(),correlationId:'synthetic_nonpayable_fixture',signature:'invalid-synthetic-signature'};
  const policy={expectedRequest:request,receiverBinding:{recipientLtc:ltc,refundZec:zec},maxTotalInputZatoshis:'1100000',maxZecSenderFeeZatoshis:'100000',maxRefundFeeZatoshis:'1000',maxWithdrawFeeLitoshis:'1000',minimumOutLitoshis:'2000000',depositConfirmationBudgetMs:600000,safetyMarginMs:120000};
  return {response,policy,clock:{nowMs:now,requestStartedAtMs:now}};
}
test('well-shaped synthetic semantics still require the production pinned signature',()=>{
  const {response,policy,clock}=fixture();assert.deepEqual(validateNativeFundingQuote(JSON.stringify(response),policy,clock),{decision:'refused',code:'signature-refused'});
});
const cases=[
 ['request echo',f=>f.response.quoteRequest.deadline='2030-01-01T02:00:00.000Z','request-mismatch'],
 ['route',f=>f.policy.expectedRequest.originAsset='other-chain','unsupported-route'],
 ['owned receiver binding',f=>f.policy.receiverBinding.recipientLtc+='x','receiver-mismatch'],
 ['checksum',f=>f.response.quote.depositAddress=f.response.quote.depositAddress.slice(0,-1)+'1','invalid-address'],
 ['unified is unsupported',f=>f.response.quote.depositAddress='u1synthetic','unsupported-address-format'],
 ['memo',f=>f.response.quote.depositMemo='12','unsupported-memo'],
 ['extra fee',f=>f.response.quoteRequest.appFees=[{fee:1}],'unsupported-fees'],
 ['unknown route data',f=>f.response.quoteRequest.depositMode='MEMO','unsupported-schema'],
 ['cap including sender fee',f=>f.policy.maxTotalInputZatoshis='1099999','amount-cap'],
 ['negative amount',f=>f.response.quote.amountIn='-1','invalid-amount'],
 ['exponent',f=>f.response.quote.amountIn='1e6','invalid-amount'],
 ['precision',f=>f.response.quote.amountOutFormatted='0.020000001','invalid-formatted-amount'],
 ['exact output',f=>f.response.quote.minAmountOut='1999999','amount-mismatch'],
 ['extended returned expiry',f=>f.response.quote.deadline='2030-01-02T00:00:00.000Z','unsafe-expiry'],
 ['too short expiry',f=>f.response.quote.deadline='2030-01-01T00:01:00.000Z','unsafe-expiry'],
 ['stale timestamp',f=>f.response.timestamp='2029-01-01T00:00:00.000Z','stale-quote'],
 ['clock rollback',f=>f.clock.nowMs--,'invalid-clock'],
 ['invalid date rollover',f=>f.response.timestamp='2030-02-31T00:00:00.000Z','invalid-time'],
 ['missing fee is unknown',f=>delete f.response.quote.refundFee,'unknown-fees'],
 ['minimum policy required',f=>delete f.policy.minimumOutLitoshis,'invalid-amount'],
 ['minimum exceeds fixed output',f=>f.policy.minimumOutLitoshis='2000001','invalid-policy'],
 ['confirmation budget required',f=>delete f.policy.depositConfirmationBudgetMs,'invalid-policy'],
 ['negative estimate',f=>f.response.quote.timeEstimate=-1,'invalid-estimate'],
 ['outer settlement status unsupported',f=>f.response.status='SUCCESS','unsupported-schema']
];
for(const [name,change,code]of cases)test(name,()=>{const f=fixture();change(f);assert.deepEqual(validateNativeFundingQuote(JSON.stringify(f.response),f.policy,f.clock),{decision:'refused',code});});
export {fixture};
