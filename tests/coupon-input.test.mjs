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

test('terminalLine discards what follows the line and names too-long input, ended input and missing bash', () => {
  const code = `import fs from 'node:fs';import {terminalLine} from ${JSON.stringify(inputModule)};
try{const line=await terminalLine('Prompt: ');console.log(JSON.stringify({line,rest:fs.readFileSync(0,'utf8')}))}catch(e){console.log(JSON.stringify({error:e.message,code:e.code}))}`;
  const run = (input, env = process.env) => JSON.parse(spawnSync(process.execPath, ['--input-type=module', '-e', code], { input, env, encoding: 'utf8' }).stdout);
  assert.deepEqual(run('first line\nsecond line\nthird'), { line: 'first line', rest: '' });
  assert.deepEqual(run(`${'x'.repeat(2000)}\n`), { error: 'That line is longer than 1024 bytes, so it was refused; run the command again and enter one line.', code: 'credit_input_refused' });
  assert.deepEqual(run(''), { error: 'Terminal input ended before a line was entered; run the command again.', code: 'credit_input_refused' });
  assert.deepEqual(run('line\n', { ...process.env, PATH: '/nonexistent' }), { error: 'Reading the terminal needs bash, which could not be started; install bash and run the command again.', code: 'credit_input_refused' });
});
