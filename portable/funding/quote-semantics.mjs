// Narrow native ZEC -> owned LTC quote policy. No network, wallet or signing.
import { createHash } from 'node:crypto';
import { verifyOneClickQuoteSignature } from './quote-signature.mjs';
const REQUEST = ['dry','swapType','slippageTolerance','originAsset','depositType','destinationAsset','amount','refundTo','refundType','recipient','recipientType','deadline'];
const QUOTE = ['depositAddress','depositMemo','amountIn','amountInFormatted','amountInUsd','minAmountIn','amountOut','amountOutFormatted','amountOutUsd','minAmountOut','deadline','timeWhenInactive','timeEstimate','refundFee','withdrawFee'];
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const fail = code => { throw new Error(code); };
const check = (ok, code) => { if (!ok) fail(code); };
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value, allowed) { check(object(value) && Object.keys(value).every(key => allowed.includes(key)), 'unsupported-schema'); }
function units(value, zero = false) {
  check(typeof value === 'string' && /^(0|[1-9][0-9]{0,17})$/.test(value), 'invalid-amount');
  const n = BigInt(value); check(zero || n > 0n, 'invalid-amount'); return n;
}
function time(value) {
  check(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value), 'invalid-time');
  const n = Date.parse(value);
  check(Number.isFinite(n) && new Date(n).toISOString() === (value.length === 20 ? value.slice(0,-1)+'.000Z' : value), 'invalid-time');
  return n;
}
function address(text, chain) {
  check(typeof text === 'string' && text.length <= 64, 'invalid-address');
  check(chain === 'zec' ? /^(t1|t3)/.test(text) : text.startsWith('L'), 'unsupported-address-format');
  let n = 0n;
  for (const char of text) { const d = ALPHABET.indexOf(char); check(d >= 0, 'invalid-address'); n = n*58n+BigInt(d); }
  let hex=n.toString(16);if(hex.length%2)hex='0'+hex;
  const raw=Buffer.concat([Buffer.alloc(text.match(/^1*/)[0].length),n===0n?Buffer.alloc(0):Buffer.from(hex,'hex')]);
  const payload=raw.subarray(0,-4), sha=data=>createHash('sha256').update(data).digest();
  check(raw.length >= 5 && sha(sha(payload)).subarray(0,4).equals(raw.subarray(-4)), 'invalid-address');
  check(chain === 'zec' ? payload.length===22 && payload[0]===0x1c && [0xb8,0xbd].includes(payload[1]) : payload.length===21 && payload[0]===0x30, 'unsupported-address-format');
}
function formatted(text, amount) {
  check(typeof text==='string' && /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,8})?$/.test(text), 'invalid-formatted-amount');
  const [whole,fraction='']=text.split('.');check(BigInt(whole)*100000000n+BigInt(fraction.padEnd(8,'0'))===amount,'amount-mismatch');
}
function usd(text) {
  // Provider valuation is checked for shape only; authorization uses asset units.
  check(typeof text==='string' && /^(0|[1-9][0-9]{0,12})(\.[0-9]{1,18})?$/.test(text), 'invalid-valuation');
}

/** Trusted policy.receiverBinding must come from durable wallet ownership checks,
 * never the quote/caller. This function checks equality, not possession of keys.
 * Result authenticates a projection and checks semantics; TLS provenance,
 * durable issuance, user payment approval and account credit remain outside it.
 */
