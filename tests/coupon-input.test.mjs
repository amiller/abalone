import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

const inputModule = new URL('../lib/coupon-input.mjs', import.meta.url).href;
const fixture = `import {couponEntry} from ${JSON.stringify(inputModule)};
let heartbeat=false;setTimeout(()=>{heartbeat=true;console.log('heartbeat')},50);
const value=await couponEntry('TEST_COUPON_FD','Hidden coupon: ',true);
console.log(JSON.stringify({matches:value==='synthetic-test-input',heartbeat}));`;

test('dedicated pipe stays asynchronous while input is pending', async (t) => {
  const child = spawn(process.execPath,['--input-type=module','-e',fixture],
    {env:{...process.env,TEST_COUPON_FD:'3'},stdio:['ignore','pipe','pipe','pipe']});
  t.after(()=>child.kill());
  let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);
  const closed=once(child,'close');
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Input blocked the event loop')),1500);
    const check=c=>{if(c.toString().includes('heartbeat')){clearTimeout(timer);child.stdout.off('data',check);resolve()}};
    child.stdout.on('data',check);
  });
  child.stdio[3].end('synthetic-test-input\n');
  assert.deepEqual(await closed,[0,null]);assert.equal(err,'');
  assert.deepEqual(JSON.parse(out.trim().split('\n').at(-1)),{matches:true,heartbeat:true});
});

test('normal hidden terminal input leaves event loop responsive without echoing input', async () => {
  const python = `import os,pty,subprocess,select,json,sys
master,slave=pty.openpty()
env=dict(os.environ);env.pop('TEST_COUPON_FD',None)
p=subprocess.Popen([sys.argv[1],'--input-type=module','-e',sys.argv[2]],stdin=slave,stdout=subprocess.PIPE,stderr=slave,env=env)
os.close(slave)
ready=bool(select.select([p.stdout],[],[],2)[0])
first=p.stdout.readline() if ready else b''
os.write(master,b'synthetic-test-input\\n')
rest=p.communicate(timeout=5)[0]
terminal=b''
while select.select([master],[],[],0)[0]:
 try: terminal+=os.read(master,4096)
 except OSError: break
os.close(master)
lines=(first+rest).decode().strip().splitlines()
print(json.dumps({'heartbeatBeforeInput':ready and first==b'heartbeat\\n','result':json.loads(next(line for line in lines if line.startswith('{'))),'hidden':b'synthetic-test-input' not in terminal,'exit':p.returncode}))`;
  const child=spawn('python3',['-c',python,process.execPath,fixture],{stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);
  assert.deepEqual(await once(child,'close'),[0,null]);assert.equal(err,'');
  assert.deepEqual(JSON.parse(out),{heartbeatBeforeInput:true,result:{matches:true,heartbeat:true},hidden:true,exit:0});
});

test('missing terminal and malformed descriptor refuse without echoing descriptor', async () => {
  for(const fd of [undefined,'malformed-private-input']){
    const env={...process.env};delete env.TEST_COUPON_FD;if(fd!==undefined)env.TEST_COUPON_FD=fd;
    const code=`import {couponEntry} from ${JSON.stringify(inputModule)};try{await couponEntry('TEST_COUPON_FD','Prompt')}catch(e){console.log(e.message);process.exitCode=2}`;
    const child=spawn(process.execPath,['--input-type=module','-e',code],{env,stdio:['ignore','pipe','pipe']});
    let out='';child.stdout.on('data',c=>out+=c);
    assert.deepEqual(await once(child,'close'),[2,null]);
    assert.match(out,fd===undefined?/requires your terminal/:/Invalid coupon input descriptor/);
    assert.ok(!out.includes('malformed-private-input'));
  }
});

test('terminalLine discards what follows the line, never blocks when nothing waits, and names each refusal', () => {
  const pty = (steps, body) => JSON.parse(spawnSync('python3', ['-I', new URL('./usability/pty.py', import.meta.url).pathname, '20', JSON.stringify(steps), '--', process.execPath, '--input-type=module', '-e',
    `import {terminalLine} from ${JSON.stringify(inputModule)};try{${body}}catch(e){console.log('@'+JSON.stringify({error:e.message,code:e.code}))}`], { encoding: 'utf8' }).stdout);
  const result = (r) => { assert.equal(r.timedOut, false, r.output); return JSON.parse(r.output.split('@').at(-1)); };
  assert.deepEqual(result(pty([['Prompt: ', 'first line\rsecond line\rpartial'], ['Next: ', 'fresh\r']],
    `const {spawnSync:s}=await import('node:child_process'),g=()=>s('stty',['-g'],{stdio:['inherit','pipe','inherit'],encoding:'utf8'}).stdout,before=g();
    const a=await terminalLine('Prompt: ',{hidden:true}),b=await terminalLine('Next: ');console.log('@'+JSON.stringify({a,b,restored:before===g()}))`)), { a: 'first line', b: 'fresh', restored: true });
  const idle = result(pty([['Prompt: ', 'x\r']], "const t=Date.now(),a=await terminalLine('Prompt: ',{fresh:true});console.log('@'+JSON.stringify({a,ms:Date.now()-t}))"));
  assert.equal(idle.a, 'x'); assert.ok(idle.ms < 2000, `${idle.ms} ms`);
  const refused = (error) => ({ error, code: 'credit_input_refused' });
  assert.deepEqual(result(pty([['Prompt: ', `${'x'.repeat(2000)}\r`]], "await terminalLine('Prompt: ')")), refused('That line is longer than 1024 bytes, so it was refused; run the command again and enter one line.'));
  assert.deepEqual(result(pty([['Prompt: ', '\x04']], "await terminalLine('Prompt: ')")), refused('Terminal input ended before a line was entered; run the command again.'));
  assert.deepEqual(result(pty([], "process.env.PATH='/nonexistent';await terminalLine('Prompt: ')")), refused('Reading the terminal needs bash, which could not be started; install bash and run the command again.'));
  const piped = spawnSync(process.execPath, ['--input-type=module', '-e', `import {terminalLine} from ${JSON.stringify(inputModule)};await terminalLine('Prompt: ').catch((e)=>console.log(e.message))`], { input: 'line\n', encoding: 'utf8' });
  assert.equal(piped.stdout.trim(), 'Standard input is not a terminal; run the command again at a terminal.');
});
