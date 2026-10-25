// Private inherited-FD protocol, never a worker-facing socket.
import {EventEmitter} from 'node:events';
export const MAX_FRAME=65536;
export function createHostWire(socket, handler, {deadlineMs=60000}={}) {
 const events=new EventEmitter(),pending=new Map();let buffer=Buffer.alloc(0),next=1,closed=false,inflight=0,lastReceived=0;
 function fail(){if(closed)return;closed=true;socket.destroy();for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('ipc-closed'));}pending.clear();events.emit('closed');}
 async function send(frame){if(closed)throw Error('ipc-closed');const json=Buffer.from(JSON.stringify(frame));if(json.length>MAX_FRAME)throw Error('ipc-frame-limit');const head=Buffer.alloc(4);head.writeUInt32BE(json.length);const bytes=Buffer.concat([head,json]);if(socket.write(bytes))return;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();fail();reject(Error('ipc-write-deadline'));},2000);const cleanup=()=>{clearTimeout(timer);socket.off('drain',drain);socket.off('close',close);};const drain=()=>{cleanup();resolve();};const close=()=>{cleanup();reject(Error('ipc-closed'));};socket.once('drain',drain);socket.once('close',close);});}
 function receive(frame){
  if(!frame||typeof frame!=='object'||!Number.isSafeInteger(frame.id)||frame.id<1){fail();return;}
  if(frame.kind==='reply'){if(Object.keys(frame).some(k=>!['kind','id','ok','data'].includes(k))||typeof frame.ok!=='boolean'){fail();return;}const p=pending.get(frame.id);if(!p){fail();return;}pending.delete(frame.id);clearTimeout(p.timer);frame.ok===true?p.resolve(frame.data):p.reject(Error('child-operation-refused'));return;}
  if(frame.kind!=='call'||Object.keys(frame).some(k=>!['kind','id','op','data'].includes(k))||typeof frame.op!=='string'||frame.op.length>64||frame.id<=lastReceived||inflight>=2){fail();return;}
  lastReceived=frame.id;inflight++;Promise.resolve().then(()=>handler(frame.op,frame.data)).then(data=>send({kind:'reply',id:frame.id,ok:true,data}),()=>send({kind:'reply',id:frame.id,ok:false})).catch(fail).finally(()=>inflight--);
 }
 socket.on('data',chunk=>{if(closed)return;if(buffer.length+chunk.length>2*MAX_FRAME+8){fail();return;}buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4){const n=buffer.readUInt32BE();if(n<1||n>MAX_FRAME){fail();return;}if(buffer.length<n+4)return;let frame;try{frame=JSON.parse(buffer.subarray(4,n+4).toString('utf8'));}catch{fail();return;}buffer=buffer.subarray(n+4);receive(frame);if(closed)return;}});
 socket.on('error',fail);socket.on('close',fail);
 function call(op,data,timeoutMs=deadlineMs){if(closed||pending.size>=2)return Promise.reject(Error('ipc-capacity'));const id=next++;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('ipc-deadline'));fail();},timeoutMs);pending.set(id,{resolve,reject,timer});send({kind:'call',id,op,data}).catch(fail);});}
 return {call,close:fail,onClosed:fn=>events.once('closed',fn)};
}
