// One fixed read-only provider operation; no URLs, proxy or executable from users.
import {spawn} from 'node:child_process';
import {ppqBalanceEndpoint} from '../../lib/provider-balance.mjs';
const refused=()=>Error('balance-transport-unavailable');
export const curlArguments=Object.freeze(['-q','--silent','--show-error','--proxy','socks5h://127.0.0.1:9050','--noproxy','','--proto','=https','--proto-redir','=https','--tlsv1.2','--max-time','10','--connect-timeout','5','--max-filesize','65536','--request','POST','--header','content-type: application/json','--header','accept: application/json','--data-binary','@-','--write-out','\n%{http_code}',ppqBalanceEndpoint]);
export function ppqBalanceTransport(request,{signal}={}) {return runBalanceCurl(request,{signal},spawn);}

// Internal fixture seam. Production entry calls only ppqBalanceTransport above.
export async function runBalanceCurl(request,{signal}={},spawnProcess) {
  if(signal?.aborted || !request || Object.keys(request).sort().join(',')!=='body,headers,method,url' || request.url!==ppqBalanceEndpoint || request.method!=='POST' || typeof request.body!=='string' || Buffer.byteLength(request.body)>4096 || !request.headers || Object.keys(request.headers).sort().join(',')!=='accept,content-type' || request.headers.accept!=='application/json' || request.headers['content-type']!=='application/json')throw refused();
  let body;
  try {body=JSON.parse(request.body);}catch{throw refused();}
  if(!body || Object.keys(body).join(',')!=='credit_id' || typeof body.credit_id!=='string' || !body.credit_id || body.credit_id.length>512)throw refused();
  return new Promise((resolve,reject)=>{
    let child,ended=false,failed=false,bytes=0,errors=0,parts=[],timer,killTimer;
    const stop=()=>{
      failed=true;
      if(child && !ended){child.kill('SIGTERM');if(!killTimer)killTimer=setTimeout(()=>child.kill('SIGKILL'),100);}
    };
    const finish=(code)=>{
      ended=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',stop);
      if(failed || code!==0){reject(refused());return;}
      const output=Buffer.concat(parts);
      if(output.length<4 || output[output.length-4]!==10 || !/^[0-9]{3}$/.test(output.subarray(-3).toString('ascii'))){reject(refused());return;}
      const status=Number(output.subarray(-3).toString('ascii'));
      if(status<100 || status>599){reject(refused());return;}
      resolve({status,body:output.subarray(0,-4).toString('utf8')});
    };
    try {
      child=spawnProcess('/usr/bin/curl',curlArguments,{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe']});
      child.on('error',()=>{failed=true;});
      child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>65540){stop();return;}parts.push(chunk);});
      child.stderr.on('data',chunk=>{errors+=chunk.length;if(errors>8192)stop();});
      child.stdin.on('error',stop);
      child.once('close',finish);
      signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
      timer=setTimeout(stop,11000);
      child.stdin.end(request.body);
    } catch {stop();if(!child)finish(1);}
  });
}
