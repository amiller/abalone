#!/usr/bin/env node
// Three synthetic requests at most, with a pre-reserved catalog-price budget.
// This tool does not enable native tools in the normal client.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyNearModel } from '../lib/near.mjs';
import { encryptNearNativeRequest, nearNativeHeaders, authenticateNearNativeResponse } from '../lib/near-native-qualification.mjs';

const args = process.argv.slice(2), arg = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const model = arg('--model'), budget = Number(arg('--budget-usd')), directory = arg('--out');
const protocolOnly = args.includes('--protocol-only'), roundCount = Number(arg('--rounds') ?? 3);
if (![2, 3].includes(roundCount)) throw new Error('--rounds must be 2 or 3');
if (!model || !directory || !Number.isFinite(budget) || budget <= 0 || budget > 0.25) throw new Error('Specify --model, --budget-usd (at most 0.25), and a fresh --out directory');
const output = path.resolve(directory); fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const file = name => path.join(output, name);
const write = (name, value) => fs.writeFileSync(file(name), JSON.stringify(value, null, 2), { mode: 0o600 });
const journal = { model, budget_usd: budget, max_posts: roundCount, posts: 0, reserved_usd: 0, observed_usage_cost_usd: 0, mode: protocolOnly ? 'protocol-only' : 'strict', started_at: new Date().toISOString() };
fs.writeFileSync(file('journal.json'), JSON.stringify(journal, null, 2), { flag: 'wx', mode: 0o600 });

