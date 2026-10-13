// Offline faithful NEAR document contract: actual curated Pi context -> normal encrypted adapter.
// Only attestation verdict/transport are explicitly synthetic. No coupon/provider/account calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=process.env.ABALONE_TEST_INSTALLED_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(!root||!path.isAbsolute(root))throw Error('Exact runtime path required');
const runtime=f=>import(pathToFileURL(path.join(root,f)));
const base=fs.mkdtempSync('/dev/shm/abalone-atfile-');
for(const n of ['state','agent','work','runtime','bin'])fs.mkdirSync(path.join(base,n),{mode:0o700});
process.env.ABALONE_DIR=path.join(base,'state');process.env.ABALONE_CONFIG=root;
process.env.ABALONE_OWNED_HOST='1';
const {extract}=await runtime('lib/private-work.mjs');
const {mentions}=await runtime('lib/mediate.mjs');
const {openCouponNearAdapterForTesting,couponNearCredentialBroker}=await runtime('lib/coupon-near.mjs');
const {encrypt,decrypt}=await runtime('lib/near.mjs');
const {init}=await runtime('lib/canary.mjs');
const {browserBridge}=await runtime('lib/browser.mjs');
const {assistantText}=await runtime('lib/rpc.mjs');
const file=path.join(base,'work','selected-synthetic-document.txt');
const document='SYNTHETIC DOCUMENT ONLY\nRevenue: 7\nCost: 2\n';fs.writeFileSync(file,document,{mode:0o600});
init(path.dirname(file));
// The extraction path has no bubblewrap on PATH. Ordinary text needs no external command.
fs.writeFileSync(path.join(base,'bin','bwrap'),'#!/bin/sh\nexit 99\n',{mode:0o700});
const oldPath=process.env.PATH;process.env.PATH=path.join(base,'bin');
assert.equal(fs.statfsSync(process.env.ABALONE_DIR).type,0x01021994);
assert.equal(extract(path.join(base,'runtime'),file),document.trim());
const pdf=path.join(base,'work','synthetic.pdf');fs.writeFileSync(pdf,'synthetic PDF fixture only');
assert.throws(()=>mentions('@synthetic.pdf',path.dirname(file)),/requires pdftotext/);
assert.equal(fs.readdirSync(process.env.ABALONE_DIR).some(n=>n.startsWith('ws-')),false,'Failed extraction removes its tmpfs workspace');
delete process.env.ABALONE_OWNED_HOST;assert.throws(()=>extract(path.join(base,'runtime'),file),/extraction failed/);process.env.ABALONE_OWNED_HOST='1';
if(process.env.ABALONE_PRIOR_INSTALLED_ROOT){const old=await import(pathToFileURL(path.join(process.env.ABALONE_PRIOR_INSTALLED_ROOT,'lib/private-work.mjs')));assert.throws(()=>old.extract(path.join(base,'runtime'),file),/extraction failed/);}
process.env.PATH=oldPath;
const key=crypto.createECDH('secp256k1');key.generateKeys();
let requests=0,documentReadInEncryptedRequest=false,transportClosed=false;
const credential='only-synthetic-test-credential-not-a-provider';
const adapter=openCouponNearAdapterForTesting({baseUrl:'https://cloud-api.near.ai/v1',model:'Qwen/Qwen3.8-27B',maxTokens:512,credential,
 policy:{gatewayTcb:'UpToDate',modelTcb:'UpToDate',gpuSignature:'required',composeRegistry:{rpc:'https://mainnet.base.org',chainId:8453}},
 verifiedForTesting:{signingPublicKey:key.getPublicKey('hex'),profile:{gateway_tcb:'synthetic-only-not-hardware',model_tcb:['synthetic-only-not-hardware'],gpu:'GPU: NVIDIA verdict (synthetic-only-not-hardware)'},transport:{close:async()=>{transportClosed=true;},fetch:async(url,options)=>{
  requests++;assert.equal(requests,1,'No automatic extra request');
  const body=JSON.parse(options.body);assert.equal(body.model,'Qwen/Qwen3.8-27B');assert.equal(body.max_tokens,512);assert.equal(body.tools,undefined);
  const messages=body.messages.map(m=>({role:m.role,content:decrypt(m.content,key)}));
  const user=messages.filter(m=>m.role==='user').map(m=>m.content).join('\n');
  assert.ok(user.includes('[file selected-synthetic-document.txt'),'Actual curated @mention hook must add the document');
  assert.ok(user.includes('L2: Revenue: 7')&&user.includes('L3: Cost: 2'));
  assert.ok(user.includes('ordinary account access; no OS/network isolation'));
  assert.ok(!user.includes('Margin: 5'),'Answer must not be preloaded');documentReadInEncryptedRequest=true;
  assert.ok(!options.body.includes('Revenue: 7')&&!options.body.includes('Cost: 2'),'Selected content is ciphertext at transport');
  const client=new Headers(options.headers).get('x-client-pub-key');
  return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:encrypt('Margin: 5',client)},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n',{headers:{'content-type':'text/event-stream'}});
 }}}});
