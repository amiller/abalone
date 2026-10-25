import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deriveTrustedChargeBound as derive} from './charge-bound.mjs';
// Synthetic reviewed-contract inputs exercise the public API; these are not
// claims about the current PPQ tariff/output contract and are not installed.
const fixture=()=>({nowMs:100,request:{model:'private/gpt-oss-120b',max_tokens:10},policy:{endpoint:'https://api.ppq.ai/private/v1/chat/completions',externalModel:'private/gpt-oss-120b',sealedModel:'gpt-oss-120b',validFromMs:90,validUntilMs:110,evidenceId:'synthetic-contract',billing:'input-output-tokens-only',ledgerUnit:'synthetic-unit',maxBillableInputTokens:131072,maxRequestedOutputTokens:100,reasoningEfforts:['default','low'],outputBound:'request-max-includes-all-billed-reasoning',pricePerInputToken:'2',pricePerOutputToken:'3'}});
test('reserves full trusted input ceiling independently of serialized size',()=>{
 const f=fixture(),small=derive(f);f.request.messages=[{role:'user',content:'x'.repeat(100000)}];assert.deepEqual(derive(f),small);assert.equal(small.bound,'262174');
});
test('provider total output ceiling includes hidden reasoning, independent of requested cap',()=>{
 const f=fixture();Object.assign(f.policy,{outputBound:'provider-total-output-ceiling',maxBillableOutputTokens:200});assert.equal(derive(f).bound,'262744');f.request.max_tokens=1;assert.equal(derive(f).outputTokens,200);
});
test('policy ceiling is deliberately conservative, not context minus caller output',()=>{const f=fixture();f.request.max_tokens=100;assert.equal(derive(f).inputTokens,131072);assert.equal(derive(f).bound,'262444');});
for(const [name,change]of [
 ['no policy',f=>delete f.policy],['unknown route',f=>f.policy.endpoint+='?other'],['model mismatch',f=>f.request.model='other'],
 ['unknown input ceiling',f=>delete f.policy.maxBillableInputTokens],['fractional ceiling',f=>f.policy.maxBillableInputTokens=1.5],
 ['unknown output contract',f=>delete f.policy.outputBound],['unknown price',f=>delete f.policy.pricePerOutputToken],['zero price',f=>f.policy.pricePerInputToken='0'],
 ['extra fees',f=>f.policy.billing='plus-request-fee'],['unreviewed reasoning',f=>f.request.reasoning_effort='high'],
 ['missing cap',f=>delete f.request.max_tokens],['over cap',f=>f.request.max_tokens=101],['stale tariff',f=>f.nowMs=110],['clock before validity',f=>f.nowMs=89],
 ['no evidence',f=>delete f.policy.evidenceId],['overflow',f=>f.policy.pricePerInputToken='9223372036854775807'],['unknown units',f=>delete f.policy.ledgerUnit],
 ['unknown hidden ceiling',f=>f.policy.outputBound='provider-total-output-ceiling']
])test(name,()=>{const f=fixture();change(f);assert.throws(()=>derive(f),{code:'charge-bound-refused'});});
