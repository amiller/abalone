import test from "node:test";
import assert from "node:assert/strict";
import { Wallet, verifyTypedData } from "ethers";
import { pick, payment, domain, x402Fetch, TYPES, BASE_USDC } from "./x402.mjs";

const PAYEE = "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0";
// Shape of Agent402's live code-run challenge (2026-11-14): exact Base USDC first, then other chains and schemes.
const challenge = (amount = "20000", payTo = PAYEE) => ({ x402Version: 2, resource: { url: "https://agent402.tools/api/code-run" }, accepts: [
  { scheme: "exact", network: "eip155:137", amount, asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", payTo, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } },
  { scheme: "upto", network: "eip155:8453", amount, asset: BASE_USDC, payTo, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2" } },
  { scheme: "exact", network: "eip155:8453", amount, asset: BASE_USDC, payTo, maxTimeoutSeconds: 604900, extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee" } },
  { scheme: "exact", network: "eip155:8453", amount, asset: BASE_USDC, payTo, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } },
] });
const wallet = new Wallet("0x" + "11".repeat(32));

test("picks the EIP-3009 Base USDC option and refuses over-cap prices and payee changes", () => {
  const r = pick(challenge(), { cap: 50000 });
  assert.equal(r.maxTimeoutSeconds, 300);
  assert.equal(r.extra.name, "USD Coin");
  assert.throws(() => pick(challenge("60000"), { cap: 50000 }), /exceeds the cap/);
  assert.throws(() => pick(challenge(), { cap: 50000, payTo: wallet.address }), /payee changed/);
  assert.throws(() => pick({ x402Version: 2, accepts: challenge().accepts.slice(0, 3) }, { cap: 50000 }), /no exact Base USDC/);
});

test("the authorization is a transferWithAuthorization the wallet signed for exactly the price", async () => {
  const c = challenge(), r = pick(c, { cap: 50000 }), nonce = "0x" + "ab".repeat(32);
  const p = await payment(c, r, wallet, { now: 1800000000, nonce });
  assert.deepEqual(p.payload.authorization, { from: wallet.address, to: PAYEE, value: "20000", validAfter: "1799999400", validBefore: "1800000300", nonce });
  assert.deepEqual(domain(r), { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: BASE_USDC });
  assert.equal(verifyTypedData(domain(r), TYPES, p.payload.authorization, p.payload.signature), wallet.address);
  assert.deepEqual(p.accepted, r);
  assert.equal(p.x402Version, 2);
});

test("x402Fetch pays a 402 once with PAYMENT-SIGNATURE and reports the settlement", async () => {
  const sent = [];
  const fetcher = async (url, init) => {
    sent.push(init.headers["PAYMENT-SIGNATURE"]);
    if (!init.headers["PAYMENT-SIGNATURE"]) return new Response("{}", { status: 402, headers: { "payment-required": btoa(JSON.stringify(challenge())) } });
    return new Response('{"stdout":"2\\n"}', { headers: { "payment-response": btoa(JSON.stringify({ success: true, transaction: "0xfeed", network: "eip155:8453" })) } });
  };
  const payees = new Map();
  const { response, paid } = await x402Fetch("https://agent402.tools/api/code-run", { method: "POST", headers: {} }, { wallet, cap: 50000, payees, fetcher });
  assert.deepEqual(await response.json(), { stdout: "2\n" });
  assert.equal(paid.settlement.transaction, "0xfeed");
  const header = JSON.parse(atob(sent[1]));
  assert.equal(header.payload.authorization.to, PAYEE);
  assert.equal(payees.get("https://agent402.tools/api/code-run"), PAYEE);
});