const socket=path.join(base,'runtime','coupon.sock');
const broker=await couponNearCredentialBroker({socketPath:socket,adapter});
const closeBrowser=browserBridge(path.join(base,'runtime'),{incognito:true});
const env={PATH:oldPath,HOME:path.join(base,'agent'),USER:'fixture',LANG:'C.UTF-8',ABALONE_DIR:path.join(base,'state'),ABALONE_CONFIG:root,ABALONE_EGRESS:path.join(base,'runtime'),ABALONE_INCOGNITO:'1',ABALONE_OWNED_HOST:'1',ABALONE_COUPON_SOCKET:socket,ABALONE_COUPON_MODEL:'Qwen/Qwen3.8-27B',ABALONE_COUPON_PROVIDER:'nearai',ABALONE_COUPON_MAX_TOKENS:'512',PI_CODING_AGENT_DIR:path.join(base,'agent'),TMPDIR:path.join(base,'runtime')};
const argv=[path.join(root,'vendor/pi/packages/coding-agent/dist/cli.js'),'--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--no-mcp','--no-approve','-e',path.join(root,'agents/pi/abalone.ts'),'-e',path.join(root,'agents/pi/coupon-provider.ts'),'--no-session','--mode','rpc','--model','nearai/Qwen/Qwen3.8-27B','--thinking','off'];
const child=spawn(process.execPath,argv,{env,cwd:path.dirname(file),stdio:['pipe','pipe','pipe']});
const events=[];let buffer='',stderr='';const timer=setTimeout(()=>child.kill('SIGTERM'),30000);
child.stderr.on('data',b=>stderr+=b);
child.stdout.on('data',b=>{buffer+=b;let at;while((at=buffer.indexOf('\n'))>=0){const e=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);events.push(e);if(e.type==='agent_settled')child.stdin.end();}});
child.stdin.on('error',()=>{});
child.stdin.write(JSON.stringify({id:'at-file',type:'prompt',message:'@selected-synthetic-document.txt Calculate Revenue minus Cost. Reply only: Margin: <calculated integer>. Do not use any additional tools.'})+'\n');
try{
 const [code,signal]=await new Promise(resolve=>child.once('close',(c,s)=>resolve([c,s])));clearTimeout(timer);
 assert.equal(code,0,stderr);assert.equal(signal,null);assert.ok(events.some(e=>e.type==='agent_settled'),stderr);
 assert.equal(assistantText(events),'Margin: 5',stderr);assert.equal(requests,1);assert.equal(documentReadInEncryptedRequest,true);
 assert.equal(fs.readFileSync(file,'utf8'),document);assert.equal(fs.existsSync(path.join(base,'state','node','keys.json')),false);
 console.log(JSON.stringify({result:'PASS',scope:'OFFLINE actual curated @file context + normal encrypted coupon NEAR adapter; synthetic verdict/transport only',documentReadByCuratedContext:true,encryptedWire:true,nativeToolsNotRequired:true,conversationRequests:requests,response:assistantText(events),defaultTraceKey:false,noBubblewrapExtraction:true,strictRefusalPreserved:true,priorInstalledFailureReproduced:!!process.env.ABALONE_PRIOR_INSTALLED_ROOT,paidEffects:0}));
} finally {clearTimeout(timer);child.kill('SIGTERM');await closeBrowser();await broker.close();await adapter.close();fs.rmSync(base,{recursive:true,force:true});}
