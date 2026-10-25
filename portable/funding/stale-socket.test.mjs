import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const source=await fs.readFile(new URL('./credit-service.mjs',import.meta.url),'utf8');
const rewritten=source.replace("'../workspace-service/syscred.mjs'",JSON.stringify(new URL('../workspace-service/syscred.mjs',import.meta.url).href)).replace("'../../lib/provider-credit-projection.mjs'",JSON.stringify(new URL('../../lib/provider-credit-projection.mjs',import.meta.url).href));
const {prepareEndpoint,refusedProbe}=await import('data:text/javascript;base64,'+Buffer.from(rewritten+'\nexport {prepareEndpoint,refusedProbe};').toString('base64'));
const fixed='/run/portable-credit/credit.sock';
async function fixture(t,kind='stale') {
 const dir=await fs.mkdtemp(os.tmpdir()+'/credit-stale-'),socket=dir+'/credit.sock';
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 if(kind==='stale') {
  const child=spawn(process.execPath,['-e',`require('net').createServer().listen(${JSON.stringify(socket)},()=>process.exit(0))`]);
  assert.equal(await new Promise(r=>child.once('exit',r)),0);await fs.chmod(socket,0o666);
 }
 const lstat=fs.lstat.bind(fs),open=fs.open.bind(fs),connect=net.createConnection.bind(net);
 const map=p=>p===fixed?socket:p==='/run/portable-credit'?dir:p;
 const project=s=>Object.assign(Object.create(Object.getPrototypeOf(s)),s,{uid:972,gid:972});
 t.mock.method(fs,'lstat',async p=>project(await lstat(map(p))));
 t.mock.method(fs,'open',async(p,flags)=>{const h=await open(map(p),flags);const stat=h.stat.bind(h);h.stat=async()=>project(await stat());return h;});
 t.mock.method(net,'createConnection',p=>connect(map(p)));
 return {dir,socket,lstat,map,project};
}
test('real stale socket recovers; ownership is explicitly projected in this unprivileged test',async t=>{
 const f=await fixture(t);const old=await f.lstat(f.socket);assert(old.isSocket());const e=await prepareEndpoint(fixed,true);await e.close();await assert.rejects(f.lstat(f.socket),{code:'ENOENT'});
});
test('default refusal retains stale inode',async t=>{const f=await fixture(t);await assert.rejects(prepareEndpoint(fixed,false));assert((await f.lstat(f.socket)).isSocket());});
test('live listener is refused without request bytes',async t=>{
 const f=await fixture(t,'none');let bytes=0;const peers=[];const server=net.createServer(s=>{peers.push(s);s.on('data',b=>bytes+=b.length);});
 await new Promise(r=>server.listen(f.socket,r));await fs.chmod(f.socket,0o666);t.after(async()=>{for(const s of peers)s.destroy();await new Promise(r=>server.close(r));});
 await assert.rejects(prepareEndpoint(fixed,true));assert.equal(bytes,0);
});
test('regular file and symlink refused unchanged',async t=>{const f=await fixture(t,'none');await fs.writeFile(f.socket,'SECRET_CANARY');await assert.rejects(prepareEndpoint(fixed,true));assert.equal(await fs.readFile(f.socket,'utf8'),'SECRET_CANARY');await fs.unlink(f.socket);await fs.symlink('missing',f.socket);await assert.rejects(prepareEndpoint(fixed,true));assert((await f.lstat(f.socket)).isSymbolicLink());});
for(const [field,value] of [['uid',971],['gid',971],['mode',0o140600],['nlink',2]])test(`refuse socket ${field}`,async t=>{const f=await fixture(t);t.mock.method(fs,'lstat',async p=>{const s=f.project(await f.lstat(f.map(p)));if(s.isSocket())s[field]=value;return s;});await assert.rejects(prepareEndpoint(fixed,true));assert((await f.lstat(f.socket)).isSocket());});
test('wrong opt-in path refused',async()=>{await assert.rejects(prepareEndpoint('/tmp/other.sock',true));});
test('socket replacement after refused probe is refused',async t=>{const f=await fixture(t);let reads=0;t.mock.method(fs,'lstat',async p=>{const s=f.project(await f.lstat(f.map(p)));if(s.isSocket() && ++reads>1)s.ino++;return s;});await assert.rejects(prepareEndpoint(fixed,true));assert((await f.lstat(f.socket)).isSocket());});
test('parent replacement is refused',async t=>{const f=await fixture(t);let reads=0;t.mock.method(fs,'lstat',async p=>{const s=f.project(await f.lstat(f.map(p)));if(p==='/run/portable-credit' && ++reads>1)s.ino++;return s;});await assert.rejects(prepareEndpoint(fixed,true));assert((await f.lstat(f.socket)).isSocket());});
for(const code of ['EACCES','EAGAIN','UNKNOWN'])test(`probe ${code} refuses`,async t=>{let closed=false;t.mock.method(net,'createConnection',()=>{const s=new EventEmitter();s.destroy=()=>queueMicrotask(()=>{closed=true;s.emit('close');});queueMicrotask(()=>s.emit('error',{code}));return s;});assert.equal(await refusedProbe(fixed),false);assert(closed);});
test('probe timeout closes before refusal',async t=>{let closed=false;t.mock.method(net,'createConnection',()=>{const s=new EventEmitter();s.destroy=()=>queueMicrotask(()=>{closed=true;s.emit('close');});return s;});assert.equal(await refusedProbe(fixed),false);assert(closed);});

test('fresh default endpoint retains safe parent with other GID',async t=>{
 const f=await fixture(t,'none');
 t.mock.method(fs,'lstat',async p=>{const s=f.project(await f.lstat(f.map(p)));if(s.isDirectory())s.gid=973;return s;});
 const endpoint=await prepareEndpoint(fixed,false);await endpoint.close();
 await assert.rejects(prepareEndpoint(fixed,true));
});
