// SPDX-License-Identifier: MIT
// Agent wallet: Zkool's own zkool_graphql server, run as the wallet owner, behind a narrow socket for the agent.
// Spends need the operator's keypress on this service's VT (approve mode) or fit a ZEC cap (cap mode).
// The seed, the database and the zkool_graphql JWT key never leave this process tree.
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const zats = zec => {
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(zec);
  if (!m) throw Error(`not a ZEC amount: ${zec}`);
  return Number(m[1]) * 1e8 + Number((m[2] ?? '').padEnd(8, '0'));
};
export const zec = z => (z / 1e8).toFixed(8).replace(/\.?0+$/, '');

// Why this spend needs the operator, or null when it fits the cap.
export function approvalReason(policy, spentZats, costZats) {
  if (policy.mode === 'approve') return 'every payment needs approval';
  if (policy.mode !== 'cap') throw Error(`unknown approval mode: ${policy.mode}`);
  if (costZats > zats(policy.perSpendZec)) return `above the per-payment cap of ${policy.perSpendZec} ZEC`;
  if (spentZats + costZats > zats(policy.sessionZec)) return `over the session cap of ${policy.sessionZec} ZEC (${zec(spentZats)} ZEC already sent)`;
  return null;
}

export const promptText = ({ amount, fee, address, memo, reason }) => [
  '\x1b[2J\x1b[H=== The agent asks to pay from the wallet ===', '',
  `Amount  ${amount} ZEC`, `Fee     ${fee} ZEC`, `To      ${address}`, `Memo    ${memo ?? '(none)'}`, `Why     ${reason}`, '',
  'y = send      n = refuse      (refused after 120 s)', ''].join('\r\n');

export function jwtSigner() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
    token() {
      const data = `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64({ sub: 0, write: true, exp: Math.floor(Date.now() / 1000) + 300 })}`;
      return `${data}.${crypto.sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    },
  };
}

export function graphql(url, signer) {
  return async (query, variables) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${signer.token()}` }, body: JSON.stringify({ query, variables }) });
    if (!r.ok) throw Error(`zkool_graphql HTTP ${r.status}: ${await r.text()}`);
    const j = await r.json();
    if (j.errors) throw Error(j.errors.map(e => e.message).join('; '));
    return j.data;
  };
}

// gql: GraphQL client; approve(text) resolves {ok, finish(text)} after showing text to the operator.
export function wallet({ gql, id, policy, approve }) {
  let spent = 0;
  const sync = () => gql('mutation($id:Int!){synchronizeAccount(idAccount:$id)}', { id });
  const ops = {
    async balance() {
      await sync();
      const { balanceByAccount } = await gql('query($id:Int!){balanceByAccount(idAccount:$id){height total orchard sapling transparent}}', { id });
      return { ...balanceByAccount, policy: { ...policy, sessionSentZec: zec(spent) } };
    },
    async transactions() {
      await sync();
      const { transactionsByAccount: txs } = await gql('query($id:Int!){transactionsByAccount(idAccount:$id){id txid height time value fee}}', { id });
      return { transactions: await Promise.all(txs.slice(0, 20).map(async ({ id: tx, ...t }) =>
        ({ ...t, memos: (await gql('query($id:Int!,$tx:Int!){memosByTransaction(idAccount:$id,idTransaction:$tx)}', { id, tx })).memosByTransaction }))) };
    },
    async address() {
      const { addressByAccount } = await gql('query($id:Int!){addressByAccount(idAccount:$id){ua}}', { id });
      return { address: addressByAccount.ua };
    },
    async send({ address, amount, memo }) {
      if (typeof address !== 'string' || typeof amount !== 'string' || !(memo === undefined || typeof memo === 'string')) throw Error('send needs address and amount (ZEC, decimal string) and an optional memo');
      const want = zats(amount);
      await sync();
      const { prepareSend } = await gql('query($id:Int!,$p:Payment!){prepareSend(idAccount:$id,payment:$p)}', { id, p: { recipients: [{ address, amount, memo }] } });
      const { decodePczt: plan } = await gql('query($p:String!){decodePczt(pczt:$p){fee recipients{address value}}}', { p: prepareSend });
      if (!plan.recipients.some(o => o.address === address && zats(o.value) === want)) throw Error(`the planned transaction does not pay ${amount} ZEC to ${address}: ${JSON.stringify(plan)}`);
      const fee = zats(plan.fee);
      const reason = approvalReason(policy, spent, want + fee);
      const shown = reason && await approve(promptText({ amount: zec(want), fee: zec(fee), address, memo, reason }));
      try {
        if (shown && !shown.ok) throw Error(shown.why);
        const { signTx } = await gql('query($id:Int!,$p:String!){signTx(idAccount:$id,pczt:$p)}', { id, p: prepareSend });
        // broadcastTx returns lightwalletd's error message in place of the txid on rejection.
        const { broadcastTx: txid } = await gql('query($t:String!){broadcastTx(txBytes:$t)}', { t: signTx });
        if (!/^[0-9a-f]{64}$/.test(txid)) throw Error(`lightwalletd rejected the transaction: ${txid}`);
        spent += want + fee;
        await shown?.finish(`Sent. txid ${txid}`);
        return { txid, amount: zec(want), fee: zec(fee), approvedBy: reason ? 'operator' : 'cap' };
      } catch (e) {
        await shown?.finish(`Not sent: ${e.message}`);
        throw e;
      }
    },
  };
  let queue = Promise.resolve();
  return request => {
    const op = ops[request.op];
    if (!op) return Promise.reject(Error(`unknown op: ${request.op}`));
    return (queue = queue.then(() => op(request), () => op(request)));
  };
}

