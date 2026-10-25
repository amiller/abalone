import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const helper = fileURLToPath(new URL('./workspace-files.py', import.meta.url));
const failure = code => Object.assign(new Error(`Workspace file operation: ${code}`), {code});
export function createWorkspaceFiles(workspace) {
  let root = null, starting = null, closed = false, closing = null;
  const active = new Set();
  const start = () => starting ??= (async()=>{
    if (closed) throw failure('closing');
    root = await open(workspace, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (closed) { await root.close(); root = null; throw failure('closing'); }
  })();
  async function request(operation, path) {
    if (closed) throw failure('closing');
    if (!['list','read'].includes(operation) || typeof path !== 'string' || Buffer.byteLength(path)>2048) throw failure('invalid_request');
    await start();
    if (closed) throw failure('closing');
    if (active.size >= 4) throw failure('busy');
    return new Promise((resolve,reject)=>{
      const child = spawn('/usr/bin/python3',['-I',helper],{cwd:'/',env:{LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe',root.fd]});
      let output = '', size = 0, error = null, reapTimer = null;
      let done; const reaped = new Promise(r=>done=r);
      const entry = {kill:()=>child.kill('SIGKILL'),reaped}; active.add(entry);
      const fail = code => { error ??= failure(code); child.kill('SIGKILL'); reapTimer ??= setTimeout(()=>reject(error),1000); };
      const timer = setTimeout(()=>fail('timeout'),3000);
      child.on('error',()=>{error ??= failure('unavailable');});
      child.stdin.on('error',()=>{});
      child.stdout.on('data',b=>{size+=b.length;if(size>800000)fail('too_large');else output+=b.toString('utf8');});
      child.stderr.on('data',b=>{size+=b.length;if(size>800000)fail('too_large');});
      child.on('close',code=>{
        clearTimeout(timer);clearTimeout(reapTimer);active.delete(entry);done();
        if(error || code!==0)return reject(error ?? failure('unavailable'));
        try {const result=JSON.parse(output);if(result.ok!==true)throw failure(result.code ?? 'unavailable');resolve(result);}catch(e){reject(e);}
      });
      child.stdin.end(JSON.stringify({operation,path}));
    });
  }
  function close(){return closing ??= (async()=>{closed=true;await starting?.catch(()=>{});for(const entry of active)entry.kill();let timer;try { await Promise.race([Promise.all([...active].map(e=>e.reaped)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure('cleanup_failed')),1000);})]); } finally {clearTimeout(timer);}await root?.close();root=null;})();}
  return {start,request,close};
}
