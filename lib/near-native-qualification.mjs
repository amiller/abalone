// Experimental qualification codec. Normal providers do not import this module.
// Sensitive fields follow inference-proxy efd600a4's all-fields ECDSA path.
import { encrypt, decrypt, chatSignatureFails } from './near.mjs';

export const NEAR_NATIVE_PI_COMPAT = Object.freeze({ supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens',
  thinkingFormat: 'chat-template', chatTemplateKwargs: Object.freeze({ enable_thinking: Object.freeze({ $var: 'thinking.enabled' }) }) });

const authenticatedResults = new WeakSet();
const deepFreeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };

const refuse = (code) => { throw Object.assign(new Error(`NEAR native qualification: ${code}`), { code }); };
const record = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const shape = (v, required, optional = []) => {
  if (!record(v) || required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => ![...required, ...optional].includes(k))) refuse('unsupported_shape');
};
const text = (v) => { if (typeof v !== 'string') refuse('unsupported_text'); return v; };
const publicId = (v) => { if (typeof v !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(v)) refuse('invalid_metadata_id'); };
const number = (v, min, max) => { if (!Number.isFinite(v) || v < min || v > max) refuse('invalid_parameter'); };
const fields = ['content', 'reasoning_content', 'reasoning', 'refusal', 'name'];

export function encryptNearNativeRequest(input, modelPublicKey) {
  const body = structuredClone(input);
  shape(body, ['model', 'messages', 'stream', 'max_tokens'], ['tools', 'tool_choice', 'parallel_tool_calls', 'stream_options', 'chat_template_kwargs', 'temperature', 'top_p']);
  publicId(body.model.replaceAll('/', ':'));
  if (body.stream !== true || !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 512 || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 64) refuse('invalid_request');
  if (Object.hasOwn(body, 'temperature')) number(body.temperature, 0, 2);
  if (Object.hasOwn(body, 'top_p')) number(body.top_p, 0, 1);
  if (Object.hasOwn(body, 'parallel_tool_calls') && typeof body.parallel_tool_calls !== 'boolean') refuse('invalid_parameter');
  if (body.stream_options) { shape(body.stream_options, ['include_usage']); if (body.stream_options.include_usage !== true) refuse('invalid_parameter'); }
  if (body.chat_template_kwargs) { shape(body.chat_template_kwargs, ['enable_thinking']); if (typeof body.chat_template_kwargs.enable_thinking !== 'boolean') refuse('invalid_parameter'); }
  const seal = v => v === '' ? '' : encrypt(text(v), modelPublicKey);
  for (const message of body.messages) {
    shape(message, ['role'], [...fields, 'tool_calls', 'tool_call_id']);
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) refuse('unsupported_role');
    if (message.content == null && message.role !== 'assistant') refuse('missing_content');
    if (message.role === 'tool' && !Object.hasOwn(message, 'tool_call_id')) refuse('missing_tool_id');
    if (Object.hasOwn(message, 'tool_call_id')) publicId(message.tool_call_id);
    for (const field of fields) if (message[field] != null) message[field] = seal(message[field]);
    if (message.tool_calls != null) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length || message.tool_calls.length > 8) refuse('invalid_tool_history');
      for (const call of message.tool_calls) {
        shape(call, ['id', 'type', 'function']); publicId(call.id);
        if (call.type !== 'function') refuse('unsupported_tool_type');
        shape(call.function, ['name', 'arguments']);
        call.function.name = seal(call.function.name); call.function.arguments = seal(call.function.arguments);
      }
    }
  }
  if (body.tools != null) {
    if (!Array.isArray(body.tools) || body.tools.length > 8) refuse('invalid_tools');
    for (const tool of body.tools) {
      shape(tool, ['type', 'function']);
      if (tool.type !== 'function') refuse('unsupported_tool_type');
      shape(tool.function, ['name', 'parameters'], ['description', 'strict']);
      if (!record(tool.function.parameters)) refuse('invalid_schema');
      if (Object.hasOwn(tool.function, 'strict') && typeof tool.function.strict !== 'boolean') refuse('invalid_parameter');
      tool.function.name = seal(tool.function.name);
      if (tool.function.description != null) tool.function.description = seal(tool.function.description);
      tool.function.parameters = seal(JSON.stringify(tool.function.parameters));
    }
  }
  if (body.tool_choice != null && !['none', 'auto', 'required'].includes(body.tool_choice)) {
    shape(body.tool_choice, ['type', 'function']);
    if (body.tool_choice.type !== 'function') refuse('unsupported_tool_type');
    shape(body.tool_choice.function, ['name']); body.tool_choice.function.name = seal(body.tool_choice.function.name);
  }
  return body;
}

