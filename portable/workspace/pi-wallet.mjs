// SPDX-License-Identifier: MIT
// Wallet tools for the agent: requests go to the agent wallet service, which holds the keys and the spend policy.
import net from 'node:net';

export const WALLET_SOCKET = '/run/portable-agent-wallet/wallet.sock';

export const walletCall = (request, socket = WALLET_SOCKET) => new Promise((resolve, reject) => {
  let out = '';
  const c = net.connect(socket, () => c.write(`${JSON.stringify(request)}\n`));
  c.on('data', d => { out += d; });
  c.on('error', reject);
  c.on('end', () => { const r = JSON.parse(out); r.error ? reject(Error(r.error)) : resolve(r); });
});

export function walletTools(Type, socket = WALLET_SOCKET) {
  const tool = (name, label, description, parameters, op) => ({
    name, label, description, parameters,
    async execute(_id, params) {
      const result = await walletCall({ ...params, op }, socket);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
  const none = Type.Object({});
  return [
    tool('wallet_balance', 'Wallet balance', 'Sync the Zcash wallet over Tor and return its balance in ZEC by pool, the synced height and the spend policy (approve: every payment needs the operator; cap: payments under the caps go without asking).', none, 'balance'),
    tool('wallet_transactions', 'Wallet transactions', 'Sync the Zcash wallet over Tor and list its 20 latest transactions (txid, height, time, value and fee in ZEC, memos).', none, 'transactions'),
    tool('wallet_address', 'Wallet address', 'Return the wallet\'s unified receive address and its Orchard-only unified address (`orchard`, the one to give after MSG on ZECpublish).', none, 'address'),
    tool('wallet_send', 'Wallet send', 'Pay ZEC from the wallet. The wallet service decides by its policy whether the operator must approve on the console (they see amount, fee, destination and memo and press y or n); the call waits for that decision. Returns the txid, or an error such as a refusal or insufficient funds.',
      Type.Object({
        address: Type.String({ description: 'Zcash destination address' }),
        amount: Type.String({ description: 'Amount in ZEC as a decimal string, e.g. "0.001"' }),
        memo: Type.Optional(Type.String({ description: 'Memo for shielded destinations' })),
      }), 'send'),
  ];
}
