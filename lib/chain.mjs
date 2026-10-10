// The peer's link to contracts/src/CouponRegistry.sol over JSON-RPC, with no Ethereum library: RLP, EIP-155 legacy
// transactions signed with @noble/curves, and ABI encoding for the few calls the peer makes.
//   checkpoint(n, snapshot, claims): the peer's encrypted state rides in calldata; claims are single-use ids
//   (gift accounts) recorded in claimedBy. The peer acts on a checkpoint only once its block is at or below the
//   chain's "safe" head, and only if claimedBy names this peer for every claim.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak256 } from "./keccak.mjs";

const k = (s) => keccak256(Buffer.from(s));
const sel = (sig) => k(sig).subarray(0, 4).toString("hex");
const ERRORS = Object.fromEntries(["NotPeer()", "BadN()", "Claimed_()", "NotOwner()", "NotAllowed()"].map((e) => [sel(e), e.slice(0, -2)]));
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const pad32 = (b) => Buffer.concat([b, Buffer.alloc((32 - (b.length % 32)) % 32)]);
const hex = (b) => "0x" + Buffer.from(b).toString("hex");
const num = (x) => BigInt(x);

function rlp(x) {
  const enc = (b, off) => b.length === 1 && b[0] < 0x80 && off === 0x80 ? b : Buffer.concat([len(b.length, off), b]);
  const len = (l, off) => { if (l < 56) return Buffer.from([off + l]); const h = Buffer.from(l.toString(16).padStart(2 * Math.ceil(l.toString(16).length / 2), "0"), "hex"); return Buffer.concat([Buffer.from([off + 55 + h.length]), h]); };
  if (Array.isArray(x)) return enc(Buffer.concat(x.map(rlp)), 0xc0);
  return enc(x, 0x80);
}
// RLP integers are minimal big-endian: an r or s with a leading zero byte must be shortened, or about 1 signature in
// 128 fails to decode ("Failed to decode transaction").
const int = (n) => { const h = BigInt(n).toString(16); return n == 0 ? Buffer.alloc(0) : Buffer.from(h.length % 2 ? "0" + h : h, "hex"); };

export const addressOf = (sk) => "0x" + keccak256(Buffer.from(secp256k1.getPublicKey(sk, false)).subarray(1)).subarray(12).toString("hex");

export class ChainError extends Error { constructor(name, message) { super(message); this.name = name; } }

export function registry({ rpc, address, key }) {
  const sk = Buffer.from(key.replace(/^0x/, ""), "hex"), me = addressOf(sk);
  let id = 0;
  const call = async (method, params) => {
    const r = await (await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) })).json();
    if (r.error) {
      const data = typeof r.error.data === "string" ? r.error.data : r.error.data?.data;
      const name = data && ERRORS[data.slice(2, 10)];
      throw new ChainError(name ?? "RpcError", `${method}: ${name ?? r.error.message}`);
    }
    return r.result;
  };
  const view = async (sig, args, tag = "latest") => call("eth_call", [{ to: address, data: "0x" + sel(sig) + args }, tag]);
  const addrWord = (a) => a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const block = async (tag) => num((await call("eth_getBlockByNumber", [tag, false])).number);

  const checkpointData = (n, snapshot, claims) => "0x" + sel("checkpoint(uint64,bytes,bytes32[])") + word(n) + word(96) + word(96 + 32 + pad32(snapshot).length)
    + word(snapshot.length) + pad32(snapshot).toString("hex") + word(claims.length) + claims.map((c) => c.replace(/^0x/, "")).join("");

  return {
    address: me,
    isPeer: async () => num(await view("isPeer(address)", addrWord(me))) === 1n,
    n: async (tag) => num(await view("n(address)", addrWord(me), tag)),
    claimedBy: async (claim, tag = "latest") => "0x" + (await view("claimedBy(bytes32)", claim.replace(/^0x/, ""), tag)).slice(-40),
    // send: checkpoint(n, snapshot, claims) until it is included (the unsafe head). A revert is a ChainError named
    // BadN (another copy of this peer moved n: restart), Claimed_ (someone else holds a claim) or NotPeer.
    async send(n, snapshot, claims, poll = 250) {
      const data = checkpointData(n, snapshot, claims), tx = { from: me, to: address, data };
      const gas = num(await call("eth_estimateGas", [tx])) * 12n / 10n;
      const [nonce, gasPrice, chainId] = await Promise.all([call("eth_getTransactionCount", [me, "pending"]), call("eth_gasPrice", []), call("eth_chainId", [])]);
      const fields = [int(num(nonce)), int(num(gasPrice)), int(gas), Buffer.from(address.slice(2), "hex"), int(0), Buffer.from(data.slice(2), "hex")];
      const hash = keccak256(rlp([...fields, int(num(chainId)), int(0), int(0)]));
      const sig = secp256k1.sign(hash, sk, { prehash: false, format: "recovered" });
      const v = BigInt(sig[0]) + num(chainId) * 2n + 35n;
      const txHash = await call("eth_sendRawTransaction", [hex(rlp([...fields, int(v), int(num(hex(sig.subarray(1, 33)))), int(num(hex(sig.subarray(33))))]))]);
      let receipt;
      while (!(receipt = await call("eth_getTransactionReceipt", [txHash]))) await new Promise((r) => setTimeout(r, poll));
      if (receipt.status !== "0x1") throw new ChainError("Reverted", `checkpoint ${n} reverted in block ${num(receipt.blockNumber)}`);
      return { txHash, block: num(receipt.blockNumber) };
    },
    // confirm: wait until the safe head reaches the transaction's block, then require that it is still there and that
    // claimedBy names this peer for every claim. A reorg that dropped it, or a rival claim, is a ChainError "Lost".
    async confirm(sent, claims, poll = 250) {
      for (;;) {
        const safe = await block("safe");
        const r = await call("eth_getTransactionReceipt", [sent.txHash]);
        if (r && safe >= num(r.blockNumber)) break;
        if (!r && safe >= sent.block) throw new ChainError("Lost", `checkpoint ${sent.txHash.slice(0, 10)}… is no longer on chain at the safe head`);
        await new Promise((x) => setTimeout(x, poll));
      }
      for (const c of claims) if ((await this.claimedBy(c, "safe")) !== me) throw new ChainError("Lost", `claim ${c.slice(0, 10)}… is held by another peer at the safe head`);
    },
    async checkpoint(n, snapshot, claims) { const s = await this.send(n, snapshot, claims); await this.confirm(s, claims); return s; },
    // The last checkpoint's snapshot, from its transaction's calldata, checked against stateRoot on chain.
    async lastSnapshot() {
      const logs = await call("eth_getLogs", [{ address, fromBlock: "0x0", toBlock: "safe", topics: ["0x" + k("Checkpoint(address,uint64,bytes32)").toString("hex"), "0x" + addrWord(me)] }]);
      if (!logs.length) return null;
      const log = logs.at(-1), input = Buffer.from((await call("eth_getTransactionByHash", [log.transactionHash])).input.slice(2), "hex");
      const off = Number(num(hex(input.subarray(4 + 32, 4 + 64)))), len = Number(num(hex(input.subarray(4 + off, 4 + off + 32))));
      const snapshot = input.subarray(4 + off + 32, 4 + off + 32 + len);
      const root = "0x" + keccak256(snapshot).toString("hex");
      if (root !== "0x" + log.data.slice(66, 130)) throw new ChainError("BadSnapshot", `checkpoint calldata hashes to ${root}, not the stateRoot logged`);
      return { n: num("0x" + log.data.slice(2, 66)), snapshot };
    },
  };
}