export const nearNativeHeaders = (clientPublicKey, modelPublicKey) => ({
  'X-Signing-Algo': 'ecdsa', 'X-Client-Pub-Key': clientPublicKey.replace(/^04(?=.{128}$)/, ''),
  'X-Model-Pub-Key': modelPublicKey, 'X-Encryption-Version': '2', 'X-Encrypt-All-Fields': 'true',
});

// Public metadata is deliberately separate: model/call IDs, roles, types,
// token counts and timing remain visible. This is not arbitrary-JSON encryption.
const counts = (value, allowed) => {
  if (value == null) return;
  shape(value, [], allowed);
  if (Object.values(value).some(n => !Number.isSafeInteger(n) || n < 0)) refuse('invalid_usage_metadata');
};
const usageMetadata = usage => {
  if (usage == null) return;
  shape(usage, [], ['prompt_tokens', 'completion_tokens', 'total_tokens', 'reasoning_tokens', 'prompt_tokens_details', 'completion_tokens_details']);
  counts(Object.fromEntries(Object.entries(usage).filter(([key]) => !key.endsWith('_details'))), ['prompt_tokens', 'completion_tokens', 'total_tokens', 'reasoning_tokens']);
  counts(usage.prompt_tokens_details, ['cached_tokens', 'audio_tokens']);
  counts(usage.completion_tokens_details, ['reasoning_tokens', 'audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens']);
};

export function parseNearNativeSse(bytes, model) {
  let raw;
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { refuse('invalid_utf8'); }
  if (!raw.endsWith('\n\n') && !raw.endsWith('\r\n\r\n')) refuse('truncated_stream');
  const chunks = []; let done = false, id = null, finish = null;
  for (const event of raw.split(/\r?\n\r?\n/)) {
    if (!event.trim()) continue;
    // The upstream proxy adds this exact transport padding without hashing it.
    // No executable or sensitive field can be placed in a skipped comment.
    if (event === ': keep-alive') continue;
    const lines = event.split(/\r?\n/).filter(line => line !== '');
    if (lines.some(line => !line.startsWith('data:'))) refuse('unsupported_sse_event');
    const value = lines.map(line => line.slice(5).trimStart()).join('\n').trim();
    if (done) refuse('data_after_done');
    if (value === '[DONE]') { done = true; continue; }
    let chunk; try { chunk = JSON.parse(value); } catch { refuse('invalid_json'); }
    shape(chunk, ['choices'], ['id', 'object', 'created', 'model', 'usage', 'system_fingerprint']);
    if ((chunk.object != null && chunk.object !== 'chat.completion.chunk') || (chunk.created != null && (!Number.isSafeInteger(chunk.created) || chunk.created < 0))) refuse('invalid_public_metadata');
    if (chunk.system_fingerprint != null) publicId(chunk.system_fingerprint);
    usageMetadata(chunk.usage);
    if (!Array.isArray(chunk.choices)) refuse('invalid_choices');
    if (chunk.id != null) { publicId(chunk.id); if (id && chunk.id !== id) refuse('changed_chat_id'); id = chunk.id; }
    if (chunk.model != null && chunk.model !== model) refuse('changed_model');
    if (chunk.choices.length > 1) refuse('unsupported_choices');
    for (const choice of chunk.choices) {
      shape(choice, ['index', 'delta'], ['finish_reason', 'logprobs', 'matched_stop']);
      if (choice.index !== 0 || choice.logprobs != null || (choice.matched_stop != null && (!Number.isSafeInteger(choice.matched_stop) || choice.matched_stop < 0))) refuse('unsupported_choices');
      shape(choice.delta, [], ['role', ...fields.slice(0, 4), 'tool_calls']);
      if (choice.delta.role != null && choice.delta.role !== 'assistant') refuse('invalid_role');
      if (finish && Object.keys(choice.delta).length) refuse('data_after_finish');
      if (choice.finish_reason != null) {
        if (finish || !['stop', 'tool_calls', 'length', 'content_filter'].includes(choice.finish_reason)) refuse('invalid_finish');
        finish = choice.finish_reason;
      }
    }
    chunks.push(chunk);
  }
  if (!done || !id || !finish || ['length', 'content_filter'].includes(finish)) refuse('incomplete_response');
  // Signature verification uses original bytes. Any unhashable keepalive is
  // removed only as a complete exact frame, never by searching inside JSON.
  const signatureBytes = Buffer.from(raw.replace(/(^|\r?\n\r?\n): keep-alive\r?\n\r?\n/g, '$1'));
  return { chunks, id, finish, signatureBytes };
}

