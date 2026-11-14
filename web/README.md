# Abalone web agent

A chat agent in one static web page that you fund once, with any token NEAR Intents accepts, into a wallet that
lives in the page. From that one payment the page buys its own NEAR AI account and credit, sends every message
encrypted to a NEAR AI model whose TEE attestation the browser has checked, and pays per call over x402 when the agent
runs code in the cloud. There is no account to create, no API key to paste and no KYC anywhere in the path.

The pieces:

- **One payment.** 1Click (NEAR Intents) swaps the token you pick into ETH on Base, paid to the page's own wallet.
  The browser checks 1Click's Ed25519 signature on the quote, and that it pays exactly what was asked to this
  wallet, before showing the QR code (`intents-funding.mjs`).
- **The page's own NEAR AI account.** Once the ETH lands, the page makes an implicit NEAR account (an Ed25519 key in
  the browser), activates it with 0.01 NEAR bought through 1Click, signs in to NEAR AI Cloud with a NEP-413
  signature, swaps the ETH it needs into USDC, pays a PingPay invoice for the credit, and creates an inference key
  with a spend limit. Each step is recorded, so a reload resumes without paying twice (`near-account.mjs`).
- **Private inference.** Each reply starts with a fresh nonce. The browser fetches NEAR AI's attestation report,
  verifies the gateway and model TDX quotes, the NVIDIA GPU evidence and the image provenance, checks that the model
  encryption key belongs to the attested signer, then encrypts every message field to that key and decrypts the
  stream itself (`inference.mjs`, `evidence.mjs`, `near-policy.mjs`).
- **Paid tools.** `run_code` runs Python or JavaScript in Agent402's cloud sandbox for $0.02 a call. The page signs
  an EIP-3009 USDC authorization for exactly the quoted price (x402 v2, `exact`), refuses prices over a cap and
  payee changes, and shows the settlement transaction (`x402.mjs`, `tools.mjs`).

## Try it

1. Open https://amiller.github.io/abalone/app/ or run it (below). **Pay once with any token** is open and shows the page's wallet.
2. Pick a token (ETH on Base pays the wallet directly; anything else goes through 1Click), keep $2 of credit, give a
   refund address on that chain and press **Get QR code**. Pay it. A $2 credit is one payment of about $2.65, which leaves $0.25 of USDC for paid tools.
3. Watch the status line: it waits for the payment, then activates the NEAR account, signs in to NEAR AI, swaps to
   USDC, pays the invoice and ends with `Ready: chat now uses this page's own NEAR AI account ($2.00 credit)`.
   The line above the chat names the model, "encrypted to the attested model".
4. Ask something. Under the chat, **Model attestation verified in this browser** opens the report the browser
   checked for this reply: TCB status, signing address, GPU evidence.
5. Ask the agent to compute something, for example "use run_code to compute the 50th Fibonacci number". The tool
   result ends with `[paid 0.02 USDC to 0xaBF4…, tx 0x…]`, a transaction you can look up on Base.

**Wallet → Export wallet** and **Import a wallet** move the wallet and its NEAR AI account between browsers and origins.

## Seen working

On 2026-11-14 a fresh page wallet (`0xbDD5…cbf5` on Base) received 0.00188 ETH and, with no further input, activated
its NEAR account, signed in to NEAR AI, swapped to USDC and paid a $2 PingPay invoice; NEAR AI showed $2.00 of credit.
The first reply came from `deepseek-ai/DeepSeek-V4.1-Flash-1017` with the gateway and model quotes UpToDate, verified
in the browser. `run_code` then paid 0.02 USDC over x402
([tx](https://basescan.org/tx/0x32bb475f0989e775286c59bb06cfd79fcd7aef188bec1592fc3c56bf856a550e)) and returned
F(50) = 12586269025.

## Run it

Node 24 and Deno 2.

```sh
cd web
npm ci
npm run build
deno run --allow-net --allow-read=. server.ts 8789   # http://127.0.0.1:8789/
npm test
```

`dist/` is static. `server.ts` adds one thing: `/near-pay/`, a pass-through for three PingPay calls that do not
accept browser origins (`near-pay.mjs`). It stores nothing. To host `dist/` elsewhere, such as an IPFS subdomain
gateway, build with `NEAR_PAY=https://<a host running server.ts>/near-pay`. The hosted copy at amiller.github.io/abalone/app/
is built that way, with the pass-through on the dsmack staging page server.

## Hackathon scope

Built for NEAR HACKATHON (2026-11-01 to 11-14). What is new since the announcement on 2026-10-19:

| New during the hackathon | Where |
|---|---|
| This whole directory: the static page, the one-payment flow, the page's own NEAR AI account, direct attested and encrypted NEAR chat with no broker, x402 `run_code` | [`pre-hackathon...hackathon-submission`](https://github.com/amiller/abalone/compare/pre-hackathon...hackathon-submission) (`web/`, plus a pointer in the top-level README) |
| The private agent page this grew from: in-browser NEAR AI attestation (TDX, GPU, image provenance) and end-to-end encryption, model picker, faster verification | dsmack `applications/private-agent-web`, first commit 2026-10-29 ([c5785ef](https://github.com/amiller/dsmack/commit/c5785ef)); PRs [#150](https://github.com/amiller/dsmack/pull/150), [#164](https://github.com/amiller/dsmack/pull/164), [#177](https://github.com/amiller/dsmack/pull/177) |
| The same one-payment flow and own NEAR AI account in the hosted dsmack page | dsmack PRs [#184](https://github.com/amiller/dsmack/pull/184), [#185](https://github.com/amiller/dsmack/pull/185) |

Older, not claimed: the rest of Abalone (the terminal privacy shell, before `pre-hackathon`), and the ZCON USB stick's
Python CLI that first bought NEAR AI credit with Base USDC (October 2026). `near-account.mjs` rewrites that route for
the browser; the sign-in, checkout and payment checks changed during the live run here.

Libraries: pi-agent-core, pi-ai and pi-web-ui (the agent loop and chat UI), `@nearai/inference-sdk` (E2EE and
attestation primitives), `@phala/dcap-qvl` (TDX quote verification), ethers, qrcode. Services: 1Click, NEAR AI Cloud,
PingPay, Agent402, Base.

## Limits

- The Base RPC reads are unverified; a lying RPC can misreport balances but cannot move funds.
- The browser cannot see the TLS key it connected to, so the gateway's attested TLS fingerprint is checked as quoted,
  not against the live connection. Message contents are protected by the encryption to the model key either way.
- Agent402's sandbox is not attested. A TEE sandbox paid the same way (an x402 TDX VM, or a
  [dsmack](https://github.com/amiller/dsmack) Mac) is the next step.
- Conversations live only in the open tab.
