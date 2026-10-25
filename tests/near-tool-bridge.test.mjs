// SPDX-License-Identifier: MIT
import test from 'node:test';import assert from 'node:assert/strict';
import {createNearToolBridge,nearToolBridgeDiagnostic} from '../lib/near-tool-bridge.mjs';
const model='synthetic-near-model',url='https://cloud-api.near.ai/v1/chat/completions';
const body=()=>({model,stream:true,max_tokens:1024,messages:[{role:'user',content:'test'}],tools:['read','write','edit','bash'].map(name=>({type:'function',function:{name,parameters:{}}}))});
const init=()=>({method:'POST',headers:{authorization:'Bearer coupon-session','x-inference-request-id':'synthetic_request_0001'},body:JSON.stringify(body())});
function sse(content,{id='test1',finish='stop',delta,done=true}={}) {
 const base={id,object:'chat.completion.chunk',created:1,model};
 return 'data: '+JSON.stringify({...base,choices:[{index:0,delta:delta??{content},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:finish}],usage:{prompt_tokens:4,completion_tokens:3,total_tokens:7}})+'\n\n'+(done?'data: [DONE]\n\n':'');
}
const response=s=>new Response(s,{headers:{'content-type':'text/event-stream','x-inference-id':'inference-1'}});
test('content-only request, namespaced native calls, usage and inference-id preserved',async()=>{
 const requests=[];let count=0;const fetch=createNearToolBridge({profile:{baseUrl:'https://cloud-api.near.ai/v1',model},fetch:async(u,i)=>{requests.push(JSON.parse(i.body));return response(sse('<tool_call>read<arg_path>x</arg_path></tool_call>',{id:'reply'+(++count)}));}});
 const outputs=[];for(let n=0;n<2;n++){const r=await fetch(url,init());assert.equal(r.headers.get('x-inference-id'),'inference-1');outputs.push((await r.text()).split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6))));}
 assert.notEqual(outputs[0][0].choices[0].delta.tool_calls[0].id,outputs[1][0].choices[0].delta.tool_calls[0].id);
 assert.equal(outputs[0][1].choices[0].finish_reason,'tool_calls');assert.equal(outputs[0][2].usage.total_tokens,7);
 for(const b of requests){assert.equal(b.tools,undefined);assert.ok(b.messages.every(m=>Object.keys(m).sort().join()==='content,role'));}
});
test('poisoned native fields, incomplete streams, unknown tools and changing stream id refuse once',async()=>{
 const variants=[sse('',{delta:{tool_calls:[]}}),sse('done',{done:false}),sse('<tool_call>exec<arg_command>id</arg_command></tool_call>'),sse('done').replace('"id":"test1"','"id":"different"')];
 for(const raw of variants){let calls=0;const fetch=createNearToolBridge({profile:{baseUrl:'https://cloud-api.near.ai/v1',model},fetch:async()=>{calls++;return response(raw);}});await assert.rejects(fetch(url,init()),{message:'NEAR tool bridge refused'});assert.equal(calls,1);}
});
test('reused upstream id and expired admission fail without replay',async()=>{
 let calls=0;const fetch=createNearToolBridge({profile:{baseUrl:'https://cloud-api.near.ai/v1',model},fetch:async()=>{calls++;return response(sse('done'));}});await fetch(url,init());await assert.rejects(fetch(url,init()));assert.equal(calls,2);
 let expired=0;const f=createNearToolBridge({profile:{baseUrl:'https://cloud-api.near.ai/v1',model},fetch:async()=>{expired++;throw Object.assign(Error('PRIVATE'),{code:'provider_admission_expired'});}});await assert.rejects(f(url,init()),{code:'provider_admission_expired',message:'NEAR tool bridge refused'});assert.equal(expired,1);
});
test('abort cancels body before exposing any tool call',async()=>{
 const abort=new AbortController();let canceled=false;
 const f=createNearToolBridge({profile:{baseUrl:'https://cloud-api.near.ai/v1',model},fetch:async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(sse('<tool_call>read<arg_path>x</arg_path></tool_call>')));},cancel(){canceled=true;}}),{headers:{'content-type':'text/event-stream'}})});
 const pending=f(url,{...init(),signal:abort.signal});setTimeout(()=>abort.abort(),10);let caught;try{await pending;}catch(error){caught=error;}assert.ok(caught);assert.equal(canceled,true);assert.equal(nearToolBridgeDiagnostic(caught).callerAborted,true);assert.equal(nearToolBridgeDiagnostic(caught).deadlineAborted,false);assert.equal(nearToolBridgeDiagnostic(caught).stage,'body');
});
test('body size and request authority refuse before adapter',async()=>{
 let calls=0;const f=createNearToolBridge({profile:{baseUrl:'https://cloud-api.near.ai/v1',model},fetch:async()=>{calls++;return response('x'.repeat(8*1024*1024+1));}});
 await assert.rejects(f(url,init()));assert.equal(calls,1);
 const large=body();large.messages[0].content='z'.repeat(1024*1024);await assert.rejects(f(url,{...init(),body:JSON.stringify(large)}));assert.equal(calls,2);
 const over=body();over.messages[0].content='z'.repeat(4*1024*1024);await assert.rejects(f(url,{...init(),body:JSON.stringify(over)}));assert.equal(calls,2);await assert.rejects(f('https://other.invalid',init()));assert.equal(calls,2);
});