export function validateNativeFundingQuote(rawJson, policy, clock) {
  try {
    check(typeof rawJson==='string' && Buffer.byteLength(rawJson,'utf8')<=131072,'invalid-input');
    keys(policy,['expectedRequest','receiverBinding','maxTotalInputZatoshis','maxZecSenderFeeZatoshis','maxRefundFeeZatoshis','maxWithdrawFeeLitoshis','minimumOutLitoshis','depositConfirmationBudgetMs','safetyMarginMs']);
    const expected=policy.expectedRequest;
    keys(expected,REQUEST);check(Object.keys(expected).length===REQUEST.length,'invalid-policy');
    check(expected.dry===false && expected.swapType==='EXACT_OUTPUT' && expected.originAsset==='nep141:zec.omft.near' && expected.destinationAsset==='nep141:ltc.omft.near' && expected.depositType==='ORIGIN_CHAIN' && expected.refundType==='ORIGIN_CHAIN' && expected.recipientType==='DESTINATION_CHAIN','unsupported-route');
    check(Number.isSafeInteger(expected.slippageTolerance) && expected.slippageTolerance>=0 && expected.slippageTolerance<=100,'invalid-policy');
    const output=units(expected.amount), minimumOutput=units(policy.minimumOutLitoshis), requestedDeadline=time(expected.deadline);
    check(minimumOutput<=output,'invalid-policy');
    check(Number.isSafeInteger(policy.depositConfirmationBudgetMs) && policy.depositConfirmationBudgetMs>0 && policy.depositConfirmationBudgetMs<=86400000 && Number.isSafeInteger(policy.safetyMarginMs) && policy.safetyMarginMs>=120000 && policy.safetyMarginMs<=86400000,'invalid-policy');
    keys(policy.receiverBinding,['recipientLtc','refundZec']);
    check(expected.recipient===policy.receiverBinding.recipientLtc && expected.refundTo===policy.receiverBinding.refundZec,'receiver-mismatch');
    address(expected.recipient,'ltc');address(expected.refundTo,'zec');
    const cap=units(policy.maxTotalInputZatoshis), senderFee=units(policy.maxZecSenderFeeZatoshis,true), maxRefund=units(policy.maxRefundFeeZatoshis,true), maxWithdraw=units(policy.maxWithdrawFeeLitoshis,true);
    keys(clock,['nowMs','requestStartedAtMs']);
    check(Number.isSafeInteger(clock.nowMs) && Number.isSafeInteger(clock.requestStartedAtMs) && clock.requestStartedAtMs>=0 && clock.nowMs>=clock.requestStartedAtMs && clock.nowMs-clock.requestStartedAtMs<=120000,'invalid-clock');
    const response=JSON.parse(rawJson);keys(response,['correlationId','timestamp','signature','quoteRequest','quote']);
    check(typeof response.correlationId==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(response.correlationId),'invalid-correlation');
    keys(response.quoteRequest,[...REQUEST,'appFees']);
    for(const key of REQUEST)check(response.quoteRequest[key]===expected[key],'request-mismatch');
    if(response.quoteRequest.appFees!==undefined)check(Array.isArray(response.quoteRequest.appFees)&&response.quoteRequest.appFees.length===0,'unsupported-fees');
    const q=response.quote;keys(q,QUOTE);
    const input=units(q.amountIn),minInput=units(q.minAmountIn),actualOut=units(q.amountOut),minOut=units(q.minAmountOut);
    check(minInput<=input && actualOut===output && minOut>=minimumOutput && minOut<=actualOut,'amount-mismatch');
    formatted(q.amountInFormatted,input);formatted(q.amountOutFormatted,actualOut);usd(q.amountInUsd);usd(q.amountOutUsd);
    check(q.refundFee!==undefined && q.withdrawFee!==undefined,'unknown-fees');
    const refundFee=units(q.refundFee,true),withdrawFee=units(q.withdrawFee,true);
    check(input+senderFee<=cap && refundFee<=maxRefund && withdrawFee<=maxWithdraw,'amount-cap');
    address(q.depositAddress,'zec');check(q.depositMemo===undefined || q.depositMemo===null,'unsupported-memo');
    const stamp=time(response.timestamp),deadline=time(q.deadline);
    // Cold-address timing affects UX only, not the fund-loss deadline.
    const inactive=q.timeWhenInactive===undefined ? null : time(q.timeWhenInactive);
    check(Number.isFinite(q.timeEstimate)&&q.timeEstimate>=0&&q.timeEstimate<=3600,'invalid-estimate');
    const now=clock.nowMs,margin=Math.ceil(q.timeEstimate*1000)+policy.depositConfirmationBudgetMs+policy.safetyMarginMs;
    check(stamp>=clock.requestStartedAtMs-30000 && stamp<=now+30000 && now-stamp<=120000,'stale-quote');
    check(deadline<=requestedDeadline && deadline-now>=margin,'unsafe-expiry');
    const signature=verifyOneClickQuoteSignature(rawJson);
    check(signature.authenticated && signature.coverage==='oneclick-0.1.26-issued-projection','signature-refused');
    return { decision:'matches-policy', signatureCoverage:signature.coverage, transportProvenance:'not-evaluated', creditProof:false, coldAddress:inactive===null ? 'unknown' : inactive<=now, responseSha256:createHash('sha256').update(rawJson,'utf8').digest('hex'), instruction:{depositAddress:q.depositAddress,depositMemo:null,inputZatoshis:q.amountIn,outputLitoshis:q.amountOut,deadline:q.deadline}, correlationId:response.correlationId };
  } catch(error) {
    const codes=['invalid-input','unsupported-schema','invalid-policy','unsupported-route','invalid-amount','invalid-time','invalid-address','unsupported-address-format','receiver-mismatch','invalid-clock','invalid-correlation','request-mismatch','unsupported-fees','unknown-fees','invalid-formatted-amount','amount-mismatch','invalid-valuation','amount-cap','unsupported-memo','invalid-estimate','stale-quote','unsafe-expiry','signature-refused'];
    return {decision:'refused',code:codes.includes(error?.message)?error.message:'invalid-input'};
  }
}
