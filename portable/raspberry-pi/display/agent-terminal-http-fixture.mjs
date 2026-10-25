// SPDX-License-Identifier: MIT
// Actual production HTTP router, synthetic trusted backend. No worker/provider.
import {createWorkspaceServer} from '../../workspace/server.mjs';
import readline from 'node:readline';
const id='11111111-1111-4111-8111-111111111111';
let app=null,run=null,starts=0,stops=0,startFault=false,stopFault=false;
const backend={close:async()=>{},request:async(op,params)=>{
 if(op==='status')return{agent:{available:true,mode:'scripted'},terminalAvailable:true};
 if(op==='agents.list')return{agents:run?[{id,state:run.state,alive:run.alive}]:[]};
 if(op==='agents.start'){
  if(Object.keys(params).join(',')!=='prompt'||typeof params.prompt!=='string')throw Error('fixture request shape');
  starts++;run={state:'running',alive:true,events:[{type:'agent_event',event:'text_delta',delta:'actual HTTP text\u001b]52;c;INERT\u0007'},{type:'worker_reported_done',lastText:'provisional'}]};
  if(startFault)throw Error('synthetic reply unavailable after admission');
  return{id};
 }
 if(op==='agents.events'){
  if(params.id!==id||!run)throw Error('absent');
  const offset=Buffer.byteLength(run.events.map(x=>JSON.stringify(x)+'\n').join(''));
  return{events:params.after===0?run.events:[],offset,truncated:false,state:run.state};
 }
 if(op==='agents.stop'){stops++;if(stopFault)throw Error('synthetic stop outcome unavailable');run.state='aborted';run.alive=false;return{ok:true};}
 throw Error('unsupported fixture op');
}};
const emit=x=>process.stdout.write(JSON.stringify(x)+'\n');
const rl=readline.createInterface({input:process.stdin});
for await(const line of rl){
 try{
  const cmd=JSON.parse(line);
  if(cmd.op==='listen'){app=await createWorkspaceServer({workspace:'/run/synthetic-terminal-test',port:8765,backend,readDesktopProjection:async()=>({tor:{state:'unknown'},validForMs:0})});emit({ready:true});}
  else if(cmd.op==='reset'){run=null;starts=0;stops=0;startFault=cmd.startFault===true;stopFault=cmd.stopFault===true;emit({ok:true});}
  else if(cmd.op==='finish'){run.state='done';run.alive=false;emit({ok:true});}
  else if(cmd.op==='counts')emit({starts,stops});
  else if(cmd.op==='close'){await app.close();app=null;emit({closed:true});}
  else if(cmd.op==='exit'){if(app)await app.close();emit({closed:true});break;}
  else throw Error();
 }catch{emit({fixtureError:true});}
}