let key = process.env.NEARAI_API_KEY, admitted, phase = 'credential', ledgerLock = null, ledgerLockFile = null;
try {
  if (!key && args.includes('--configured-key')) {
    const records = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.abalone/node/keys.json'), 'utf8'));
    key = records.keys?.find(k => k.provider === 'nearai' && k.label === records.active?.nearai)?.key;
  }
  if (!key) throw Object.assign(new Error('key unavailable'), { code: 'configured_key_unavailable' });
  const baseUrl = 'https://cloud-api.near.ai/v1';
  const deadline = AbortSignal.timeout(120000);
  const get = async p => {
    const response = await fetch(new URL(baseUrl).origin + p, { headers: { authorization: `Bearer ${key}` }, signal: deadline, redirect: 'error' });
    if (!response.ok) throw Object.assign(new Error('read refused'), { code: `read_http_${response.status}` });
    return response;
  };
  phase = 'catalog';
  const catalog = await (await get('/v1/models')).json(), selected = catalog.data?.find(m => m.id === model);
  if (!selected || selected.owned_by !== 'nearai' || !selected.supported_features?.includes('tools')) throw Object.assign(new Error('unsupported model'), { code: 'catalog_capability_refused' });
  const inputRate = Number(selected.pricing?.prompt), outputRate = Number(selected.pricing?.completion), context = selected.context_length;
  if (!Number.isFinite(inputRate) || inputRate < 0 || !Number.isFinite(outputRate) || outputRate < 0 || Number(selected.pricing?.request) !== 0 || !Number.isSafeInteger(context) || context < 1024 || context > 2097152) throw Object.assign(new Error('unbounded pricing'), { code: 'pricing_refused' });
  const perPostReserve = context * inputRate + 128 * outputRate;
  if (perPostReserve > budget) throw Object.assign(new Error('budget too small'), { code: 'budget_refused' });
  write('catalog.json', selected);
  // Reserve an entire context window before each POST. Release only after
  // signed usage establishes its charge. Unknown failures retain their reserve.
  const ledgerFile = path.join(path.dirname(output), 'budget-ledger.json');
  ledgerLockFile = ledgerFile + '.lock'; ledgerLock = fs.openSync(ledgerLockFile, 'wx', 0o600);
  const ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) : { model, budget_usd: budget, posts: 0, unknown_reserved_usd: 0, observed_usage_cost_usd: 0 };
  if (ledger.model !== model || ledger.budget_usd !== budget || !Number.isSafeInteger(ledger.posts) || ledger.posts < 0 || !Number.isFinite(ledger.unknown_reserved_usd) || ledger.unknown_reserved_usd < 0 || !Number.isFinite(ledger.observed_usage_cost_usd) || ledger.observed_usage_cost_usd < 0) throw Object.assign(new Error('invalid ledger'), { code: 'budget_ledger_refused' });
  const saveLedger = () => fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2), { mode: 0o600 });
  saveLedger();
  phase = 'attestation';
  let report;
  const getReport = async p => { const response = await get(p); report = await response.clone().json(); return response; };
  const policy = { gatewayTcb: protocolOnly ? 'reported' : 'UpToDate', modelTcb: protocolOnly ? 'reported' : 'UpToDate', gpuSignature: 'required', composeRegistry: { rpc: 'https://mainnet.base.org', chainId: 8453 } };
  admitted = await verifyNearModel(baseUrl, model, getReport, policy);
  write('attestation.json', report); write('admission.json', admitted.profile);
  const strictTcbEligible = admitted.profile.gateway_tcb_status === 'UpToDate' && admitted.profile.model_tcb_statuses.every(status => status === 'UpToDate');
  const canaries = Array.from({ length: roundCount }, (_, i) => `synthetic_near_native_${i + 1}_${crypto.randomBytes(8).toString('hex')}`);
  const description = `Synthetic echo qualification only. ${canaries[0]}`;
  const tools = [{ type: 'function', function: { name: 'synthetic_echo', description,
    parameters: { type: 'object', properties: { value: { type: 'string', description } }, required: ['value'], additionalProperties: false } } }];
  const messages = [{ role: 'system', content: 'Use only the synthetic_echo tool. Its input and result are synthetic test values.' }];
  const rounds = [];
  for (let i = 0; i < roundCount; i++) {
    phase = `round_${i + 1}_request`;
    messages.push({ role: 'user', content: i < roundCount - 1 ? `Call synthetic_echo once with value exactly ${canaries[i]}.` : `Reply with exactly ${canaries[i]}. Do not call a tool.` });
    const input = { model, messages, tools, tool_choice: i < roundCount - 1 ? { type: 'function', function: { name: 'synthetic_echo' } } : 'none', parallel_tool_calls: false,
      stream: true, stream_options: { include_usage: true }, max_tokens: 128, chat_template_kwargs: { enable_thinking: false }, temperature: 0 };
    const body = encryptNearNativeRequest(input, admitted.signingPublicKey), request = JSON.stringify(body);
    if (Buffer.byteLength(JSON.stringify(input)) > 32768 || canaries.some(c => request.includes(c)) || request.includes('synthetic_echo')) throw Object.assign(new Error('wire canary'), { code: 'wire_canary_refused' });
    const clientKey = crypto.createECDH('secp256k1'); clientKey.generateKeys();
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...nearNativeHeaders(clientKey.getPublicKey('hex'), admitted.signingPublicKey) };
    if (journal.posts >= roundCount || ledger.posts >= 6 || ledger.observed_usage_cost_usd + ledger.unknown_reserved_usd + perPostReserve > budget) throw Object.assign(new Error('budget exhausted'), { code: 'budget_refused' });
    ledger.posts++; ledger.unknown_reserved_usd += perPostReserve; saveLedger();
    journal.posts++; journal.reserved_usd += perPostReserve; write('journal.json', journal); // count before POST; no retry
    fs.writeFileSync(file(`round-${i + 1}-request.json`), request, { mode: 0o600 });
    const response = await admitted.transport.fetch(baseUrl + '/chat/completions', { method: 'POST', headers, body: request, signal: deadline, redirect: 'error' });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream')) throw Object.assign(new Error('response refused'), { code: `chat_http_${response.status}` });
    phase = `round_${i + 1}_response`;
    const blocks = []; let bytes = 0;
    for await (const block of response.body) { bytes += block.length; if (bytes > 1048576) throw Object.assign(new Error('too much output'), { code: 'response_bounds_refused' }); blocks.push(Buffer.from(block)); }
    const raw = Buffer.concat(blocks); fs.writeFileSync(file(`round-${i + 1}-response.sse`), raw, { mode: 0o600 });
    let signature;
    const result = await authenticateNearNativeResponse({ bytes: raw, requestBytes: request, profile: admitted.profile, clientKey,
      getSignature: async id => {
        const response = await admitted.transport.fetch(baseUrl + `/signature/${encodeURIComponent(id)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`, { headers: { authorization: `Bearer ${key}` }, signal: deadline, redirect: 'error' });
        if (!response.ok) throw Object.assign(new Error('signature refused'), { code: `signature_http_${response.status}` });
        signature = await response.json();
        write(`round-${i + 1}-signature.json`, signature); return signature;
      } });
    write(`round-${i + 1}-decoded.json`, { content: result.content, reasoning: result.reasoning, calls: result.calls });
    if (!result.usage || !Number.isSafeInteger(result.usage.prompt_tokens) || !Number.isSafeInteger(result.usage.completion_tokens) || result.usage.prompt_tokens < 0 || result.usage.completion_tokens < 0) throw Object.assign(new Error('usage absent'), { code: 'usage_refused' });
    const cost = result.usage.prompt_tokens * inputRate + result.usage.completion_tokens * outputRate;
    journal.reserved_usd = Math.max(0, journal.reserved_usd - perPostReserve);
    journal.observed_usage_cost_usd += cost; write('journal.json', journal);
    ledger.unknown_reserved_usd = Math.max(0, ledger.unknown_reserved_usd - perPostReserve); ledger.observed_usage_cost_usd += cost; saveLedger();
    if (cost > perPostReserve || journal.observed_usage_cost_usd > budget) throw Object.assign(new Error('observed budget exceeded'), { code: 'usage_budget_refused' });
    phase = `round_${i + 1}_echo`;
    if (i < roundCount - 1) {
      if (result.calls.length !== 1 || result.calls[0].function.name !== 'synthetic_echo') throw Object.assign(new Error('tool unexpected'), { code: 'unexpected_tool' });
      const args = JSON.parse(result.calls[0].function.arguments);
      if (Object.keys(args).join() !== 'value' || args.value !== canaries[i]) throw Object.assign(new Error('argument changed'), { code: 'echo_argument_refused' });
      messages.push({ role: 'assistant', content: result.content || null, ...(result.reasoning ? { reasoning_content: result.reasoning } : {}), tool_calls: result.calls });
      messages.push({ role: 'tool', tool_call_id: result.calls[0].id, name: 'synthetic_echo', content: JSON.stringify({ value: args.value }) });
    } else if (result.calls.length || result.content.slice(result.content.indexOf('</think>') < 0 ? 0 : result.content.indexOf('</think>') + 8).trim() !== canaries[i]) throw Object.assign(new Error('final answer incorrect'), { code: 'final_answer_refused' });
    rounds.push({ round: i + 1, chat_id: result.id, finish: result.finish, tool_calls: result.calls.length, model_signature_verified: true, encrypted_fields_verified: true, usage: result.usage, usage_cost_usd: cost });
    write('rounds.json', rounds);
  }
  write('result.json', { protocol_qualified: true, strict_tcb_eligible: strictTcbEligible, private_work_enabled: false,
    model, gateway_compose: admitted.profile.gateway_compose, model_composes: admitted.profile.compose_hashes, rounds, observed_usage_cost_usd: journal.observed_usage_cost_usd,
    gateway_independent_request_integrity_qualified: false, limits: ['trusted gateway request-hash authority not qualified', 'source-to-deployment closure not established', 'normal provider integration and independent review outstanding'] });
  console.log(JSON.stringify({ protocol_qualified: true, strict_tcb_eligible: strictTcbEligible, model, posts: journal.posts, observed_usage_cost_usd: journal.observed_usage_cost_usd }));
} catch (error) {
  const code = typeof error.code === 'string' && /^[a-zA-Z0-9_]+$/.test(error.code) ? error.code : 'qualification_refused';
  write('result.json', { protocol_qualified: false, phase, code, posts: journal.posts, reserved_usd: journal.reserved_usd, observed_usage_cost_usd: journal.observed_usage_cost_usd });
  console.log(JSON.stringify({ protocol_qualified: false, phase, code, posts: journal.posts })); process.exitCode = 1;
} finally { key = null; await admitted?.transport.close(); if (ledgerLock !== null) { fs.closeSync(ledgerLock); fs.unlinkSync(ledgerLockFile); } }