// Synthetic schema fixture derived from observed provider metadata. No captured
// response content, IDs, prompts or credentials are included here.
function cumulative({regress=false,invalid=false,matched=154829,missingDone=false,finish='stop',timeRegression=false,nestedRegression=false,earlyMatch=false}={}) {
 const base={id:'cumulative1',object:'chat.completion.chunk',created:1,model};
 const parts=['<tool_call>read','<arg_path>seed.txt</arg_path>','</tool_call>'];
 const frames=parts.map((content,i)=>({...base,created:timeRegression&&i===2?0:1+(i>0?1:0),choices:[{index:0,delta:{content},finish_reason:i===2?finish:null,logprobs:null,matched_stop:i===2?matched:earlyMatch?1:null}],usage:{prompt_tokens:228,completion_tokens:regress&&i===2?1:50+i,total_tokens:278+i,completion_tokens_details:{reasoning_tokens:nestedRegression&&i===2?1:47},prompt_tokens_details:invalid?'bad':null,reasoning_tokens:47}}));
 frames.push({...base,created:2,choices:[],usage:frames.at(-1).usage});
 return frames.map(v=>'data: '+JSON.stringify(v)+'\n\n').join('')+(missingDone?'':'data: [DONE]\n\n');
}
test('realistic cumulative usage/null detail metadata preserves final counters and tool call',async()=>{
 const f=createNearToolBridge({profile:{baseUrl:'https://cloud-api.near.ai/v1',model},fetch:async()=>response(cumulative())});
 const rows=(await (await f(url,init())).text()).split('\n').filter(v=>v.startsWith('data: {')).map(v=>JSON.parse(v.slice(6)));
 assert.equal(rows[0].choices[0].delta.tool_calls[0].function.name,'read');assert.equal(rows.at(-1).usage.completion_tokens,52);assert.equal(rows.at(-1).usage.total_tokens,280);assert.equal(rows.at(-1).usage.prompt_tokens_details,null);
});
test('cumulative compatibility still refuses regression/types/unsafe stop metadata/truncation',async()=>{
 for(const options of [{regress:true},{invalid:true},{matched:'seed.txt'},{matched:-1},{matched:1.5},{earlyMatch:true},{nestedRegression:true},{timeRegression:true},{missingDone:true},{finish:'length'}]){
 let calls=0;const f=createNearToolBridge({profile:{baseUrl:'https://cloud-api.near.ai/v1',model},fetch:async()=>{calls++;return response(cumulative(options));}});await assert.rejects(f(url,init()),{message:'NEAR tool bridge refused'});assert.equal(calls,1);
 }
});

