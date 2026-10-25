import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {runBalanceCurl,curlArguments} from './ppq-balance-curl.mjs';
import {ppqBalanceEndpoint} from '../../lib/provider-balance.mjs';
const secret='SYNTHETIC_CREDIT_CANARY';
const request={url:ppqBalanceEndpoint,method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({credit_id:secret})};
function fixture(code,onSpawn=()=>{}) {
  return (executable,args,options)=>{
    assert.equal(executable,'/usr/bin/curl');assert.equal(args,curlArguments);
    assert.ok(!args.join(' ').includes(secret));assert.equal(args[0],'-q');
    assert.deepEqual(options.env,{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'});
    assert.ok(args.includes('socks5h://127.0.0.1:9050'));assert.ok(!args.includes('--location'));
    const child=spawn(process.execPath,['-e',code],options);onSpawn(child);return child;
  };
}
test('fixed command, credential only stdin and bounded response/status',async()=>{
  const result=await runBalanceCurl(request,{},fixture(`let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{if(JSON.parse(input).credit_id!==${JSON.stringify(secret)})process.exit(2);process.stdout.write('{"balance":2.5}\\n200');});`));
  assert.deepEqual(result,{status:200,body:'{"balance":2.5}'});
});
test('wrong endpoint/method/header and extra credential fields never spawn',async()=>{
  for(const invalid of [{...request,url:'https://example.invalid/'},{...request,method:'GET'},{...request,headers:{...request.headers,authorization:secret}},{...request,body:JSON.stringify({credit_id:secret,extra:true})}])
    await assert.rejects(runBalanceCurl(invalid,{},()=>{throw Error('must not spawn');}),/balance-transport-unavailable/);
});
for(const [name,code] of [
  ['nonzero exit',`process.stderr.write(${JSON.stringify(secret)});process.exit(7);`],
  ['malformed status',`process.stdout.write('{"balance":2.5}\\nXYZ');`],
  ['oversized body',`process.stdout.write('x'.repeat(70000));`],
  ['oversized diagnostic',`process.stderr.write('x'.repeat(9000));setInterval(()=>{},1000);`],
])test(name+' refuses with sanitized error after reap',async()=>{
  let child;
  await assert.rejects(runBalanceCurl(request,{},fixture(code,c=>child=c)),e=>e.message==='balance-transport-unavailable'&&!String(e).includes(secret));
  assert.throws(()=>process.kill(child.pid,0),{code:'ESRCH'});
});
test('abort waits for TERM-resistant child to be killed and reaped',async()=>{
  const controller=new AbortController();let child;
  const pending=runBalanceCurl(request,{signal:controller.signal},fixture(`process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000);`,c=>{child=c;c.stdout.once('data',()=>controller.abort());}));
  await assert.rejects(pending,/balance-transport-unavailable/);
  assert.throws(()=>process.kill(child.pid,0),{code:'ESRCH'});
  assert.equal(child.signalCode,'SIGKILL');
});
