// SPDX-License-Identifier: MIT
// Trusted caller supplies the profile and fetch factory; no platform discovery.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
export async function createBrokerProvider({sdkPath, profile, fetchFactory}) {
  if (!profile || typeof profile.id !== 'string' || typeof profile.model !== 'string' || !Number.isSafeInteger(profile.maxTokens) || profile.maxTokens < 1 || !Number.isSafeInteger(profile.contextWindow) || typeof fetchFactory !== 'function') throw new Error('Trusted broker profile required');
  const entry = fs.realpathSync(sdkPath);
  const codingRoot = path.dirname(path.dirname(entry));
  if (path.basename(entry) !== 'index.js' || path.basename(path.dirname(entry)) !== 'dist') throw new Error('Unsupported SDK entry');
  let packageDir;
  if (path.basename(codingRoot) === 'pi-coding-agent' && path.basename(path.dirname(codingRoot)) === '@earendil-works') {
    packageDir = path.join(path.dirname(codingRoot), 'pi-ai');
  } else if (path.basename(codingRoot) === 'coding-agent' && path.basename(path.dirname(codingRoot)) === 'packages') {
    const root = path.dirname(path.dirname(codingRoot));
    packageDir = path.join(root, 'packages/ai');
  } else throw new Error('Unsupported SDK package layout');
  // Exact sibling inside the admitted closure, never ancestor NODE_PATH/HOME.
  if (fs.realpathSync(packageDir) !== packageDir) throw new Error('SDK provider package escapes closure');
  const metadata = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  if (metadata.name !== '@earendil-works/pi-ai' || metadata.exports?.['.']?.import !== './dist/index.js' || metadata.exports?.['./compat']?.import !== './dist/compat.js') throw new Error('Unsupported SDK provider exports');
  const { createProvider } = await import(pathToFileURL(path.join(packageDir, 'dist/index.js')).href);
  const { openAICompletionsApi } = await import(pathToFileURL(path.join(packageDir, 'dist/compat.js')).href);
  const api = openAICompletionsApi();
  const wrap = method => (model, context, options = {}) => api[method](model, context, {
    ...options, ...profile.streamOptions, fetch: fetchFactory(options), maxRetries: 0,
  });
  return createProvider({
    id: profile.id, name: profile.name, baseUrl: 'http://inference-broker.invalid/v1',
    auth: {apiKey: {name: 'Local socket dummy', resolve: async () => ({auth: {apiKey: 'inference-broker-session'}})}},
    models: [{id: profile.model, name: profile.modelName, api: 'openai-completions',
      provider: profile.id, baseUrl: 'http://inference-broker.invalid/v1',
      compat: {supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens', ...profile.compat},
      ...(profile.thinkingLevelMap ? {thinkingLevelMap: profile.thinkingLevelMap} : {}),
      reasoning: profile.reasoning === true, input: ['text'], contextWindow: profile.contextWindow, maxTokens: profile.maxTokens,
      // SDK requires numeric metadata. Zero is a placeholder, not a price.
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}],
    api: {stream: wrap('stream'), streamSimple: wrap('streamSimple')},
  });
}
