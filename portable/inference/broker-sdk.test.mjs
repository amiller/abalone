// Real Unix socket and durable journal; synthetic host capability, no provider.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import {dirname} from 'node:path';
import {createInferenceBroker} from './broker.mjs';import {inferenceSocketFetch} from './client.mjs';
const tick=ms=>new Promise(r=>setTimeout(r,ms));
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
const policy={endpoint:'https://api.ppq.ai/private/v1/chat/completions',externalModel:'private/gpt-oss-120b',sealedModel:'gpt-oss-120b',validFromMs:90,validUntilMs:110,evidenceId:'synthetic_contract',billing:'input-output-tokens-only',ledgerUnit:'synthetic',maxBillableInputTokens:10,maxRequestedOutputTokens:5,reasoningEfforts:['default'],outputBound:'request-max-includes-all-billed-reasoning',settlementUsage:'openai-prompt-completion-all-billed-tokens',pricePerInputToken:'1',pricePerOutputToken:'1'};
const body=()=>({model:'private/gpt-oss-120b',stream:true,max_tokens:5,messages:[{role:'user',content:'synthetic'}],tools:[],tool_choice:'auto',parallel_tool_calls:true});
async function setup(extra={}){
 const dir=await mkdtemp(join(tmpdir(),'broker-sdk-'));await mkdir(join(dir,'state'),{mode:0o700});await mkdir(join(dir,'sockets'),{mode:0o700});
 const events={created:0,closed:0,posts:0,permits:0,normalized:[]};let now=100;
 const sdkHostFactory=async trusted=>{
  events.created++;assert.equal(trusted.stateDir,join(dir,'state'));assert.ok(Object.isFrozen(trusted.chargePolicy.reasoningEfforts));
  let prepared,closed=false;const handle=Object.freeze({token:'00000000-0000-0000-0000-000000000000'});
  const host={async prepare(request){events.normalized.push(request.body);prepared={request,handle,requestDigest:extra.badDigest?'0'.repeat(64):digest(request.body),documentDigest:'a'.repeat(64)};if(extra.onPrepare)await extra.onPrepare({request,trusted,events});return prepared;},async post({handle:h,signal}){
   assert.equal(h,handle);assert.equal(signal.aborted,false);const details={logicalId:prepared.request.logicalId,requestDigest:prepared.requestDigest,admissionDigest:prepared.documentDigest,bound:'15',policyEvidenceId:policy.evidenceId};
   if(extra.beforePermit)await extra.beforePermit({trusted,events});
   events.permits++;const permission=await trusted.permitRawPost({...details,...extra.permitChanges},signal);
   assert.equal(permission.allowed,true);if(signal.aborted)throw Error('aborted');
   if(extra.repeatPermit)await assert.rejects(trusted.permitRawPost(details,signal));
   events.posts++;if(extra.afterPost)await extra.afterPost({signal,events});
   const usage=extra.usage !== undefined ? extra.usage : extra.overspend?{prompt_tokens:100,completion_tokens:1}:{prompt_tokens:2,completion_tokens:1};
   return {stream:new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(extra.sse ?? ('data: '+JSON.stringify({usage})+'\n\ndata: [DONE]\n\n')));c.close();}})};
  },async close(){if(!closed){closed=true;events.closed++;if(extra.closeWait)await extra.closeWait();}}};
  if(extra.factoryWait)await extra.factoryWait();return host;
 };
 const options={socketPath:join(dir,'sockets/broker.sock'),stateDir:join(dir,'state'),peerUid:process.getuid(),testingAllowSameUid:true,authorizedBudget:extra.cap??'100',chargePolicy:{...policy,...extra.policyChanges},clock:()=>now,sdkHostFactory,responseIdleTimeoutMs:1000,responseDeadlineMs:2000};
 let broker=createInferenceBroker(options);await broker.start();
 return {dir,events,options,get broker(){return broker;},setNow:v=>{now=v;},async restart(){await broker.stop();broker=createInferenceBroker(options);await broker.start();},async send(id='sdk_request_0000001',request=body(),signal){const r=await inferenceSocketFetch(options.socketPath,{requestId:id,signal,timeoutMs:5000})(undefined,{body:JSON.stringify(request)});await r.text();return r;},async cleanup(){await broker.stop();await rm(dir,{recursive:true,force:true});}};
}
async function settled(f){for(let i=0;i<100&&f.events.created!==f.events.closed;i++)await tick(10);assert.equal(f.events.created,f.events.closed);}

