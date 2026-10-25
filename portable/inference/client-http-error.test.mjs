// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inferenceSocketFetch} from './client.mjs';
test('HTTP503 remains a bounded fetch Response with safe API error and no retry',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'broker-http-'));let requests=0;
 const body={error:{code:'unavailable',message:'Admission failed. No inference was sent. A new prompt may retry.'}};
 const server=http.createServer((req,res)=>{requests++;req.resume();res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify(body));});
 try{
  await new Promise(resolve=>server.listen(join(dir,'broker.sock'),resolve));
  const fetch=inferenceSocketFetch(join(dir,'broker.sock'),{requestId:'http-error-test-001'});
  const response=await fetch('http://broker/v1/chat/completions',{body:'{}'});
  assert.equal(response.status,503);assert.equal(response.ok,false);
  assert.deepEqual(await response.json(),body);assert.equal(requests,1);
 }finally{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
