// Pure arithmetic over a trusted provider contract. No provider policy is
// admitted by default; request bytes are never treated as token accounting.
const ROUTE = 'https://api.ppq.ai/private/v1/chat/completions';
const MODEL = 'private/gpt-oss-120b';
const SEALED_MODEL = 'gpt-oss-120b';
const LIMIT = 9223372036854775807n;
const refused = reason => { throw Object.assign(new Error(reason), {code:'charge-bound-refused'}); };
const require = (value, reason) => { if (!value) refused(reason); };
const integer = value => Number.isSafeInteger(value) && value > 0;
const price = value => {
  require(typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value), 'Unknown or invalid token price');
  const n=BigInt(value); require(n<=LIMIT,'Price exceeds ledger range');return n;
};

/** policy is broker configuration, NEVER request data or fetched model metadata.
 * Its ceilings cover all provider-added template/system/tool tokens and all
 * billed output (reasoning included). Source evidence and tariff admission
 * require external review; this function checks the contract, not its truth.
 */
export function deriveTrustedChargeBound({request,policy,nowMs}) {
  require(policy && typeof policy==='object' && !Array.isArray(policy),'Missing trusted charge policy');
  require(policy.endpoint===ROUTE && policy.externalModel===MODEL && policy.sealedModel===SEALED_MODEL,'Unknown route');
  require(request?.model===MODEL,'Unknown request model');
  require(Number.isSafeInteger(nowMs) && Number.isSafeInteger(policy.validFromMs) && Number.isSafeInteger(policy.validUntilMs) && policy.validFromMs>=0 && policy.validUntilMs>policy.validFromMs && nowMs>=policy.validFromMs && nowMs<policy.validUntilMs,'Policy is not current');
  require(typeof policy.evidenceId==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(policy.evidenceId),'Missing reviewed contract evidence');
  require(policy.billing==='input-output-tokens-only','Unknown additional charges');
  require(typeof policy.ledgerUnit==='string' && /^[a-zA-Z0-9_-]{1,64}$/.test(policy.ledgerUnit),'Unknown ledger unit');
  require(integer(policy.maxBillableInputTokens),'Unknown input ceiling');
  require(integer(policy.maxRequestedOutputTokens) && integer(request.max_tokens) && request.max_tokens<=policy.maxRequestedOutputTokens,'Unknown request output bound');
  const effort=request.reasoning_effort===undefined?'default':request.reasoning_effort;
  require(typeof effort==='string' && ['default','none','minimal','low','medium','high'].includes(effort) && Array.isArray(policy.reasoningEfforts) && policy.reasoningEfforts.includes(effort),'Unreviewed reasoning mode');
  let outputTokens;
  if(policy.outputBound==='request-max-includes-all-billed-reasoning') {
    outputTokens=request.max_tokens;
  } else if(policy.outputBound==='provider-total-output-ceiling') {
    require(integer(policy.maxBillableOutputTokens) && policy.maxRequestedOutputTokens<=policy.maxBillableOutputTokens,'Unknown provider output ceiling');
    outputTokens=policy.maxBillableOutputTokens;
  } else refused('Unknown output and reasoning billing contract');
  const inputPrice=price(policy.pricePerInputToken),outputPrice=price(policy.pricePerOutputToken);
  const bound=BigInt(policy.maxBillableInputTokens)*inputPrice+BigInt(outputTokens)*outputPrice;
  require(bound>0n && bound<=LIMIT,'Charge exceeds ledger range');
  return Object.freeze({bound:bound.toString(),inputTokens:policy.maxBillableInputTokens,outputTokens,pricePerInputToken:inputPrice.toString(),pricePerOutputToken:outputPrice.toString(),ledgerUnit:policy.ledgerUnit,evidenceId:policy.evidenceId});
}
