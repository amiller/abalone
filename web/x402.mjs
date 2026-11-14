// x402 v2 "exact" payments from the page's own wallet: an EIP-3009 transferWithAuthorization of USDC on Base,
// signed in the browser and sent in the PAYMENT-SIGNATURE header. Gas is the facilitator's; the wallet needs only USDC.
import { getAddress, hexlify, randomBytes } from "ethers";

export const BASE = "eip155:8453";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TYPES = { TransferWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] };
const need = (ok, message) => { if (!ok) throw new Error("x402 payment refused: " + message); };
const b64json = (v) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(v))));
const unb64json = (s) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))));

// The one requirement this wallet pays: exact, Base USDC through EIP-3009, at most `cap` units, to the payee seen first.
export function pick(challenge, { cap, payTo }) {
  need(challenge?.x402Version === 2 && Array.isArray(challenge.accepts), "not an x402 v2 challenge");
  const r = challenge.accepts.find((a) => a.scheme === "exact" && a.network === BASE && a.asset?.toLowerCase() === BASE_USDC.toLowerCase()
    && a.extra?.name && !a.extra.verifyingContract && !a.extra.assetTransferMethod);
  need(r, "no exact Base USDC option");
  need(/^\d+$/.test(r.amount) && BigInt(r.amount) <= BigInt(cap), `price ${r.amount} exceeds the cap of ${cap} USDC units`);
  need(!payTo || getAddress(r.payTo) === getAddress(payTo), `payee changed from ${payTo} to ${r.payTo}`);
  return r;
}

export function domain(r) { return { name: r.extra.name, version: r.extra.version, chainId: 8453, verifyingContract: getAddress(r.asset) }; }

export async function payment(challenge, r, wallet, { now = Math.floor(Date.now() / 1000), nonce = hexlify(randomBytes(32)) } = {}) {
  const authorization = { from: wallet.address, to: getAddress(r.payTo), value: r.amount,
    validAfter: String(now - 600), validBefore: String(now + r.maxTimeoutSeconds), nonce };
  const signature = await wallet.signTypedData(domain(r), TYPES, authorization);
  return { x402Version: 2, resource: challenge.resource, accepted: r, payload: { signature, authorization } };
}
export { TYPES };

// fetch() that pays one x402 challenge. `payees` pins each resource's payee across calls.
export async function x402Fetch(url, init, { wallet, cap, payees = new Map(), fetcher = (...a) => fetch(...a) }) {
  const first = await fetcher(url, init);
  if (first.status !== 402) return { response: first, paid: null };
  const header = first.headers.get("payment-required");
  const challenge = header ? unb64json(header) : await first.json();
  const r = pick(challenge, { cap, payTo: payees.get(url) });
  payees.set(url, r.payTo);
  const p = await payment(challenge, r, wallet);
  const response = await fetcher(url, { ...init, headers: { ...init.headers, "PAYMENT-SIGNATURE": b64json(p) } });
  const settled = response.headers.get("payment-response");
  return { response, paid: { amount: r.amount, payTo: r.payTo, network: r.network, ...(settled ? { settlement: unb64json(settled) } : {}) } };
}
