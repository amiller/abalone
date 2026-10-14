import { seal, open } from './crypto.mjs';

function object(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('object required');
  for (const field of Object.keys(value)) if (!allowed.includes(field)) throw new Error(`unsupported field: ${field}`);
  for (const field of required) if (!Object.hasOwn(value, field)) throw new Error(`missing field: ${field}`);
  return value;
}
function text(value, nullable = false) {
  if (nullable && value === null) return value;
  if (typeof value !== 'string') throw new Error('string required');
  return value;
}
function id(value) {
  text(value);
  if (!/^[A-Za-z0-9_.:/-]{1,256}$/.test(value)) throw new Error('invalid structural identifier');
  return value;
}
function array(value) { if (!Array.isArray(value)) throw new Error('array required'); return value; }
function json(value, depth = 0) {
  if (depth > 32) throw new Error('schema nesting exceeds bound');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const item of value) json(item, depth + 1); return; }
  object(value, Object.keys(value ?? {}));
  for (const [name, item] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('unsafe schema key');
    json(item, depth + 1);
  }
}
function call(value, transform, partial = false) {
  object(value, ['id', 'index', 'type', 'function'], partial ? [] : ['id', 'type', 'function']);
  const out = { ...value };
  if ('id' in value) id(value.id);
  if ('index' in value && (!Number.isSafeInteger(value.index) || value.index < 0)) throw new Error('invalid tool index');
  if ('type' in value && value.type !== 'function') throw new Error('unsupported tool type');
  if ('function' in value) {
    object(value.function, ['name', 'arguments'], partial ? [] : ['name', 'arguments']);
    out.function = Object.fromEntries(Object.entries(value.function).map(([name, field]) => [name, transform(text(field))]));
  }
  return out;
}
function message(value, transform, partial = false) {
  object(value, ['role', 'content', 'name', 'reasoning_content', 'reasoning', 'refusal', 'tool_calls', 'tool_call_id'], partial ? [] : ['role', 'content']);
  if ('role' in value && !['system', 'user', 'assistant', 'tool'].includes(value.role)) throw new Error('unsupported role');
  if ('tool_call_id' in value) id(value.tool_call_id);
  const out = { ...value };
  for (const name of ['content', 'name', 'reasoning_content', 'reasoning', 'refusal']) {
    if (name in value) out[name] = value[name] === null && name !== 'name' ? null : transform(text(value[name]));
  }
  if ('tool_calls' in value) out.tool_calls = array(value.tool_calls).map((item) => call(item, transform, partial));
  return out;
}
export function encryptRequest(request, modelKey) {
  object(request, ['model', 'messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'max_tokens', 'stream', 'temperature', 'top_p', 'stop'], ['model', 'messages', 'max_tokens', 'stream']);
  id(request.model);
  if (!Number.isSafeInteger(request.max_tokens) || request.max_tokens <= 0 || request.stream !== true) throw new Error('stream and positive output bound required');
  const transform = (value) => seal(value, modelKey);
  const out = { ...request, messages: array(request.messages).map((value) => message(value, transform)) };
  for (const name of ['temperature', 'top_p']) if (name in request && !Number.isFinite(request[name])) throw new Error('invalid generation number');
  if ('parallel_tool_calls' in request && typeof request.parallel_tool_calls !== 'boolean') throw new Error('invalid parallel flag');
  // Stop strings are sensitive generation content and this narrow codec does not have a verified wire rule for them.
  if ('stop' in request) throw new Error('stop strings unsupported');
  if ('tools' in request) {
    const tools = array(request.tools);
    if (!tools.length) throw new Error('empty tools unsupported');
    out.tools = tools.map((tool) => {
      object(tool, ['type', 'function'], ['type', 'function']);
      if (tool.type !== 'function') throw new Error('unsupported tool type');
      object(tool.function, ['name', 'description', 'parameters', 'strict'], ['name', 'parameters']);
      json(tool.function.parameters);
      const fn = { name: transform(text(tool.function.name)), parameters: transform(JSON.stringify(tool.function.parameters)) };
      if ('description' in tool.function) fn.description = transform(text(tool.function.description));
      if ('strict' in tool.function) { if (typeof tool.function.strict !== 'boolean') throw new Error('invalid strict flag'); fn.strict = tool.function.strict; }
      return { type: 'function', function: fn };
    });
  }
  if ('tool_choice' in request) {
    if (!out.tools) throw new Error('tool choice without tools');
    if (typeof request.tool_choice === 'string') {
      if (!['auto', 'none', 'required'].includes(request.tool_choice)) throw new Error('unsupported tool choice');
    } else {
      object(request.tool_choice, ['type', 'function'], ['type', 'function']);
      if (request.tool_choice.type !== 'function') throw new Error('unsupported tool choice type');
      object(request.tool_choice.function, ['name'], ['name']);
      out.tool_choice = { type: 'function', function: { name: transform(text(request.tool_choice.function.name)) } };
    }
  }
  return out;
}
export function decryptChunk(chunk, secret) {
  object(chunk, ['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier'], ['choices']);
  if ('id' in chunk) id(chunk.id);
  if ('model' in chunk) id(chunk.model);
  const out = { ...chunk, choices: array(chunk.choices).map((choice) => {
    object(choice, ['index', 'delta', 'finish_reason', 'logprobs'], ['index']);
    if (!Number.isSafeInteger(choice.index) || choice.index !== 0) throw new Error('only one response choice supported');
    if ('logprobs' in choice && choice.logprobs !== null) throw new Error('logprobs unsupported');
    if ('finish_reason' in choice && ![null, 'stop', 'length', 'tool_calls', 'content_filter'].includes(choice.finish_reason)) throw new Error('unknown finish reason');
    const result = { ...choice };
    if ('delta' in choice) {
      if ('role' in choice.delta && choice.delta.role !== 'assistant') throw new Error('non-assistant response role');
      result.delta = message(choice.delta, (field) => open(field, secret), true);
    }
    return result;
  }) };
  if ('usage' in chunk && chunk.usage !== null) {
    object(chunk.usage, ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_tokens_details', 'completion_tokens_details'], ['prompt_tokens', 'completion_tokens', 'total_tokens']);
    for (const name of ['prompt_tokens', 'completion_tokens', 'total_tokens']) if (!Number.isSafeInteger(chunk.usage[name]) || chunk.usage[name] < 0) throw new Error('invalid token usage');
    for (const [name, fields] of [['prompt_tokens_details', ['cached_tokens']], ['completion_tokens_details', ['reasoning_tokens']]]) {
      if (name in chunk.usage && chunk.usage[name] !== null) {
        object(chunk.usage[name], fields);
        for (const value of Object.values(chunk.usage[name])) if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid token details');
      }
    }
  }
  return out;
}
