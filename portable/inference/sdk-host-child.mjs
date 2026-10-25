// Dedicated one-request financial child. Private FD3 control; readonly FD4 store.
import {exact} from './sdk-host-schema.mjs';
import net from 'node:net';import fs from 'node:fs';import {pathToFileURL} from 'node:url';
import {createHostWire} from './sdk-host-wire.mjs';import {createSDKAdapterChild} from './sdk-adapter-child-core.mjs';
if(process.getuid()!==972)process.exit(70);
const channel=new net.Socket({fd:3,readable:true,writable:true});const controller=new AbortController();
let core=null,state='new',config=null,bodyParts=[],bodyBytes=0,admission=null,reader=null,token=null;
const wire=createHostWire(channel,handle);wire.onClosed(()=>{controller.abort();void core?.close().finally(()=>process.exit(1));if(!core)process.exit(1);});

function privateReader(){const st=fs.fstatSync(4);const flags=Number.parseInt(fs.readFileSync('/proc/self/fdinfo/4','utf8').match(/^flags:\s+(\d+)/m)[1],8);if(!st.isFile()||st.uid!==972||(st.mode&0o077)||st.size>16384||(flags&3)!==0)throw Error('invalid-private-store');const record=Buffer.alloc(st.size);if(fs.readSync(4,record,0,record.length,0)!==record.length)throw Error('invalid-private-store');const data=JSON.parse(record.toString('utf8'));record.fill(0);if(Object.keys(data).some(k=>!['authorization','userCacheSecret','recordId','generation'].includes(k)))throw Error('invalid-private-store');return {authorization:data.authorization,userCacheSecret:data.userCacheSecret};}
async function handle(op,data){
 if(op==='initialize'){exact(data,['sdkLoaderPath','chargePolicy','logicalId']);if(state!=='new')throw Error('phase');config=data;state='body';return {};}
 if(op==='body'){exact(data,['chunk']);if(state!=='body'||typeof data.chunk!=='string'||data.chunk.length>45000)throw Error('phase');const b=Buffer.from(data.chunk,'base64');bodyBytes+=b.length;if(b.length>32768||bodyBytes>4*1024*1024)throw Error('body-limit');bodyParts.push(b);return {};}
 if(op==='prepare'){exact(data,[]);if(state!=='body')throw Error('phase');state='preparing';const body=JSON.parse(Buffer.concat(bodyParts).toString('utf8'));config.bodyText=JSON.stringify(body);bodyParts=[];
 core=createSDKAdapterChild({chargePolicy:config.chargePolicy,loadSDK:()=>import(pathToFileURL(config.sdkLoaderPath).href),rawFetch:globalThis.fetch.bind(globalThis),privateCreditReader:async()=>privateReader(),admissionPolicy:async binding=>{
   // Full document bounded independently and transferred in counted chunks.
   const bytes=Buffer.from(JSON.stringify(binding));if(bytes.length>4*1024*1024)throw Error('document-limit');exact(await wire.call('admission-begin',{}),[]);for(let n=0;n<bytes.length;n+=32768)exact(await wire.call('admission-chunk',{chunk:bytes.subarray(n,n+32768).toString('base64')}),[]);const answer=exact(await wire.call('admission-end',{}),['allowed']);if(typeof answer.allowed!=='boolean')throw Error('invalid-admission');return answer.allowed;
 },permitRawPost:async(details,signal)=>{if(signal.aborted)throw Error('aborted');return wire.call('permit',details,1500);}});
 admission=await core.prepare({logicalId:config.logicalId,body,signal:controller.signal});token=admission.handle.token;state='prepared';return {token,requestDigest:admission.requestDigest,documentDigest:admission.binding.documentDigest};}
 if(op==='post'){exact(data,['token']);if(state!=='prepared'||data.token!==token)throw Error('phase');state='posting';
 // The body is exactly the already prepared object, never accepted again.
 const body=JSON.parse(config.bodyText);const result=await core.post({handle:admission.handle,body,signal:controller.signal});reader=result.stream.getReader();state='stream';return {};}
 if(op==='pull'){exact(data,[]);if(state!=='stream')throw Error('phase');if(config.pendingBytes?.length){const b=config.pendingBytes.subarray(0,32768);config.pendingBytes=config.pendingBytes.subarray(b.length);return {chunk:b.toString('base64')};}const item=await reader.read();if(item.done){state='done';return {done:true};}const b=Buffer.from(item.value);if(b.length>8*1024*1024)throw Error('response-limit');config.pendingBytes=b.subarray(32768);return {chunk:b.subarray(0,32768).toString('base64')};}
 if(op==='close'){exact(data,[]);controller.abort();await core?.close();state='closed';return {};}
 throw Error('unknown-op');
}
