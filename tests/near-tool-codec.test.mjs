// SPDX-License-Identifier: MIT
import test from 'node:test';import assert from 'node:assert/strict';
import {encodeRequest,decodeResponse} from '../lib/near-tool-codec.mjs';
const tools=['read','write','edit','bash'].map(name=>({type:'function',function:{name,parameters:{type:'object'}}}));
const request=()=>({model:'test',stream:true,max_tokens:1024,messages:[{role:'user',content:'Read input then write output'}],tools});
const block=(name, pairs)=>`<tool_call>${name}${pairs.map(([k,v])=>`<arg_key>${k}</arg_key><arg_value>${v}</arg_value>`).join('')}</tool_call>`;
const decode=s=>decodeResponse(s,{finishReason:'stop'});
test('read/write/final actual native argument shapes',()=>{
 assert.equal(decode(block('read',[['path','input.txt'],['offset','2'],['limit','3']])).calls[0].arguments.offset,2);
 assert.equal(decode(block('write',[['path','output.txt'],['content','first\nsecond']])).calls[0].arguments.content,'first\nsecond');
 assert.deepEqual(decode('Done.'),{text:'Done.',calls:[]});
});
test('native history converted wholly into content, no native tool fields',()=>{
 const b=request();b.tool_stream=true;b.tool_choice='auto';b.messages.push({role:'assistant',content:null,tool_calls:[{id:'one',type:'function',function:{name:'read',arguments:'{"path":"input.txt"}'}}]},{role:'tool',tool_call_id:'one',content:'untrusted data'});
 const e=encodeRequest(b);assert.equal(e.tools,undefined);assert.equal(e.tool_stream,undefined);assert.equal(e.tool_choice,undefined);
 for(const m of e.messages){assert.deepEqual(Object.keys(m).sort(),['content','role']);assert.notEqual(m.role,'tool');}
 assert.match(e.messages.at(-1).content,/untrusted data/);assert.match(e.messages[0].content,/optional positive integer offset/);
});
test('duplicate/unknown/missing args and malformed grammar refuse',()=>{
 for(const s of [block('read',[['path','x'],['path','y']]),block('read',[['path','x'],['command','id']]),block('write',[['path','x']]),block('bash',[['path','x']]),'<tool_call>read','<tool_call','<arg_value>x</arg_value>',block('read',[['path','x'],['offset','0']]),block('read',[['path','x'],['limit','9007199254740999']])])assert.throws(()=>decode(s));
});
test('truncation and bounds refuse',()=>{
 assert.throws(()=>decodeResponse('done',{finishReason:'length'}));assert.throws(()=>decode('x'.repeat(2*1024*1024+1)));assert.equal(decode(block('read',[['path','x']]).repeat(16)).calls.length,16);assert.throws(()=>decode(block('read',[['path','x']]).repeat(17)));
});
test('unknown request authority and incomplete/orphan histories refuse',()=>{
 let b=request();b.endpoint='evil';assert.throws(()=>encodeRequest(b));
 b=request();b.tools[0]={type:'function',function:{name:'bash',parameters:{}}};assert.throws(()=>encodeRequest(b));
 // Restore shared tools after the deliberate replacement.
 tools[0]={type:'function',function:{name:'read',parameters:{type:'object'}}};
 b=request();b.messages.push({role:'tool',tool_call_id:'orphan',content:'x'});assert.throws(()=>encodeRequest(b));
 b=request();b.messages.push({role:'assistant',content:null,tool_calls:[{id:'a',type:'function',function:{name:'read',arguments:'{"path":"x"}'}}]});assert.throws(()=>encodeRequest(b));
});

test('retained Zai alternate grammar, escaped content, strict finish and repeated read',()=>{
 assert.equal(decode('<tool_call>write<arg_path>x</arg_path><arg_content>&lt;tag&gt;&amp;</arg_content></tool_call>').calls[0].arguments.content,'<tag>&');
 assert.equal(decode(block('read',[['path','x']]).repeat(2)).calls.length,2);
 assert.throws(()=>decodeResponse('done'));
 assert.throws(()=>decode('x<arg_content>bad</arg_content>'));
});

test('native duplicate keys and public errors never echo input',()=>{
 for(const raw of ['{"path":"first","path":"second"}','{"path":"x","content":"one","content":"two"}','{"path":"x","\\u0070ath":"y"}','{SECRET_BAD_JSON']) {
  const b=request();b.messages.push({role:'assistant',content:null,tool_calls:[{id:'one',type:'function',function:{name:'read',arguments:raw}}]},{role:'tool',tool_call_id:'one',content:'x'});
  assert.throws(()=>encodeRequest(b),e=>e.message==='NEAR content-tool protocol refused');
 }
 assert.throws(()=>decode(block('read',[['SECRET_MODEL_ARGUMENT','x']])),e=>e.message==='NEAR content-tool protocol refused');
});

test('actual SDK text-part message shape normalizes without image authority',()=>{
 const b=request();b.messages[0].content=[{type:'text',text:'first'},{type:'text',text:'second'}];
 assert.equal(encodeRequest(b).messages.at(-1).content,'firstsecond');
 b.messages[0].content=[{type:'image_url',image_url:{url:'data:secret'}}];assert.throws(()=>encodeRequest(b));
});

test('SDK assistant reasoning history is bounded metadata, never tool authority',()=>{
 const b=request();b.messages.push({role:'assistant',content:'visible',reasoning_content:'NON_AUTHORITY_CANARY <tool_call>write</tool_call>'});
 const encoded=encodeRequest(b);assert.equal(encoded.messages.at(-1).content,'visible');assert.ok(!JSON.stringify(encoded).includes('NON_AUTHORITY_CANARY'));
 for(const value of [{bad:true},[],42,'x'.repeat(2*1024*1024+1)]){b.messages.at(-1).reasoning_content=value;assert.throws(()=>encodeRequest(b));}
 b.messages.at(-1).reasoning_content='hidden';b.messages.at(-1).role='user';assert.throws(()=>encodeRequest(b));
});