test('constructor rejects mixed modes and missing factory',()=>{assert.throws(()=>createInferenceBroker({socketPath:'/tmp/x',stateDir:'/tmp/y',peerUid:process.getuid(),sdkHostFactory:()=>{},transport:{post(){}}}),/mutually exclusive/);});
test('native normalized digest, durable raw permit, repeated permit refusal and settlement',async()=>{const f=await setup({repeatPermit:true});try{await f.send();await settled(f);assert.equal(f.events.posts,1);assert.equal(f.events.permits,1);assert.equal('tools' in f.events.normalized[0],false);assert.equal('tool_choice' in f.events.normalized[0],false);assert.equal('parallel_tool_calls' in f.events.normalized[0],false);const s=await f.broker.journalRef.snapshot();assert.equal(s.spent,'3');assert.equal(s.outstanding,'0');}finally{await f.cleanup();}});
test('digest mismatch refuses before reserve',async()=>{const f=await setup({badDigest:true});try{await assert.rejects(f.send());await settled(f);assert.equal(f.events.posts,0);assert.equal((await f.broker.journalRef.snapshot()).outstanding,'0');}finally{await f.cleanup();}});
test('reserve write failure prevents POST and closes host',async()=>{const f=await setup();try{f.broker.journalRef.reserve=async()=>{throw Error('synthetic disk failure');};await assert.rejects(f.send());await settled(f);assert.equal(f.events.posts,0);}finally{await f.cleanup();}});
test('raw permit requires exact binding and unresolved journal entry',async()=>{for(const changes of [{logicalId:'different_request_001'},{requestDigest:'b'.repeat(64)},{admissionDigest:'b'.repeat(64)},{bound:'14'},{policyEvidenceId:'other'}]){const f=await setup({permitChanges:changes});try{await assert.rejects(f.send());await settled(f);assert.equal(f.events.posts,0);assert.equal((await f.broker.journalRef.snapshot()).spent,'15');}finally{await f.cleanup();}}});
test('resolved journal entry cannot grant a permit',async()=>{let f;f=await setup({beforePermit:async()=>f.broker.journalRef.settle({id:'sdk_request_0000001',amount:'0'})});try{await assert.rejects(f.send());await settled(f);assert.equal(f.events.posts,0);}finally{await f.cleanup();}});
test('tariff expiry while permit awaits journal read refuses POST',async()=>{const f=await setup();try{const snapshot=f.broker.journalRef.snapshot.bind(f.broker.journalRef);f.broker.journalRef.snapshot=async()=>{const s=await snapshot();f.setNow(110);return s;};await assert.rejects(f.send());await settled(f);assert.equal(f.events.posts,0);assert.equal((await snapshot()).spent,'15');}finally{await f.cleanup();}});
test('cancel during permit read cannot revive late permission',async()=>{const f=await setup();let release,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);try{const snapshot=f.broker.journalRef.snapshot.bind(f.broker.journalRef);f.broker.journalRef.snapshot=async()=>{const s=await snapshot();entered();await gate;return s;};const ac=new AbortController();const request=f.send('sdk_request_0000001',body(),ac.signal);const rejected=assert.rejects(request);await ready;ac.abort();await rejected;await settled(f);release();await tick(30);assert.equal(f.events.posts,0);assert.equal((await snapshot()).spent,'15');}finally{release?.();await f.cleanup();}});
test('permit read stalled past whole request deadline cannot POST',async()=>{const f=await setup();let release;try{const snapshot=f.broker.journalRef.snapshot.bind(f.broker.journalRef);const gate=new Promise(r=>release=r);f.broker.journalRef.snapshot=async()=>{const s=await snapshot();await gate;return s;};await assert.rejects(f.send());await settled(f);release();await tick(30);assert.equal(f.events.posts,0);assert.equal((await snapshot()).spent,'15');}finally{release?.();await f.cleanup();}});
test('duplicate including after restart cannot POST again',async()=>{const f=await setup();try{await f.send();await assert.rejects(f.send());await f.restart();await assert.rejects(f.send());await settled(f);assert.equal(f.events.posts,1);assert.equal((await f.broker.journalRef.snapshot()).spent,'3');}finally{await f.cleanup();}});
test('concurrent requests cannot exceed durable cap',async()=>{let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);const f=await setup({cap:'15',afterPost:async()=>{entered();await gate;}});try{const first=f.send('sdk_concurrent_00001');await ready;await assert.rejects(f.send('sdk_concurrent_00002'));release();await first;await settled(f);assert.equal(f.events.posts,1);assert.equal((await f.broker.journalRef.snapshot()).spent,'3');}finally{release?.();await f.cleanup();}});
test('overspend remains truthful and suspends subsequent requests',async()=>{const f=await setup({overspend:true});try{await f.send();await assert.rejects(f.send('sdk_request_0000002'));assert.equal(f.events.posts,1);const s=await f.broker.journalRef.snapshot();assert.equal(s.spent,'101');assert.equal(s.discrepancies.length,1);}finally{await f.cleanup();}});
test('stop drains late factory and its close before releasing ownership',async()=>{let releaseFactory,releaseClose;const factoryGate=new Promise(r=>releaseFactory=r),closeGate=new Promise(r=>releaseClose=r);const f=await setup({factoryWait:()=>factoryGate,closeWait:()=>closeGate});try{const request=f.send();const rejected=assert.rejects(request);while(!f.events.created)await tick(10);let stopped=false;const shared=f.broker.stop();assert.equal(f.broker.stop(),shared);const stop=shared.then(()=>{stopped=true;});await rejected;await tick(20);assert.equal(stopped,false);releaseFactory();await tick(20);assert.equal(stopped,false);releaseClose();await stop;assert.equal(f.broker.stop(),shared);assert.equal(f.events.closed,1);assert.equal(f.events.posts,0);}finally{releaseFactory?.();releaseClose?.();await f.cleanup();}});

