import test from 'node:test';import assert from 'node:assert/strict';import {Duplex} from 'node:stream';import {createHostWire,MAX_FRAME} from './sdk-host-wire.mjs';
function socket(){return new Duplex({read(){},write(_b,_e,cb){cb();}});}
function frame(value){const b=Buffer.from(JSON.stringify(value)),h=Buffer.alloc(4);h.writeUInt32BE(b.length);return Buffer.concat([h,b]);}
for(const [name,payload] of [
 ['oversized length',()=>{const b=Buffer.alloc(4);b.writeUInt32BE(MAX_FRAME+1);return b;}],
 ['unsolicited reply',()=>frame({kind:'reply',id:1,ok:true})],
 ['extra frame field',()=>frame({kind:'call',id:1,op:'x',authority:'forged'})],
 ['duplicate call',()=>Buffer.concat([frame({kind:'call',id:1,op:'x'}),frame({kind:'call',id:1,op:'x'})])],
 ['too many in-flight calls',()=>Buffer.concat([1,2,3].map(id=>frame({kind:'call',id,op:'x'})))]])test(name,async()=>{const s=socket(),w=createHostWire(s,()=>new Promise(()=>{}));const closed=new Promise(r=>w.onClosed(r));s.push(payload());await closed;assert.equal(s.destroyed,true);});
test('unanswered call times out and closes wire',async()=>{const s=socket(),w=createHostWire(s,()=>{}, {deadlineMs:25});await assert.rejects(w.call('x',{}),/ipc-deadline/);assert.equal(s.destroyed,true);});
test('fragmented valid frame returns bounded reply',async()=>{const s=socket();let calls=0;const w=createHostWire(s,async(op,data)=>{calls++;assert.equal(op,'hello');assert.equal(data.value,1);return {};});const b=frame({kind:'call',id:1,op:'hello',data:{value:1}});s.push(b.subarray(0,2));s.push(b.subarray(2,7));s.push(b.subarray(7));await new Promise(r=>setImmediate(r));assert.equal(calls,1);w.close();});
