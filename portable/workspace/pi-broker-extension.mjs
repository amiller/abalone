// SPDX-License-Identifier: MIT
// Trusted native Pi CLI extension: the financial broker retains all credentials.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createBrokerProvider } from './broker-provider.mjs';

const SDK = '/opt/portable/vendor/pi/sdk-broker-v4/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
const SOCKET = '/run/portable-inference/near.sock';
const STATUS = 'http://127.0.0.1:8765/api/status';
// Written by the inference service after each admission (portable/inference/teep-capture.mjs).
const ADMISSION = '/run/portable-inference/attestation/latest/status.json';
const GUIDE = new URL('./agent-guide.md', import.meta.url);
const VAULT_SESSIONS = '/run/portable-vault/agent/sessions';
// The Linux console font has no braille, so Pi's default spinner shows '?'.
const SPINNER = { frames: ['|', '/', '-', '\\'], intervalMs: 150 };

export function statusText(status, mountinfo) {
  const { state, progress } = status.desktop.tor;
  const tor = state === 'bootstrapped' ? 'Tor ok' : state === 'starting' ? `Tor ${progress}%` : `Tor ${state}`;
  const vault = mountinfo.split('\n').some(line => line.split(' ')[4] === '/run/portable-vault') ? 'Vault unlocked' : 'Vault locked';
  const balance = status.credit.accountBalance;
  const credit = balance ? `Credit $${Number(balance.amountDecimal).toFixed(2)}${balance.freshness === 'fresh' ? '' : ' (' + balance.freshness + ')'}` : `Credit ${status.credit.state}`;
  return `${tor} | ${vault} | ${credit}`;
}

// The NEAR bridge buffers the whole answer; the broker sees no progress until it is complete.
export const waitingText = seconds => `Waiting for the encrypted answer over Tor | ${seconds}s`;

const tokens = n => n < 1000 ? `${n}` : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
export function usageText(entries, context) {
  let sent = 0, received = 0;
  for (const e of entries) if (e.type === 'message' && e.message.role === 'assistant') { sent += e.message.usage.input; received += e.message.usage.output; }
  const percent = context?.percent == null ? '?' : `${Math.round(context.percent)}%`;
  return `Tokens: ${tokens(sent)} sent, ${tokens(received)} received | context ${percent} of ${context ? tokens(context.contextWindow) : '?'}`;
}

// Only what the latest admission recorded; nothing is claimed without it.
export function admissionText(record) {
  if (record.error) return { route: 'not admitted', tee: `TEE: admission record unreadable (${record.error})` };
  const a = record.admission;
  if (!a) return { route: 'not admitted', tee: 'TEE: no admission yet' };
  const instance = /^[a-z0-9-]+-(i[0-9]+)\.completions\.near\.ai$/.exec(a.instance)?.[1];
  const firmware = { 'up-to-date': 'TEE: model firmware up to date', 'out-of-date': `TEE: model firmware OUT OF DATE (${a.advisoryIds?.filter(id => id.startsWith('INTEL-SA-')).length} Intel advisories)` }[a.firmware];
  const gpu = { checked: 'GPU revocation checked', 'not checked': 'GPU revocation not checked' }[a.gpuRevocation];
  if (a.route !== 'direct' || !instance || !firmware || !gpu) return { route: 'not admitted', tee: 'TEE: unrecognized admission record' };
  return { route: `direct ${instance}, attested`, tee: `${firmware} | ${gpu}` };
}

// From pi's own session manager, so the line follows what pi actually writes.
export function sessionText(sessionManager) {
  const file = sessionManager.getSessionFile();
  if (file === undefined) return 'Session: NOT SAVED (RAM only, gone at exit)';
  return path.dirname(file) === VAULT_SESSIONS ? `Session: SAVED to vault: ${path.basename(file)}` : `Session: SAVED to ${file} (NOT the vault)`;
}

export const filesText = cwd => cwd.startsWith('/run/portable-vault/') ? `Files: KEPT in vault, ${cwd}` : `Files: NOT KEPT, ${cwd} is not the vault`;

export const answerText = (seconds, message) => `Last answer ${seconds}s, ${message.usage.output} tokens`;

async function readStatus() {
  const response = await fetch(STATUS);
  if (!response.ok) throw Error(`status service HTTP ${response.status}`);
  return statusText(await response.json(), await fs.readFile('/proc/self/mountinfo', 'utf8'));
}
const readAdmission = () => fs.readFile(ADMISSION, 'utf8').then(JSON.parse, error => error.code === 'ENOENT' ? {} : { error: error.code ?? error.message });

export default async function (pi) {
  pi.registerProvider(await createBrokerProvider(SDK, SOCKET));
  const guide = await fs.readFile(GUIDE, 'utf8');
  let poll, tick, started, tui, status = 'Status pending', admission = admissionText({}), answer = 'No answer yet';
  const refresh = () => Promise.all([
    readStatus().then(text => { status = text; }, error => { status = `Status error: ${error.message}`; }),
    readAdmission().then(record => { admission = admissionText(record); }, error => { admission = admissionText({ error: error.message }); }),
  ]).then(() => tui?.requestRender());
  const stopWaiting = ctx => { clearInterval(tick); started = undefined; ctx.ui.setWorkingMessage(); };

  pi.on('session_start', (_event, ctx) => {
    ctx.ui.setWorkingIndicator(SPINNER);
    // ASCII only and at most ~100 columns: the Linux console font lacks most symbols.
    ctx.ui.setFooter(t => {
      tui = t;
      return { invalidate() {}, dispose() { tui = undefined; }, render: width => [
        filesText(process.cwd()),
        sessionText(ctx.sessionManager),
        usageText(ctx.sessionManager.getEntries(), ctx.getContextUsage()),
        `${status} | ${ctx.model.name} (${admission.route})`,
        `${answer} | ${admission.tee}`,
      ].map(line => line.slice(0, width)) };
    });
    poll = setInterval(refresh, 5000);
    return refresh();
  });
  pi.on('session_shutdown', () => { clearInterval(poll); clearInterval(tick); });
  pi.on('before_agent_start', (event, ctx) => ({ systemPrompt: `${event.systemPrompt}\n${guide}- This run: ${filesText(process.cwd())}; ${sessionText(ctx.sessionManager)}\n` }));
  pi.on('before_provider_request', (_event, ctx) => {
    clearInterval(tick);
    started = performance.now();
    ctx.ui.setWorkingMessage(waitingText(0));
    tick = setInterval(() => ctx.ui.setWorkingMessage(waitingText(Math.round((performance.now() - started) / 1000))), 1000);
  });
  pi.on('message_end', (event, ctx) => {
    if (event.message.role !== 'assistant' || started === undefined) return;
    answer = answerText(Math.round((performance.now() - started) / 1000), event.message);
    stopWaiting(ctx);
    void refresh();
  });
  pi.on('agent_end', (_event, ctx) => stopWaiting(ctx));
  pi.on('tool_execution_start', (event, ctx) => ctx.ui.setWorkingMessage(`Running ${event.toolName} on the Pi`));
}