test('bridge diagnostics distinguish encode/fetch/headers/body/SSE/decode without raw text',async()=>{
 const cases=[
  ['encode',async()=>response(sse('ok')),{...init(),body:'invalid PRIVATE'}],
  ['adapter-fetch',async()=>{throw Object.assign(Error('PRIVATE'),{code:'transport_refused'});},init()],
  ['headers',async()=>new Response('PRIVATE',{status:403}),init()],
  ['body',async()=>new Response(new ReadableStream({start(c){c.error(Error('PRIVATE'));}}),{headers:{'content-type':'text/event-stream'}}),init()],
  ['sse-parse',async()=>response('PRIVATE\n'),init()],
  ['decode',async()=>response(sse('<tool_call>unknown</tool_call>')),init()]
 ];
 for(const [stage,fetch,request] of cases){
  const f=createNearToolBridge({profile:{baseUrl:'https://cloud-api.near.ai/v1',model},fetch});let caught;
  try{await f(url,request);}catch(e){caught=e;}
  const d=nearToolBridgeDiagnostic(caught);assert.equal(d.stage,stage);assert.ok(Number.isSafeInteger(d.elapsedMs)&&d.elapsedMs>=0);assert.equal(d.deadlineAborted,false);assert.equal(d.callerAborted,false);
  assert.ok(!JSON.stringify(d).includes('PRIVATE'));assert.ok(Object.isFrozen(d));
  assert.equal(nearToolBridgeDiagnostic({bridgeDiagnostic:{...d}}),null);
 }
});
test('bridge diagnostics identify its 2420 s backstop deadline separately from caller cancel',async()=>{
 const original=AbortSignal.timeout,deadline=new AbortController();let supplied;
 AbortSignal.timeout=ms=>{supplied=ms;return deadline.signal;};
 try{
  const f=createNearToolBridge({profile:{baseUrl:'https://cloud-api.near.ai/v1',model},fetch:async(_u,i)=>new Promise((_r,reject)=>i.signal.addEventListener('abort',()=>reject(new DOMException('PRIVATE','TimeoutError')),{once:true}))});
  const pending=f(url,init());await new Promise(r=>setImmediate(r));deadline.abort();let caught;try{await pending;}catch(e){caught=e;}
  const d=nearToolBridgeDiagnostic(caught);assert.equal(supplied,2420000);assert.equal(d.stage,'adapter-fetch');assert.equal(d.deadlineAborted,true);assert.equal(d.callerAborted,false);assert.equal(d.errorName,'TimeoutError');
 }finally{AbortSignal.timeout=original;}
});