export async function authenticateNearNativeResponse({ bytes, requestBytes, profile, clientKey, getSignature }) {
  profile = structuredClone(profile);
  const parsed = parseNearNativeSse(bytes, profile.model);
  const signature = await getSignature(parsed.id);
  if (signature?.signature_kind !== 'provider_tee' || signature.signing_algo !== 'ecdsa') refuse('wrong_signer_kind');
  try { if (chatSignatureFails(signature, requestBytes, parsed.signatureBytes, profile)) refuse('signature_refused'); }
  catch { refuse('signature_refused'); }
  const open = v => {
    if (v === '') return '';
    if (typeof v !== 'string' || !/^(?:[0-9a-fA-F]{2}){93,}$/.test(v)) refuse('plaintext_or_malformed_field');
    try { return decrypt(v, clientKey); } catch { refuse('ciphertext_refused'); }
  };
  const chunks = structuredClone(parsed.chunks), calls = new Map(); let content = '', reasoning = '', refusal = '', usage = null;
  for (const chunk of chunks) {
    if (chunk.usage) usage = chunk.usage;
    for (const choice of chunk.choices) {
      const delta = choice.delta;
      for (const field of fields.slice(0, 4)) if (delta[field] != null) delta[field] = open(delta[field]);
      content += delta.content ?? ''; refusal += delta.refusal ?? ''; reasoning += delta.reasoning_content ?? delta.reasoning ?? '';
      if (delta.tool_calls != null) {
        if (!Array.isArray(delta.tool_calls) || !delta.tool_calls.length) refuse('invalid_tool_calls');
        for (const call of delta.tool_calls) {
          shape(call, ['index'], ['id', 'type', 'function']);
          if (!Number.isSafeInteger(call.index) || call.index < 0 || call.index > 7 || (call.type != null && call.type !== 'function')) refuse('invalid_tool_calls');
          let combined = calls.get(call.index);
          if (!combined) { combined = { id: null, type: 'function', function: { name: '', arguments: '' } }; calls.set(call.index, combined); }
          if (call.id != null) { publicId(call.id); if (combined.id && combined.id !== call.id) refuse('changed_tool_id'); combined.id = call.id; }
          if (call.function != null) {
            shape(call.function, [], ['name', 'arguments']);
            for (const field of ['name', 'arguments']) if (call.function[field] != null) {
              call.function[field] = open(call.function[field]); combined.function[field] += call.function[field];
            }
          }
        }
      }
    }
  }
  if ((parsed.finish === 'tool_calls') !== (calls.size > 0)) refuse('tool_finish_mismatch');
  const ids = new Set();
  for (const call of calls.values()) {
    if (!call.id || ids.has(call.id) || !call.function.name) refuse('incomplete_tool_call');
    ids.add(call.id);
    try { if (!record(JSON.parse(call.function.arguments))) refuse('invalid_tool_arguments'); } catch { refuse('invalid_tool_arguments'); }
  }
  const result = deepFreeze({ model: profile.model, id: parsed.id, finish: parsed.finish, content, reasoning, refusal, calls: [...calls.values()], usage, chunks });
  authenticatedResults.add(result); return result;
}

// Pi expects the complete function name in the first tool delta. Consolidate
// authenticated fragments before handing them to its ordinary tool parser.
export function authenticatedNearNativeSse(result) {
  if (!authenticatedResults.has(result)) refuse('unauthenticated_result');
  const delta = { role: 'assistant', content: result.content };
  if (result.reasoning) delta.reasoning_content = result.reasoning;
  if (result.refusal) delta.refusal = result.refusal;
  if (result.calls.length) delta.tool_calls = result.calls.map((call, index) => ({ index, ...call }));
  const chunk = { id: result.id, model: result.model, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: result.finish }], usage: result.usage };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}
