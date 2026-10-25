// SPDX-License-Identifier: MIT
// Wallet CLI for the agent's bash tool: zec balance|transactions|address|send ADDRESS AMOUNT [MEMO]
import { walletCall } from '../workspace/pi-wallet.mjs';
const [op, address, amount, memo] = process.argv.slice(2);
const ops = { balance: [], transactions: [], address: [], send: [address, amount] };
if (!ops[op] || ops[op].some(v => v === undefined)) { console.error('usage: zec balance|transactions|address|send ADDRESS AMOUNT [MEMO]'); process.exit(2); }
console.log(JSON.stringify(await walletCall(op === 'send' ? { op, address, amount, ...(memo === undefined ? {} : { memo }) } : { op }), null, 1));
