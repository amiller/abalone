import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import https from 'node:https';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {runCurl,curlArgs,endpoint} from '../zai-curl-transport.mjs';
export async function tlsFixture(t,handler,{trust=true}={}){
 const dir=await fs.mkdtemp(os.tmpdir()+'/zai-tls-');
 assert.equal(spawnSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',dir+'/key','-out',dir+'/cert','-subj','/CN=api.z.ai','-addext','subjectAltName=DNS:api.z.ai','-days','1'],{stdio:'ignore'}).status,0);
 const sockets=new Set(),destinations=[],children=[];
 const tls=https.createServer({key:await fs.readFile(dir+'/key'),cert:await fs.readFile(dir+'/cert')},handler);
 tls.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});tls.on('tlsClientError',()=>{});
 await new Promise(r=>tls.listen(0,'127.0.0.1',r));
 const proxy=net.createServer(s=>{
  sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{});let buf=Buffer.alloc(0),stage=0;
  const receive=b=>{buf=Buffer.concat([buf,b]);
   if(stage===0){if(buf.length<3)return;assert.equal(buf[0],5);const length=2+buf[1];if(buf.length<length)return;buf=buf.subarray(length);stage=1;s.write(Buffer.from([5,0]));}
   if(stage===1){if(buf.length<5)return;assert.equal(buf[0],5);assert.equal(buf[1],1);assert.equal(buf[3],3);const n=buf[4];if(buf.length<7+n)return;destinations.push(buf.subarray(5,5+n).toString());assert.equal(buf.readUInt16BE(5+n),443);const rest=buf.subarray(7+n);stage=2;s.removeListener('data',receive);
    const upstream=net.connect(tls.address().port,'127.0.0.1',()=>{s.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));if(rest.length)upstream.write(rest);s.pipe(upstream);upstream.pipe(s);});sockets.add(upstream);upstream.on('close',()=>sockets.delete(upstream));upstream.on('error',()=>s.destroy());s.on('close',()=>upstream.destroy());
   }
  };s.on('data',receive);
 });await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 t.after(async()=>{for(const s of sockets)s.destroy();await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>tls.close(r))]);await fs.rm(dir,{recursive:true,force:true});});
 const launch=(exe,args,opts)=>{
  assert.equal(exe,'/usr/bin/python3');assert.deepEqual(args.slice(4),curlArgs);assert(!JSON.stringify({args,env:opts.env}).includes('SYNTHETIC_'));assert.equal(args.at(-1),endpoint);assert.deepEqual(opts.env,{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'});
  const a=[...args];a[a.indexOf('--proxy')+1]=`socks5h://127.0.0.1:${proxy.address().port}`;if(trust)a.splice(5,0,'--cacert',dir+'/cert'); // Trusted test-only CA/proxy; endpoint/SNI unchanged.
  const child=spawn(exe,a,opts);children.push(child);return child;
 };
 return {launch,destinations,children};
}