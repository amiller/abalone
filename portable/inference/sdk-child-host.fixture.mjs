// Synthetic SDK ONLY for private IPC tests; provides no attestation evidence.
import assert from 'node:assert/strict';
export class SecureClient {
 constructor(options){assert.equal(options.userCacheSecret,'SYNTHETIC_CACHE_SECRET');assert.equal(process.getuid(),972);assert.equal(process.env.HOME,undefined);assert.equal(process.env.SHOULD_NOT_INHERIT,undefined);}
 async ready(){}
 getVerificationDocument(){return {securityVerified:true,configRepo:'tinfoilsh/confidential-model-router',releaseDigest:'a'.repeat(64),hpkePublicKey:'SYNTHETIC_NOT_VERIFIED'};}
 getBaseURL(){return 'https://api.ppq.ai/private/';}getEnclaveURL(){return 'https://synthetic.invalid';}
 async fetch(url,init){const body=JSON.parse(init.body);if(body.messages[0].content==='permit')return fetch(url,init);if(body.messages[0].content==='stall'){process.on('SIGTERM',()=>{});return new Promise(()=>{});}return new Response('x'.repeat(150000));}
}