test('failed host cleanup retains exclusive state ownership until process exit',async()=>{
 const source=await readFile(new URL(import.meta.url),'utf8');
 const script=source.slice(0,source.indexOf("test('constructor"))+`
const f=await setup({closeWait:async()=>{throw Error('synthetic cleanup failure');}});console.log(JSON.stringify({dir:f.dir}));await f.send();await settled(f);await tick(20);const stopped=f.broker.stop();assert.equal(f.broker.stop(),stopped);await assert.rejects(stopped,/cleanup failed/);assert.equal(f.broker.stop(),stopped);await assert.rejects(f.broker.stop(),/cleanup failed/);const other=createInferenceBroker({...f.options,socketPath:f.dir+'/sockets/second.sock'});await assert.rejects(other.start(),/another live broker/);console.log('CLEANUP_LOCK_RETAINED');process.exit(0);`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{cwd:dirname(fileURLToPath(import.meta.url)),stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);const timeout=setTimeout(()=>child.kill('SIGKILL'),10000);try{const code=await new Promise(r=>child.once('exit',r));assert.equal(code,0,errors);assert.match(output,/CLEANUP_LOCK_RETAINED/);}finally{clearTimeout(timeout);const line=output.split('\n').find(l=>l.startsWith('{"dir"'));if(line)await rm(JSON.parse(line).dir,{recursive:true,force:true});}
});