test('an idle or over-long upstream cut by the transport is named in the diagnostic, not as the bridge deadline',async()=>{
 for(const code of ['upstream_idle','upstream_deadline']){
  const f=createNearToolBridge({profile:{baseUrl:'https://glm-5-3-flash-i0.completions.near.ai/v1',model},fetch:async()=>{throw Object.assign(Error('PRIVATE'),{code});}});let caught;
  try{await f('https://glm-5-3-flash-i0.completions.near.ai/v1/chat/completions',init());}catch(e){caught=e;}
  const d=nearToolBridgeDiagnostic(caught);assert.equal(d.stage,'adapter-fetch');assert.equal(d.causeCode,code);assert.equal(d.deadlineAborted,false);
 }
});
test('direct instance and gateway endpoints admitted; other hosts refused',()=>{
 for(const baseUrl of ['https://glm-5-3-flash-i0.completions.near.ai/v1','https://cloud-api.near.ai/v1'])assert.equal(typeof createNearToolBridge({profile:{baseUrl,model},fetch:async()=>{}}),'function');
 for(const baseUrl of ['https://completions.near.ai/v1','https://glm-5-3-flash-i0.completions.near.ai:444/v1','https://glm-5-3-flash-i0.completions.near.ai/v2','http://glm-5-3-flash-i0.completions.near.ai/v1','https://x-i0.completions.near.ai.evil/v1',undefined])assert.throws(()=>createNearToolBridge({profile:{baseUrl,model},fetch:async()=>{}}));
});
test('finite SSE diagnostic categories never expose raw content, IDs or unknown finish reason',async()=>{
 const cases=[
  [sse('PRIVATE_CANARY',{finish:'content_filter'}),'finish-reason','content_filter'],
  [sse('PRIVATE_CANARY',{finish:'PRIVATE_CANARY'}),'finish-reason','other'],
  [sse('PRIVATE_CANARY').replaceAll('"model":"'+model+'"','"model":"PRIVATE_CANARY"'),'chunk-model',null],
  [sse('PRIVATE_CANARY').replace('"id":"test1"','"id":"changed"'),'chunk-identity',null],
  [sse('',{delta:{tool_calls:[{PRIVATE_CANARY:true}]}}),'delta',null],
  [sse('PRIVATE_CANARY',{done:false}),'done','stop'],
  ['data: PRIVATE_CANARY\n\n','json',null],
  [sse('PRIVATE_CANARY').replace('"total_tokens":7','"total_tokens":-1'),'usage',null],
  ['data: [DONE]\n\n','done',null],
 ];
 for(const [raw,reason,finish] of cases){let caught;const f=createNearToolBridge({profile:{baseUrl:'https://cloud-api.near.ai/v1',model},fetch:async()=>response(raw)});try{await f(url,init());}catch(e){caught=e;}
  assert.ok(caught);const d=nearToolBridgeDiagnostic(caught);assert.equal(d.stage,'sse-parse');assert.equal(d.sseReason,reason);assert.equal(d.finishReason,finish);assert.ok(!JSON.stringify(d).includes('PRIVATE_CANARY'));assert.equal(nearToolBridgeDiagnostic({bridgeDiagnostic:{...d}}),null);
 }
});

