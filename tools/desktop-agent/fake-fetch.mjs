// Trusted offline process preload. Never loaded by the desktop launcher.
import assert from 'node:assert/strict';
let posts=0;
globalThis.fetch=async(url,init)=>{
 assert.equal(url,'https://api.z.ai/api/coding/paas/v4/chat/completions');assert.equal(init.redirect,'error');assert.equal(init.method,'POST');
 assert.equal(init.headers.authorization,'Bearer SYNTHETIC_KEY');posts++;
 const body=JSON.parse(init.body);assert.equal(body.model,'glm-5.3');
 return new Response('data: '+JSON.stringify({offline:true,post:posts})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
};
