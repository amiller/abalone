// Exact private IPC schemas. Authority checks remain in the host/core.
function invalid(){throw Error('invalid-ipc-payload');}
export function exact(data,keys){if(data===null||typeof data!=='object'||Array.isArray(data)||Object.getPrototypeOf(data)!==Object.prototype||Object.keys(data).length!==keys.length||keys.some(k=>!Object.hasOwn(data,k)))invalid();return data;}
const string=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max;
const digest=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
export function hostCall(op,data){
 if(op==='admission-begin'||op==='admission-end')return exact(data,[]);
 if(op==='admission-chunk'){exact(data,['chunk']);if(typeof data.chunk!=='string'||data.chunk.length>45000)invalid();return data;}
 if(op==='permit'){exact(data,['logicalId','requestDigest','bound','policyEvidenceId','admissionDigest']);if(!string(data.logicalId,256)||!digest(data.requestDigest)||!digest(data.admissionDigest)||!string(data.policyEvidenceId,1024)||typeof data.bound!=='string'||!/^(0|[1-9][0-9]{0,127})$/.test(data.bound))invalid();return data;}
 invalid();
}
export function prepareReply(data){exact(data,['token','requestDigest','documentDigest']);if(typeof data.token!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(data.token)||!digest(data.requestDigest)||!digest(data.documentDigest))invalid();return data;}
export function streamReply(data){if(data?.done===true){exact(data,['done']);return data;}exact(data,['chunk']);if(typeof data.chunk!=='string'||data.chunk.length>45000)invalid();return data;}
