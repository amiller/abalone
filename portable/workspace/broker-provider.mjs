// SPDX-License-Identifier: MIT
// Platform profiles remain fixed; shared adapter has no portable dependency.
import {randomUUID} from 'node:crypto';
import {createBrokerProvider as createSharedProvider} from '../../agents/pi/broker-provider.mjs';
import {inferenceSocketFetch} from '../../lib/inference-socket.mjs';
const ppqProfile = Object.freeze({ model: 'private/gpt-oss-120b', thinkingLevel: 'off', development: false });
const zaiProfile = Object.freeze({ model: 'glm-5.3', thinkingLevel: 'low', development: true });
const nearProfile = Object.freeze({ model: 'z-ai/glm-5.3-flash', thinkingLevel: 'off', development: false, near: true });
// Only the trusted supervisor CLI selects this fixed socket. Jobs cannot select it.
export function brokerProfile(socketPath) {
  return socketPath === '/run/portable-inference/near.sock' ? nearProfile : socketPath === '/run/portable-inference/zai.sock' ? zaiProfile : ppqProfile;
}

export async function createBrokerProvider(sdkPath, socketPath) {
  const p = brokerProfile(socketPath);
  return createSharedProvider({sdkPath, profile: {
    id: 'portable-broker', model: p.model,
    name: p.near ? 'Dsmack NEAR encrypted route' : p.development ? 'Dsmack Zai development (cost unknown)' : 'Dsmack inference broker (cost unknown here)',
    modelName: p.near ? 'NEAR GLM-5.3 Flash' : p.development ? 'GLM-5.3 development (cost unknown)' : 'Broker-admitted model (cost unknown)',
    // NEAR routes up to 100k tokens to these base instances (model/list providerConfig.long_context.base_max_context_tokens).
    maxTokens: p.development ? 1024 : p.near ? 16384 : 4096, contextWindow: p.near ? 100_000 : 32768, reasoning: p.development,
    streamOptions: p.development ? {reasoning: 'low', reasoningEffort: 'low', maxTokens: 1024} : p.near ? {reasoning: undefined, maxTokens: 16384, timeoutMs: 2_460_000} : {},
    compat: p.development ? {supportsReasoningEffort: true, thinkingFormat: 'zai', supportsStrictMode: true, zaiToolStream: true} : {},
    ...(p.development ? {thinkingLevelMap: {off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max'}} : {}),
  }, // NEAR answers may take up to the broker's 2430 s limit; the SDK's and socket's 600 s defaults would cut them first.
  fetchFactory: options => inferenceSocketFetch(socketPath, {requestId: randomUUID(), signal: options.signal, ...(p.near ? {timeoutMs: 2_460_000} : {})})});
}