// Operator approval on this service's controlling VT (systemd TTYPath). The agent's processes cannot type here.
export function vtApproval(input, output) {
  const vt = fs.readlinkSync('/proc/self/fd/0').match(/^\/dev\/tty(\d+)$/)[1];
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const readKey = ms => new Promise(resolve => {
    const armed = Date.now() + 1000; // drop keys still in flight from what the operator was typing elsewhere
    const done = key => { clearTimeout(timer); input.off('data', on); input.pause(); resolve(key); };
    const on = d => { const k = d.toString(); if (Date.now() >= armed && /^(y+|n+|\x1b)$/.test(k)) done(k[0]); };
    const timer = setTimeout(() => done(null), ms);
    input.setRawMode(true);
    input.on('data', on);
    input.resume();
  });
  return async text => {
    const back = execFileSync('fgconsole').toString().trim();
    execFileSync('chvt', [vt]);
    output.write(text);
    const key = await readKey(120000);
    const why = key === 'y' ? null : key ? 'the operator refused this payment' : 'no answer within 120 s; payment refused';
    output.write(key === 'y' ? 'Approved, sending...\r\n' : `${why}\r\n`);
    return { ok: key === 'y', why, async finish(line) { output.write(`${line}\r\n`); await wait(3000); execFileSync('chvt', [back]); } };
  };
}

export async function accountId(gql, source, name) {
  const { accounts } = await gql('query($n:String){accounts(accountFilter:{name:$n}){id}}', { n: name });
  if (accounts.length) return accounts[0].id;
  if (!fs.existsSync(source)) throw Error(`${source} does not exist: open the wallet on the desktop (Super+W) once`);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(source, { readOnly: true });
  const rows = db.prepare('SELECT seed, passphrase, aindex, birth, use_internal FROM accounts WHERE name = ?').all(name);
  db.close();
  if (rows.length !== 1 || !rows[0].seed) throw Error(`${source} must hold one account named ${name} with a seed; found ${rows.length}`);
  const [r] = rows;
  const { createAccount } = await gql('mutation($a:NewAccount!){createAccount(newAccount:$a)}',
    { a: { name, key: r.seed, passphrase: r.passphrase, aindex: r.aindex, birth: r.birth, useInternal: Boolean(r.use_internal) } });
  return createAccount;
}

async function main(configPath) {
  const c = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  approvalReason(c.approval, 0, 0);
  const run = process.env.RUNTIME_DIRECTORY;
  const signer = jwtSigner();
  fs.writeFileSync(`${run}/jwt.pub`, signer.publicPem, { mode: 0o600 });
  fs.mkdirSync(path.dirname(c.db), { recursive: true, mode: 0o700 });
  const child = spawn(c.zkool, ['--db-path', c.db, '--allow-unencrypted-database', '--coin', String(c.coin), '--lwd-url', c.lwd,
    '--port', String(c.port), '--jwt-public-key-file', `${run}/jwt.pub`, '--no-mempool'], { cwd: run, stdio: ['ignore', 2, 'inherit'] });
  child.on('exit', code => { console.error(`zkool_graphql exited with ${code}`); process.exit(1); });
  const gql = graphql(`http://127.0.0.1:${c.port}/graphql`, signer);
  for (let i = 0; ; i++) {
    try { await gql('{apiVersion}'); break; } catch (e) { if (i === 120) throw e; await new Promise(r => setTimeout(r, 1000)); }
  }
  const id = await accountId(gql, c.source.db, c.source.account);
  const handle = wallet({ gql, id, policy: c.approval, approve: vtApproval(process.stdin, process.stdout) });
  const server = net.createServer(conn => {
    let buf = '', op;
    conn.on('data', d => {
      if (op !== undefined || !(buf += d).includes('\n')) return;
      op = null;
      Promise.resolve().then(() => { const req = JSON.parse(buf); op = req.op; return handle(req); }).then(r => ({ ok: true, ...r }), e => ({ error: e.message }))
        .then(r => { console.error(`${op}: ${r.error ?? 'ok'}`); conn.end(`${JSON.stringify(r)}\n`); });
    });
  });
  server.listen(c.socket, () => {
    fs.chmodSync(c.socket, 0o660);
    fs.chownSync(c.socket, -1, Number(execFileSync('getent', ['group', 'portable-ipc']).toString().split(':')[2]));
    console.error(`agent wallet ready: account ${id}, ${c.approval.mode} mode, ${c.socket}`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv[2]).catch(e => { console.error(e); process.exit(1); });
