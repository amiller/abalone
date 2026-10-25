import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'desktop-offline-'));await fs.chmod(dir,0o700);
const child=spawn(process.execPath,['--import',path.join(here,'fake-fetch.mjs'),path.join(here,'broker.mjs'),dir],{stdio:['ignore','pipe','pipe','ignore','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
child.stdio[4].end(JSON.stringify({version:1,provider:'zai',model:'glm-5.3',apiKey:'SYNTHETIC_KEY'}));
let stderr='';child.stderr.on('data',b=>stderr+=b);
const exited=once(child,'close');
async function request(id,change={},method='POST'){
 const body={model:'glm-5.3',messages:[{role:'user',content:'synthetic'}],stream:true,max_tokens:2048,reasoning_effort:'low',store:false,tool_stream:true,thinking:{type:'enabled',clear_thinking:false},stream_options:{include_usage:true},...change};
 return new Promise((resolve,reject)=>{const req=http.request({socketPath:path.join(dir,'inference.sock'),path:'/v1/chat/completions',method,headers:{authorization:'Bearer inference-broker-session','content-type':'application/json','x-inference-request-id':id}},res=>{let output='';res.on('data',b=>output+=b);res.on('end',()=>resolve({status:res.statusCode,output}));});req.on('error',reject);req.end(method==='GET'?undefined:JSON.stringify(body));});
}
try{
 await once(child.stdout,'data');
 assert.equal((await request('request_invalid_method_00',{},'GET')).status,400);
 assert.equal((await request('request_wrong_model_0000',{model:'other'})).status,400);
 assert.equal((await request('request_badthinking_0000',{thinking:{type:'enabled',clear_thinking:true}})).status,400);
 assert.equal((await request('request_unknownfield_000',{base_url:'https://example.invalid'})).status,400);
 const result=await request('request_valid_unique_0001');assert.equal(result.status,200);assert.match(result.output,/"post":1/);
 assert.equal((await request('request_valid_unique_0001')).status,409);
 for(let i=2;i<=5;i++){const r=await request('request_valid_unique_000'+i);assert.equal(r.status,200);assert.match(r.output,new RegExp('"post":'+i));}
 assert.equal((await request('request_session_exhausted')).status,429);
 child.kill('SIGTERM');const [code]=await exited;assert.equal(code,0,stderr);
 assert.equal(await fs.lstat(path.join(dir,'inference.sock')).then(()=>true,()=>false),false);
 console.log(JSON.stringify({ok:true,offline:true,upstreamPosts:5,duplicateRefused:true,invalidModelRefused:true,invalidThinkingRefused:true,unknownFieldsRefused:true,sessionLimit:true,socketCleaned:true}));
}finally{if(child.exitCode===null){child.kill('SIGTERM');await exited;}await fs.rm(dir,{recursive:true,force:true});}