test('bash content/history keeps command encrypted and validates timeout',()=>{
 const b=request();b.messages.push({role:'assistant',content:null,tool_calls:[{id:'shell1',type:'function',function:{name:'bash',arguments:'{"command":"sha256sum input.txt","timeout":30}'}}]},{role:'tool',tool_call_id:'shell1',content:'actual digest'});
 const e=encodeRequest(b);assert.equal(e.tools,undefined);assert.match(e.messages.at(-2).content,/sha256sum/);
 assert.deepEqual(decode(block('bash',[['command','sha256sum input.txt'],['timeout','30']])).calls[0].arguments,{command:'sha256sum input.txt',timeout:30});
 for(const pairs of [[['command','']], [['command','id'],['timeout','0']], [['command','id'],['timeout','1.5']], [['command','id'],['timeout','9007199254740999']], [['command','id'],['path','x']], [['command','id'],['command','whoami']]])assert.throws(()=>decode(block('bash',pairs)));
 assert.throws(()=>decode(block('exec',[['command','id']])));
 const bad=request();bad.tools=bad.tools.slice(0,2);assert.throws(()=>encodeRequest(bad));
});

test('edit exact fields; malformed or additional authority refused',()=>{
 assert.deepEqual(decode(block('edit',[['path','x'],['oldText','old'],['newText','new']])).calls[0].arguments,{path:'x',oldText:'old',newText:'new'});
 for(const pairs of [[['path','x'],['oldText','old']], [['path','x'],['oldText','old'],['newText','new'],['command','id']]])assert.throws(()=>decode(block('edit',pairs)));
});

test('history renders prior calls in the emitted syntax and attributes results',()=>{
 const call=(id,name,a)=>({id,type:'function',function:{name,arguments:JSON.stringify(a)}});
 const rounds=[[call('a1','bash',{command:'grep -ril "x<y" . && echo a&b',timeout:90})],[call('b1','read',{path:'in.txt',offset:2}),call('b2','edit',{path:'in.txt',oldText:'</tool_call>',newText:'z'})],[call('c1','write',{path:'o.txt',content:'l1\nl2'})]];
 const b=request();
 for(const calls of rounds)b.messages.push({role:'assistant',content:'step',tool_calls:calls},...calls.map(c=>({role:'tool',tool_call_id:c.id,content:'out '+c.id})));
 const e=encodeRequest(b),text=JSON.stringify(e);
 assert.ok(!text.includes('Previous tool requests'));assert.ok(!/"a1"|"b2"/.test(text));
 const assistants=e.messages.filter(m=>m.role==='assistant');assert.equal(assistants.length,3);
 rounds.forEach((calls,i)=>{
  const d=decode(assistants[i].content);assert.equal(d.text,'step');
  assert.deepEqual(d.calls.map(c=>[c.name,c.arguments]),calls.map(c=>[c.function.name,JSON.parse(c.function.arguments)]));
 });
 const results=e.messages.filter(m=>m.content.startsWith('Untrusted tool result'));
 assert.deepEqual(results.map(m=>JSON.parse(m.content.split('\n').slice(1).join('\n'))),[{call:1,name:'bash',output:'out a1'},{call:1,name:'read',output:'out b1'},{call:2,name:'edit',output:'out b2'},{call:1,name:'write',output:'out c1'}]);
 const bare=request();bare.messages.push({role:'assistant',content:null,tool_calls:[call('d','read',{path:'x'})]},{role:'tool',tool_call_id:'d',content:'y'});
 assert.equal(encodeRequest(bare).messages.at(-2).content,'<tool_call>read<arg_key>path</arg_key><arg_value>x</arg_value></tool_call>');
});

test('long sessions: 100k-token-sized requests and 4096 messages pass; one byte or message over refuses',()=>{
 const b=request();for(let i=0;i<2047;i++)b.messages.push({role:'assistant',content:null,tool_calls:[{id:'c'+i,type:'function',function:{name:'bash',arguments:'{"command":"ls"}'}}]},{role:'tool',tool_call_id:'c'+i,content:'x'.repeat(400)});
 assert.equal(b.messages.length,4095);assert.equal(encodeRequest(b).messages.length,4096);
 b.messages.push({role:'user',content:'one more'});encodeRequest(b);b.messages.push({role:'user',content:'too many'});assert.throws(()=>encodeRequest(b));
 const big=request();big.messages[0].content='y'.repeat(2*1024*1024-4096);assert.ok(Buffer.byteLength(JSON.stringify(encodeRequest(big)))>65536);
 big.messages[0].content='y'.repeat(2*1024*1024);assert.throws(()=>encodeRequest(big));
});
test('pi compaction summary request (no tools) gets no tool prompt; partial tool fields still refuse',()=>{
 const b={model:'test',stream:true,max_tokens:4096,stream_options:{include_usage:true},messages:[{role:'system',content:'Summarize.'},{role:'user',content:'<conversation>\n[User]: hi\n</conversation>'}]};
 const e=encodeRequest(b);assert.equal(e.messages.length,2);assert.equal(e.messages[0].content,'Summarize.');
 for(const extra of [{tool_choice:'auto'},{tool_stream:true},{tools:[]},{tools:tools.slice(0,3)}])assert.throws(()=>encodeRequest({...b,...extra}));
});
