#!/usr/bin/env node
// Read-only experimental evidence check; does not admit a provider or prove running state.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(root, 'vendor/phala-aci/package.json'));
const { getCollateralAndVerify, INTEL_PCS_URL } = require('@phala/dcap-qvl');
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
if (!args.includes('--evidence') || !option('--evidence')) throw new Error('Specify --evidence capture-directory');
const directory = path.resolve(option('--evidence'));
const capture = JSON.parse(fs.readFileSync(path.join(directory, 'capture.json')));
const rawPath = path.join(directory, 'attestation.raw.json');
const raw = fs.readFileSync(rawPath);
if (raw.length > 8 * 1024 * 1024 || !/^[0-9a-f]{64}$/.test(capture.nonce)) throw new Error('Invalid capture bounds or nonce');
if (crypto.createHash('sha256').update(raw).digest('hex') !== capture.raw_sha256) throw new Error('Capture hash mismatch');
const encoding = args.includes('--action-encoding') ? option('--action-encoding') : 'canonical-string-v1';
// Recompute from raw evidence, never trust a pre-written manager-bindings verdict.
const summary = JSON.parse(execFileSync('python3', [path.join(root, 'tools/near-deployment-evidence.py'), '--inspect-only', '--raw', rawPath, '--nonce', capture.nonce, '--action-encoding', encoding], { maxBuffer: 1048576 }));
const report = JSON.parse(raw), models = [];
for (const binding of summary.managers) {
  const model = report.model_attestations[binding.model_index], cm = model.compose_manager_attestation;
  if (!/^(?:[0-9a-f]{2})+$/i.test(cm.quote) || !/^(?:[0-9a-f]{2})+$/i.test(model.intel_quote)) throw new Error('Invalid quote encoding');
  const verified = await getCollateralAndVerify(Buffer.from(cm.quote, 'hex'), INTEL_PCS_URL);
  const td = verified.report.asTd10();
  if (Buffer.from(td.reportData).toString('hex') !== binding.actions_sha256 + capture.nonce) throw new Error('Manager quote binding mismatch');
  const outer = await getCollateralAndVerify(Buffer.from(model.intel_quote, 'hex'), INTEL_PCS_URL);
  const ot = outer.report.asTd10();
  if (Buffer.from(ot.reportData).subarray(32).toString('hex') !== capture.nonce) throw new Error('Model quote nonce mismatch');
  const measurements = ['mrTd', 'rtMr0', 'rtMr1', 'rtMr2', 'rtMr3'].map(field => {
    if (!td[field] || !ot[field] || !Buffer.from(td[field]).equals(Buffer.from(ot[field]))) throw new Error(`Manager/model ${field} mismatch`);
    return { field, equal: true };
  });
  models.push({ model_index: binding.model_index, quote_verified: true, actions_digest_bound: true, nonce_bound: true,
    tcb_status: verified.status, advisory_ids: verified.advisory_ids, model_tcb_status: outer.status,
    measurements, action_count: binding.action_count, action_encoding: binding.action_encoding,
    action_history_is_running_state: false, deployment_source_closed: false });
}
const result = { raw_sha256: summary.raw_sha256, checked_at: new Date().toISOString(), models, private_work_enabled: false };
fs.writeFileSync(path.join(directory, 'manager-quote-verification.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(result));
