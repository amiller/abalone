// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createNearPinnedTransport,createNearTorTransportForTesting} from './near-tor-transport.mjs';
const pin={hostname:'glm-5-3-flash-i0.completions.near.ai',origin:'https://glm-5-3-flash-i0.completions.near.ai',spkiPins:['ab'.repeat(32)]};
const chat='https://glm-5-3-flash-i0.completions.near.ai/v1/chat/completions';
const fake=`const net=require('node:net');let config='',body=[];process.stdin.setEncoding('utf8');process.stdin.on('data',b=>config+=b);const input=new net.Socket({fd:3,readable:true,writable:false});input.on('data',b=>body.push(b));let a=false,b=false;function done(){if(!a||!b)return;const mode=process.argv[1];if(mode==='hang'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);return;}if(mode==='pin-fail'){process.exitCode=90;return;}if(mode==='silent'){setInterval(()=>{},1000);return;}if(mode==='trickle'){process.stdout.write('HTTP/1.1 200 OK\\r\\n\\r\\n');setInterval(()=>process.stdout.write('x'),40);return;}if(mode==='stall'){process.stdout.write('HTTP/1.1 200 OK\\r\\n\\r\\ndata: partial');setInterval(()=>{},1000);return;}if(mode==='headers'){process.stdout.write('HTTP/1.1 200 OK\\r\\nX-Huge: '+ 'x'.repeat(20000));return;}if(mode==='redirect'){process.stdout.write('HTTP/1.1 302 Found\\r\\nLocation: https://outside.invalid/\\r\\n\\r\\n');return;}if(mode==='oversize'){process.stdout.write('HTTP/1.1 200 OK\\r\\n\\r\\n');process.stdout.write(Buffer.alloc(9*1024*1024));return;}const value=JSON.stringify({bodyBytes:Buffer.concat(body).length,syntheticAuthSeen:config.includes('synthetic_key'),quoteEscaped:config.includes('a\\\\\\\"b')});process.stdout.write('HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n'+value);}process.stdin.on('end',()=>{a=true;done()});input.on('end',()=>{b=true;done()});`;
function fixture(mode='ok',pinned=false,limits){
 const calls=[];let child;
 const transport=createNearTorTransportForTesting({pin:pinned?pin:null,limits,spawnProcess(file,args,options){calls.push({file,args,options});child=spawn(process.execPath,['-e',fake,mode],options);return child;}});
 return {transport,calls,get child(){return child;}};
}
const absent=pid=>assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
test('fixed Tor/TLS/pin argv; credential headers only stdin and response after actual child reap',async()=>{
 const f=fixture('ok',true);
 try{
  const res=await f.transport.fetch(chat,{method:'POST',headers:{authorization:'Bearer synthetic_key','content-type':'application/json'},body:'{}'});
  assert.deepEqual(await res.json(),{bodyBytes:2,syntheticAuthSeen:true,quoteEscaped:false});
  const c=f.calls[0];assert.equal(c.file,'/usr/bin/python3');assert.ok(c.args.includes('socks5h://127.0.0.1:9050'));assert.equal(c.args[c.args.indexOf('--pinnedpubkey')+1],'sha256//'+Buffer.from('ab'.repeat(32),'hex').toString('base64'));
  assert.ok(c.args.includes('--tlsv1.2'));assert.ok(c.args.includes('-q'));assert.ok(!c.args.some(x=>x.includes('synthetic_key')));assert.deepEqual(c.options.env,{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'});absent(f.child.pid);
 }finally{await f.transport.close();}
});
test('origin, credentials, redirects, method, body bounds and malformed pins refuse before spawn',async()=>{
 for(const bad of [{...pin,hostname:'evil.invalid'},{hostname:'cloud-api.near.ai',origin:'https://cloud-api.near.ai',spkiPins:pin.spkiPins},{...pin,origin:'https://glm-5-3-flash-i1.completions.near.ai'},{...pin,spkiPins:['invalid']},{...pin,spkiPins:[pin.spkiPins[0],pin.spkiPins[0]]}])assert.throws(()=>createNearPinnedTransport(bad),/unavailable/);
 const f=fixture();
 try{
  for(const [url,init] of [['http://cloud-api.near.ai',{}],['https://evil.invalid',{}],['https://cloud-api.near.ai@evil.invalid',{}],['https://base-rpc.publicnode.com',{headers:{authorization:'Bearer synthetic_key'}}],['https://cloud-api.near.ai',{redirect:'follow'}],['https://cloud-api.near.ai',{method:'PUT'}],['https://cloud-api.near.ai',{headers:{cookie:'secret'}}],['https://cloud-api.near.ai',{headers:{accept:'ok\r\nAuthorization: Bearer synthetic_key'}}],['https://cloud-api.near.ai',{headers:{accept:'x'.repeat(2049)}}],['https://cloud-api.near.ai',{method:'POST',body:'x'.repeat(8*1024*1024+1)}]])await assert.rejects(f.transport.fetch(url,init),/unavailable/);
  assert.equal(f.calls.length,0);
 }finally{await f.transport.close();}
 const p=fixture('ok',true);try{for(const u of ['https://glm-5-3-flash-i0.completions.near.ai/v1/models','https://cloud-api.near.ai/v1/chat/completions','https://glm-5-3-flash-i1.completions.near.ai/v1/chat/completions'])await assert.rejects(p.transport.fetch(u,{method:'POST',body:'{}'}),/unavailable/);assert.equal(p.calls.length,0);}finally{await p.transport.close();}
});
for(const mode of ['headers','redirect','oversize'])test(mode+' actual child refuses sanitized and reaps',async()=>{
 const f=fixture(mode,true);try{await assert.rejects(f.transport.fetch(chat,{method:'POST',body:'{}'}),e=>e.message==='NEAR Tor transport unavailable'&&e.code==='NEAR_TOR_TRANSPORT');absent(f.child.pid);}finally{await f.transport.close();}
});
test('abort escalates TERM-resistant actual child; close joins drain and refuses late requests',async()=>{
 const f=fixture('hang');const signal=new AbortController();
 const pending=f.transport.fetch('https://base-rpc.publicnode.com',{method:'POST',body:'{}',signal:signal.signal});pending.catch(()=>{});
 while(!f.child)await new Promise(r=>setImmediate(r));
 // Allow child to install its deliberately resistant handler.
 await new Promise(r=>setTimeout(r,100));signal.abort();const closing=f.transport.close();
 await assert.rejects(pending,/unavailable/);await closing;absent(f.child.pid);await assert.rejects(f.transport.fetch('https://base-rpc.publicnode.com'),/unavailable/);
});
test('preaborted signal and close-before-fetch launch no child',async()=>{
 const f=fixture();const a=new AbortController();a.abort();await assert.rejects(f.transport.fetch('https://base-rpc.publicnode.com',{signal:a.signal}),/unavailable/);await f.transport.close();await assert.rejects(f.transport.fetch('https://base-rpc.publicnode.com'),/unavailable/);assert.equal(f.calls.length,0);
});

test('pin exit90 returns fixed nonretryable403 only for pinned chat, after reap',async()=>{
 for(const pinned of [true,false]){const f=fixture('pin-fail',pinned);try{const p=f.transport.fetch(pinned?chat:'https://cloud-api.near.ai/v1/chat/completions',{method:'POST',body:'{}'});if(pinned){const r=await p;assert.equal(r.status,403);assert.deepEqual(await r.json(),{error:{message:'✗ refused: NEAR TLS SPKI pin mismatch'}});}else await assert.rejects(p,/unavailable/);absent(f.child.pid);}finally{await f.transport.close();}}
});

test('local GPU fixed RIM/OCSP origins route through Tor; obsolete NRAS and credential forwarding refuse',async()=>{
 const f=fixture();try{
 const a=await f.transport.fetch('https://rim.attestation.nvidia.com/v1/rim/synthetic');assert.equal(a.status,200);
 const b=await f.transport.fetch('https://ocsp.ndis.nvidia.com/',{method:'POST',headers:{'content-type':'application/ocsp-request',accept:'application/ocsp-response'},body:new Uint8Array([1,2,3])});assert.equal((await b.json()).bodyBytes,3);
 const n=f.calls.length;await assert.rejects(f.transport.fetch('https://nras.attestation.nvidia.com/v3/attest/gpu',{method:'POST',body:'{}'}));await assert.rejects(f.transport.fetch('https://rim.attestation.nvidia.com/v1/rim/synthetic',{headers:{authorization:'Bearer synthetic_key'}}));assert.equal(f.calls.length,n);
 }finally{await f.transport.close();}
});

test('bounded NEAR management token stays configstdin, never argv or foreign origin',async()=>{
 const f=fixture(),token='x'.repeat(4096);try{const r=await f.transport.fetch('https://cloud-api.near.ai/v1/organizations/12345678-1234-4234-8234-123456789abc/usage/balance',{headers:{authorization:'Bearer '+token}});assert.equal(r.status,200);assert.ok(!JSON.stringify(f.calls[0].args).includes(token));await assert.rejects(f.transport.fetch('https://base-rpc.publicnode.com',{headers:{authorization:'Bearer '+token}}));}finally{await f.transport.close();}
});

test('fixed PublicNode RPC allowed; removed Base origin refuses before spawn',async()=>{
 const f=fixture();try{
 const r=await f.transport.fetch('https://base-rpc.publicnode.com',{method:'POST',body:'{}'});assert.equal(r.status,200);
 const n=f.calls.length;await assert.rejects(f.transport.fetch('https://mainnet.base.org',{method:'POST',body:'{}'}));assert.equal(f.calls.length,n);
 }finally{await f.transport.close();}
});

test('direct discovery needs no credential; instance report GET carries one; other near.ai hosts refuse',async()=>{
 const f=fixture();try{
 assert.equal((await f.transport.fetch('https://completions.near.ai/backends/count?domain=glm-5-3-flash.completions.near.ai')).status,200);
 assert.equal((await f.transport.fetch('https://glm-5-3-flash-i0.completions.near.ai/v1/attestation/report?nonce=1',{headers:{authorization:'Bearer synthetic_key'}})).status,200);
 const n=f.calls.length;
 await assert.rejects(f.transport.fetch('https://completions.near.ai/endpoints',{headers:{authorization:'Bearer synthetic_key'}}));
 await assert.rejects(f.transport.fetch('https://evil-i0.completions.near.ai.evil.invalid/v1/x'));
 await assert.rejects(f.transport.fetch('https://glm-i0.completions.near.ai:8443/v1/x'));
 assert.equal(f.calls.length,n);
 }finally{await f.transport.close();}
});
test('no upstream byte within the idle limit (first byte included) aborts as upstream_idle and reaps',async()=>{
 for(const mode of ['silent','stall']){const f=fixture(mode,true,{idleMs:300,ceilingMs:5000});const t0=performance.now();
  try{await assert.rejects(f.transport.fetch(chat,{method:'POST',body:'{}'}),e=>e.code==='upstream_idle'&&!/partial/.test(e.message));
   const ms=performance.now()-t0;assert.ok(ms>=300&&ms<2000,String(ms));absent(f.child.pid);}finally{await f.transport.close();}}
});
test('a stream that keeps sending is cut only at the ceiling, as upstream_deadline',async()=>{
 const f=fixture('trickle',true,{idleMs:300,ceilingMs:1200});const t0=performance.now();
 try{await assert.rejects(f.transport.fetch(chat,{method:'POST',body:'{}'}),e=>e.code==='upstream_deadline');assert.ok(performance.now()-t0>=1200);absent(f.child.pid);}finally{await f.transport.close();}
});
test('production limits: idle 60 s, ceiling 2400 s, curl max-time just beyond the ceiling',async()=>{
 const {IDLE_MS,CEILING_MS}=await import('./near-tor-transport.mjs');assert.deepEqual([IDLE_MS,CEILING_MS],[60000,2400000]);
 const f=fixture();try{await f.transport.fetch('https://base-rpc.publicnode.com',{method:'POST',body:'{}'});const a=f.calls[0].args;assert.equal(a[a.indexOf('--max-time')+1],'2410');}finally{await f.transport.close();}
});