test('invalid non-null usage consumes full bound, including after earlier valid usage',async()=>{
 const invalid=[{prompt_tokens:-2,completion_tokens:3},{prompt_tokens:2,completion_tokens:-1},{prompt_tokens:Number.MAX_SAFE_INTEGER+1,completion_tokens:1},{prompt_tokens:2},{completion_tokens:1},{prompt_tokens:'2',completion_tokens:1},{prompt_tokens:2,completion_tokens:null},false,0,[],{}];
 for(const usage of invalid){for(const prior of [false,true]){const frames=[...(prior?[{usage:{prompt_tokens:2,completion_tokens:1}}]:[]),{usage}];const f=await setup({sse:frames.map(frame=>'data: '+JSON.stringify(frame)+'\n\n').join('')+'data: [DONE]\n\n'});try{await f.send();await settled(f);const s=await f.broker.journalRef.snapshot();assert.equal(s.spent,'15',JSON.stringify({usage,prior}));assert.equal(s.outstanding,'0');assert.equal(s.discrepancies.length,0);}finally{await f.cleanup();}}}
});
test('invalid usage stays unknown after later valid usage; null remains legitimate',async()=>{
 for(const [frames,spent]of [[[null,{prompt_tokens:2,completion_tokens:1},null],'3'],[[{prompt_tokens:-2,completion_tokens:3},{prompt_tokens:2,completion_tokens:1}],'15']]){const f=await setup({sse:frames.map(usage=>'data: '+JSON.stringify({usage})+'\n\n').join('')+'data: [DONE]\n\n'});try{await f.send();assert.equal((await f.broker.journalRef.snapshot()).spent,spent);}finally{await f.cleanup();}}
});
test('malformed or incomplete trailing SSE cannot reuse earlier refundable usage',async()=>{for(const tail of ['data: {bad}\n\n','data: {"usage":']){const f=await setup({sse:'data: {"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n'+tail});try{await f.send();assert.equal((await f.broker.journalRef.snapshot()).spent,'15');}finally{await f.cleanup();}}});
test('usage refunds require explicit trusted all-billed-token semantics for either ceiling',async()=>{
 for(const outputBound of ['request-max-includes-all-billed-reasoning','provider-total-output-ceiling'])for(const settlementUsage of [undefined,'unknown-semantics','openai-prompt-completion-all-billed-tokens']){const f=await setup({policyChanges:{outputBound,maxBillableOutputTokens:5,settlementUsage}});try{await f.send();const s=await f.broker.journalRef.snapshot();assert.equal(s.spent,settlementUsage==='openai-prompt-completion-all-billed-tokens'?'3':'15');}finally{await f.cleanup();}}
});

test('a restarted broker instance gets a new shared stop cycle',async()=>{const f=await setup();try{await f.send();const first=f.broker.stop();await first;await f.broker.start();await f.send('sdk_restart_cycle_002');const second=f.broker.stop();assert.notEqual(second,first);assert.equal(f.broker.stop(),second);await second;assert.equal(f.events.created,f.events.closed);assert.equal(f.events.posts,2);}finally{await f.cleanup();}});


test('synchronous abort listener reenters the same pending stop drain',async()=>{
 let releaseClose,entered,reentrant;const closeGate=new Promise(r=>releaseClose=r),ready=new Promise(r=>entered=r);
 const f=await setup({onPrepare:async({trusted})=>{trusted.signal.addEventListener('abort',()=>{reentrant=f.broker.stop();},{once:true});entered();await new Promise(()=>{});},closeWait:()=>closeGate});
 try{
  const request=f.send(),rejected=assert.rejects(request);await ready;
  const first=f.broker.stop();let stopped=false;first.then(()=>{stopped=true;});await rejected;await tick(20);
  assert.equal(reentrant,first);assert.equal(stopped,false);assert.equal(f.events.closed,1);
  releaseClose();await first;assert.equal(f.broker.stop(),first);assert.equal(f.events.posts,0);
 }finally{releaseClose?.();await f.cleanup();}
});