const rowsOf = raw => raw.split('\n').filter(line=>line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6)));
test('complete length stop preserves partial text, reasoning, usage and length without retry',async()=>{
 let posts=0;
 const raw=sse('',{finish:'length',delta:{content:'Zcash trades at an indicative price of',reasoning_content:'Comparing the fetched price.'}});
 const fetch=createNearToolBridge({profile:{baseUrl:'https://cloud-api.near.ai/v1',model},fetch:async(_u,i)=>{posts++;assert.equal(JSON.parse(i.body).max_tokens,1024);return response(raw);}});
 const r=await fetch(url,init());assert.equal(r.status,200);assert.equal(r.headers.get('x-inference-id'),'inference-1');
 const output=await r.text(),rows=rowsOf(output);
 assert.equal(rows[0].choices[0].delta.content,'Zcash trades at an indicative price of\n\n[Output limit reached; this answer is incomplete.]');
 assert.equal(rows[0].choices[0].delta.reasoning_content,'Comparing the fetched price.');
 assert.equal(rows[0].choices[0].delta.tool_calls,undefined);assert.equal(rows[1].choices[0].finish_reason,'length');
 assert.deepEqual(rows[2].usage,{prompt_tokens:4,completion_tokens:3,total_tokens:7});assert.ok(output.endsWith('data: [DONE]\n\n'));assert.equal(posts,1);
 // Successful partial responses still burn the upstream identity.
 await assert.rejects(fetch(url,init()));assert.equal(posts,2);
});
test('length stop never decodes or emits complete, unknown, partial or escaped tool markup',async()=>{
 for(const text of ['<tool_call>bash<arg_command>touch NEVER_EXECUTE</arg_command></tool_call>','before <tool_call>unknown</tool_call>','before <tool_call>read<arg_path>secret','before <t','before </','before &lt;tool_call&gt;read']){
  let posts=0;const fetch=createNearToolBridge({profile:{baseUrl:'https://cloud-api.near.ai/v1',model},fetch:async()=>{posts++;return response(sse(text,{finish:'length'}));}});
  const rows=rowsOf(await (await fetch(url,init())).text()),delta=rows[0].choices[0].delta;
  assert.equal(delta.content,'[Output limit reached. The unfinished response was withheld because it may contain tool-request markup. No tool calls were released.]');
  assert.equal(delta.tool_calls,undefined);assert.equal(delta.reasoning_content,undefined);assert.equal(rows[1].choices[0].finish_reason,'length');assert.equal(posts,1);
 }
});
test('length stop handles empty and reasoning-only replies and withholds markup in reasoning',async()=>{
 for(const delta of [{},{reasoning:'Need another lookup.'},{content:'Safe answer',reasoning_content:'<tool_call>bash'}]){
  const fetch=createNearToolBridge({profile:{baseUrl:'https://cloud-api.near.ai/v1',model},fetch:async()=>response(sse('',{finish:'length',delta}))});
  const first=rowsOf(await (await fetch(url,init())).text())[0].choices[0].delta;
  assert.match(first.content,/Output limit reached/);assert.equal(first.tool_calls,undefined);
  if(delta.reasoning)assert.equal(first.reasoning_content,delta.reasoning);
  if(delta.reasoning_content){assert.equal(first.reasoning_content,undefined);assert.ok(!first.content.includes('Safe answer'));}
 }
});
test('complete cumulative length stream retains nested final usage but withholds tool markup',async()=>{
 let posts=0;const fetch=createNearToolBridge({profile:{baseUrl:'https://cloud-api.near.ai/v1',model},fetch:async()=>{posts++;return response(cumulative({finish:'length',matched:null}));}});
 const rows=rowsOf(await (await fetch(url,init())).text());assert.equal(rows[0].choices[0].delta.tool_calls,undefined);assert.equal(rows[1].choices[0].finish_reason,'length');assert.equal(rows[2].usage.completion_tokens,52);assert.equal(rows[2].usage.completion_tokens_details.reasoning_tokens,47);assert.equal(posts,1);
});
test('length still refuses native tool poison, missing DONE, usage regression and malformed framing once',async()=>{
 const variants=[sse('',{finish:'length',delta:{tool_calls:[]}}),sse('',{finish:'length',delta:{function_call:{name:'bash',arguments:'{}'}}}),sse('partial',{finish:'length',done:false}),sse('partial',{finish:'length'}).slice(0,-2),cumulative({finish:'length',matched:null,regress:true}),cumulative({finish:'length',matched:null,nestedRegression:true}),cumulative({finish:'length',matched:null,timeRegression:true})];
 for(const raw of variants){let posts=0;const fetch=createNearToolBridge({profile:{baseUrl:'https://cloud-api.near.ai/v1',model},fetch:async()=>{posts++;return response(raw);}});await assert.rejects(fetch(url,init()),{message:'NEAR tool bridge refused'});assert.equal(posts,1);}
});
test('provider failures at adapter-fetch retry up to three attempts with status and body kept',async()=>{
 const unavailable=()=>Object.assign(Error('synthetic'),{code:'provider_unavailable',upstreamStatus:503,upstreamBody:'overloaded'});
 let calls=0;const ok=createNearToolBridge({profile:{baseUrl:'https://cloud-api.near.ai/v1',model},fetch:async()=>{if(++calls<3)throw unavailable();return response(sse('fine'));}});
 assert.equal((await ok(url,init())).status,200);assert.equal(calls,3);
 calls=0;const down=createNearToolBridge({profile:{baseUrl:'https://cloud-api.near.ai/v1',model},fetch:async()=>{calls++;throw unavailable();}});
 const error=await down(url,init()).catch(e=>e);assert.equal(calls,3);
 const d=nearToolBridgeDiagnostic(error);assert.equal(d.attempt,3);assert.equal(d.httpStatus,503);assert.equal(d.upstreamBody,'overloaded');
 calls=0;const broke=createNearToolBridge({profile:{baseUrl:'https://cloud-api.near.ai/v1',model},fetch:async()=>{calls++;throw Object.assign(Error('synthetic'),{code:'credit_exhausted'});}});
 await assert.rejects(broke(url,init()));assert.equal(calls,1);
});
