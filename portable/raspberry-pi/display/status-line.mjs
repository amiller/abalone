// SPDX-License-Identifier: MIT
// Read-only desktop status. Financial values come only from the authenticated client.
import {pathToFileURL} from 'node:url';
import {readDesktopStatus} from '../../workspace/desktop-status.mjs';
import {createCreditClient} from '../../workspace/credit-client.mjs';
import {projectAccountBalance} from '../../../lib/provider-credit-projection.mjs';

export function renderLine(desktop, credit, vaultShortcut = false, nearWarning = false) {
  const tor = desktop?.tor;
  let network = 'Tor unknown', account = 'Credit unknown';
  if (tor?.state === 'stopped' && tor.progress === null) network = 'Tor stopped';
  else if (Number.isInteger(tor?.progress) && tor.progress >= 0 && tor.progress <= 100 &&
      ((tor.state === 'starting' && tor.progress < 100) ||
       (tor.state === 'bootstrapped' && tor.progress === 100))) network = `Tor ${tor.progress}%`;
  try {
    if (credit?.state === 'configured') {
      const balance = projectAccountBalance(credit.accountBalance);
      if (balance.freshness === 'fresh') account = `Account USD ${balance.amountDecimal}`;
      else if (balance.freshness === 'stale') account = 'Credit stale';
    }
  } catch { /* Malformed projections never become terminal text. */ }
  const vault = vaultShortcut ? ' | Ctrl+Alt+F2 vault' : '';
  return `${nearWarning ? 'NEAR GPU revocation not checked | ' : ''}${network} | ${account}${vault} | Super+Enter terminal | Super+B browser`;
}

export function startStatusLine({client, readTor = readDesktopStatus,
    write = line => process.stdout.write(line + '\n'), now = () => performance.now(), intervalMs = 500,
    vaultShortcut = false, nearWarning = false} = {}) {
  let closed = false, pending = false, expiry;
  let desktop, credit, torUntil = 0, creditUntil = 0;
  const lifetime = value => Number.isInteger(value?.validForMs) && value.validForMs > 0 ? value.validForMs : 0;
  function emit() {
    if (closed) return;
    clearTimeout(expiry);
    const at = now();
    write(renderLine(at < torUntil ? desktop : null, at < creditUntil ? credit : null, vaultShortcut, nearWarning));
    const next = Math.min(...[torUntil, creditUntil].filter(deadline => deadline > at));
    if (Number.isFinite(next)) expiry = setTimeout(emit, Math.max(1, next - at));
  }
  async function poll() {
    if (closed || pending) return;
    pending = true;
    try {
      const [t, c] = await Promise.all([
        Promise.resolve().then(readTor).then(value => ({value, at:now()})),
        Promise.resolve().then(() => client.status()).then(value => ({value, at:now()})),
      ]);
      if (closed) return;
      desktop = t.value; credit = c.value;
      torUntil = t.at + Math.min(15000, lifetime(desktop));
      creditUntil = c.at + Math.min(5000, lifetime(credit));
      emit();
    } catch { desktop = credit = null; torUntil = creditUntil = 0; emit(); }
    finally { pending = false; }
  }
  emit();
  const timer = setInterval(poll, intervalMs);
  void poll();
  return async function close() {
    closed = true; clearInterval(timer); clearTimeout(expiry);
    await client.close();
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (new Set(args).size !== args.length || args.some(a => !['--vault-shortcut','--near-warning'].includes(a)) || process.getuid?.() !== 971) process.exit(2);
  const close = startStatusLine({client:createCreditClient({socketPath:'/run/portable-credit/credit.sock'}),vaultShortcut:args.includes('--vault-shortcut'),nearWarning:args.includes('--near-warning')});
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void close().finally(() => process.exit(0)); });
  process.stdout.on('error', () => { void close().finally(() => process.exit(0)); });
}
