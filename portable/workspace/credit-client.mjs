// Read-only projection consumer. Socket and identities are supervisor authority.
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs/promises';
import {peerCredential} from '../workspace-service/syscred.mjs';
import {projectAccountBalance} from '../../lib/provider-credit-projection.mjs';
const keys = (v, expected) => v && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).sort().join(',') === expected.split(',').sort().join(',');
export const unknownCredit = (state = 'unconfigured') => ({state,session:null,validForMs:0,accountBalance:null,allowance:{state:'unknown',reason:'journal-not-bound'},funding:{state:'not-configured'}});
export function validateCredit(value) {
  if (!keys(value,'version,session,state,validForMs,accountBalance,allowance,funding') || value.version!==1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.session) || !['configured','unconfigured','unavailable'].includes(value.state) || !Number.isInteger(value.validForMs) || value.validForMs<1 || value.validForMs>5000 || !keys(value.allowance,'state,reason') || value.allowance.state!=='unknown' || value.allowance.reason!=='journal-not-bound' || !keys(value.funding,'state') || value.funding.state!=='not-configured') throw Error('invalid credit projection');
  const accountBalance=projectAccountBalance(value.accountBalance);
  if(value.state!=='configured' && accountBalance.freshness!=='unknown') throw Error('invalid credit state');
  return {...unknownCredit(value.state),session:value.session,validForMs:value.validForMs,accountBalance};
}
export function createCreditClient({socketPath=null}={}) {
  if(socketPath!==null && (typeof socketPath!=='string' || socketPath.includes('\0') || !path.isAbsolute(socketPath) || path.normalize(socketPath)!==socketPath || Buffer.byteLength(socketPath)>100)) throw Error('Invalid credit socket');
  let pending=null,closed=false,lastSession=null,active=null,sequence=0;
  async function read() {
    if(closed || socketPath===null)return unknownCredit(socketPath===null?'unconfigured':'unavailable');
    if(process.getuid?.()!==971)return unknownCredit('unavailable');
    const started=performance.now(),abort=new AbortController();
    let socket,timer,authentication;
    try {
      const reply=await new Promise((resolve,reject)=>{
        const fail=()=>reject(Error('credit unavailable'));
        timer=setTimeout(()=>{abort.abort();socket?.destroy();fail();},1500);
        (async()=>{
          for(let p=path.dirname(socketPath);;p=path.dirname(p)) {
            const s=await fs.lstat(p);if(!s.isDirectory() || s.isSymbolicLink() || s.mode&0o022 || ![0,972].includes(s.uid))throw Error('unsafe credit parent');if(p==='/')break;
          }
          const s=await fs.lstat(socketPath);if(!s.isSocket() || s.uid!==972 || abort.signal.aborted)throw Error('unsafe credit socket');
          socket=net.createConnection(socketPath);active=socket;socket.pause();socket.on('error',fail);socket.on('close',fail);
          socket.once('connect',async()=>{
            try {
              authentication=peerCredential(socket._handle.fd,{python:'/usr/bin/python3',timeoutMs:1000,signal:abort.signal});
              const peer=await authentication;
              if(peer.uid!==972 || abort.signal.aborted || closed)throw Error('wrong credit peer');
              const rid=++sequence;let buffer=Buffer.alloc(0);
              socket.on('data',chunk=>{try {
                buffer=Buffer.concat([buffer,chunk]);if(buffer.length>4096)throw Error('credit frame bound');
              }catch{socket.destroy();fail();}});
              socket.on('end',()=>{try {
                const end=buffer.indexOf(10);if(end<0)throw Error('credit incomplete frame');
                if(end!==buffer.length-1)throw Error('credit trailing frame');
                const v=JSON.parse(buffer.subarray(0,end).toString('utf8'));
                if(!keys(v,'rid,ok,credit') || v.rid!==rid || v.ok!==true)throw Error('credit reply');
                resolve(validateCredit(v.credit));socket.destroy();
              }catch{socket.destroy();fail();}});
              socket.write(JSON.stringify({rid,op:'status'})+'\n');socket.resume();
            }catch{socket.destroy();fail();}
          });
        })().catch(fail);
      });
      const age=performance.now()-started;
      if(!Number.isFinite(age) || age<0 || age>=reply.validForMs)return unknownCredit('unavailable');
      const changed=lastSession!==null && lastSession!==reply.session;lastSession=reply.session;
      if(changed)return unknownCredit('unavailable'); // never carry an old account across a lease/session change
      return {...reply,validForMs:Math.floor(reply.validForMs-age)};
    }catch{return unknownCredit('unavailable');}
    finally {clearTimeout(timer);abort.abort();socket?.destroy();await authentication?.catch(()=>{});if(active===socket)active=null;}
  }
  return {status(){if(!pending)pending=read().finally(()=>{pending=null;});return pending;},async close(){closed=true;active?.destroy();await pending;}};
}
