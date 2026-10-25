// Synthetic malformed peer for offline host rejection tests only.
import net from 'node:net';import {createHostWire} from './sdk-host-wire.mjs';
let body=[],mode;const token='00000000-0000-0000-0000-000000000000';
const wire=createHostWire(new net.Socket({fd:3,readable:true,writable:true}),async(op,data)=>{
 if(op==='initialize')return {};
 if(op==='body'){body.push(Buffer.from(data.chunk,'base64'));return {};}
 if(op==='prepare'){
  mode=JSON.parse(Buffer.concat(body)).messages[0].content;
  if(mode==='begin-array')await wire.call('admission-begin',[]);
  if(mode==='begin-extra')await wire.call('admission-begin',{extra:true});
  if(mode==='chunk-missing'){await wire.call('admission-begin',{});await wire.call('admission-chunk',{});}
  if(mode==='chunk-extra'){await wire.call('admission-begin',{});await wire.call('admission-chunk',{chunk:'e30=',extra:true});}
  if(mode==='end-extra'){await wire.call('admission-begin',{});await wire.call('admission-chunk',{chunk:'e30='});await wire.call('admission-end',{extra:true});}
  const reply={token,requestDigest:'a'.repeat(64),documentDigest:'b'.repeat(64)};
  if(mode==='prepare-extra')reply.extra=true;
  if(mode==='prepare-missing')delete reply.requestDigest;
  return reply;
 }
 if(op==='post'){
  if(mode==='permit-missing'||mode==='permit-extra'){
   const permit={logicalId:'synthetic_host_bad',requestDigest:'a'.repeat(64),bound:'1',policyEvidenceId:'SYNTHETIC',admissionDigest:'b'.repeat(64)};
   if(mode==='permit-missing')delete permit.bound;else permit.extra=true;
   await wire.call('permit',permit);
  }
  return {};
 }
 if(op==='pull')return mode==='done-chunk'?{done:true,chunk:'eA=='}:mode==='done-extra'?{done:true,extra:true}:mode==='chunk-extra-stream'?{chunk:'eA==',extra:true}:mode==='done-false'?{done:false}:{chunk:42};
 throw Error('unsupported');
});wire.onClosed(()=>process.exit(0));
