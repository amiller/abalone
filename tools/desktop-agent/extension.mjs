// Trusted local desktop profile. Contains no key and imports no portable code.
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createBrokerProvider} from '../../agents/pi/broker-provider.mjs';
import {inferenceSocketFetch} from '../../lib/inference-socket.mjs';
export default async function (pi) {
  const config=JSON.parse(fs.readFileSync(process.env.DSMACK_DESKTOP_PROFILE,'utf8'));
  pi.registerProvider(await createBrokerProvider({sdkPath:config.sdk,profile:{
    id:'desktop-broker',name:'Dsmack desktop development (Zai, cost unknown)',
    model:'glm-5.3',modelName:'GLM-5.3 development (cost unknown)',maxTokens:2048,contextWindow:32768,reasoning:true,
    streamOptions:{reasoning:'low',reasoningEffort:'low',maxTokens:2048},
    compat:{supportsReasoningEffort:true,thinkingFormat:'zai',supportsStrictMode:true,zaiToolStream:true},
    thinkingLevelMap:{off:null,minimal:null,low:'low',medium:null,high:'high',xhigh:null,max:'max'},
  },fetchFactory:options=>inferenceSocketFetch(config.socket,{requestId:randomUUID(),signal:options.signal})}));
  pi.on('session_start',(_event,ctx)=>ctx.ui.notify('Desktop development: direct Zai; no Tor, sandbox or same-user key isolation. Cost metadata unknown.','warning'));
}
