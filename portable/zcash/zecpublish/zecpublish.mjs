// SPDX-License-Identifier: MIT
// ZECpublish (zecpublish.com) for the agent: zecpublish feed [PAGE] | post TEXT | reply TXID TEXT | like TXID
// A post is a shielded payment to the board with the post as its memo, sent by the agent wallet (the operator approves it).
// The feed has no API: it is a Next.js server action whose ID changes with each site deploy, so it is read from the site's JS.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { walletCall } from '../../workspace/pi-wallet.mjs';

export const SITE = 'https://zecpublish.com';
// The Sapling receiver of the board's UA: Orchard sends go out as Ironwood, which the board's scanner predates.
export const BOARD = 'zs14zjwshdjrscw08rnynpwntrhu27ee0x5ema7z23sdvnmakmlhjpuv776enqetcjyz4eazjrt5gu';
export const AMOUNT = '0.00005';
const run = promisify(execFile);

// curl, not fetch: fetch's fixed 10 s connect timeout is too short for some Tor circuits.
async function text(url, { method = 'GET', body, headers = {} } = {}) {
  const args = ['-sS', '--fail-with-body', '--max-time', '120', '-X', method, ...Object.entries(headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]), url];
  const { stdout } = await run('curl', body === undefined ? args : [...args, '--data-binary', body], { maxBuffer: 1 << 24 });
  return stdout;
}

// The feed action is the actions module's default export: `.ZP=(0,x.$)("<id>")` in one of the board page's chunks.
export function feedAction(chunks) {
  const ids = [...new Set(chunks.flatMap(js => [...js.matchAll(/\.ZP=\(0,[\w$]+\.\$\)\("([0-9a-f]{40})"\)/g)].map(m => m[1])))];
  if (ids.length !== 1) throw Error(`expected one feed action in the site's JS, found ${ids.length}: ${ids.join(' ')}`);
  return ids[0];
}

export function posts(rsc) {
  const line = rsc.split('\n').find(l => l.includes('{"posts":'));
  if (!line) throw Error(`no posts in the feed answer: ${rsc.slice(0, 300)}`);
  return JSON.parse(line.slice(line.indexOf(':') + 1)).posts.map(p =>
    ({ id: p.id, time: new Date(Number(p.datetime)).toISOString(), zats: p.amount, txid: p.txid, likes: p.likes, replies: p.reply_count, replyTo: p.reply_to_post, memo: p.memo }));
}

export async function feed(page = 1) {
  const html = await text(`${SITE}/z/all`);
  const chunks = await Promise.all([...new Set(html.match(/\/_next\/static\/chunks\/[^"]+\.js/g))].map(c => text(SITE + c)));
  const action = feedAction(chunks);
  return posts(await text(`${SITE}/z/all`, { method: 'POST', body: JSON.stringify([{ pageParam: page, limit: 20 }]),
    headers: { 'Next-Action': action, Accept: 'text/x-component', 'Content-Type': 'text/plain;charset=UTF-8' } }));
}

export const memo = (op, a, b) => ({ post: a, reply: `REPLY::${a} ${b}`, like: `LIKE::${a}` })[op];

const usage = 'usage: zecpublish feed [PAGE] | post TEXT | reply TXID TEXT | like TXID';
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [op, a, b] = process.argv.slice(2);
  const ok = op === 'feed' ? a === undefined || /^\d+$/.test(a) : op === 'post' ? a : op === 'reply' ? /^[0-9a-f]{64}$/.test(a ?? '') && b : op === 'like' && /^[0-9a-f]{64}$/.test(a ?? '');
  if (!ok) { console.error(usage); process.exit(2); }
  const out = op === 'feed' ? await feed(Number(a ?? 1)) : await walletCall({ op: 'send', address: BOARD, amount: AMOUNT, memo: memo(op, a, b) });
  console.log(JSON.stringify(out, null, 1));
}
