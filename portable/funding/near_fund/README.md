# Dsmack operator funding CLI

This opt-in source CLI reuses the qualified host demo route: ZEC → owned Base
USDC → a $2 NEAR invoice. It is separate from the inference API key. It is not
staged into the image, exposed to the agent, or qualified on the Pi yet.

Run with Python 3 and the existing `base58`, `eth-account`, `eth-abi`, and
`eth-utils` dependencies. No installation is performed by the CLI. Curl and a
Tor SOCKS listener at `127.0.0.1:9050` are required. Every external HTTP request
uses curl with SOCKS hostname resolution, TLS verification, no redirects,
no inherited environment, and no retries. Allowed origins are the five fixed
services used by this route. Credentials and signed transactions travel on
curl's stdin, never its command line. Transport failures emit fixed errors.

The operator supplies a mode-0600 JSON configuration in a mode-0700 directory:

```json
{
  "version": 1,
  "organizationId": "00000000-0000-0000-0000-000000000000",
  "baseAddress": "<owned Base address>",
  "basePrivateKey": "<0x-prefixed Base private key>",
  "refundAddress": "<owned recoverable Zcash transparent refund address>",
  "refundBackupVerified": true,
  "session": {"access_token": "<NEAR management token>", "refresh_token": "<management refresh token>"}
}
```

These placeholders are not usable credentials. The CLI verifies the Base key
matches the configured address and validates the refund address encoding.
`refundBackupVerified` is the operator's explicit custody attestation; the CLI
does not prove an external backup exists. It does not generate a wallet,
refresh a session, create an inference key, or acquire management authority.
Store configuration and attempt state inside an unlocked encrypted vault for
a portable deployment. Never provide them to UID 970 or 971; those UIDs are
refused. Before reading configuration, the CLI sets core limits to zero and Linux process dumpability to zero, refusing if either fails. This does not claim locked or zeroized Python heap; configuration remains private operator custody. Files must belong to the invoking operator. Root enrollment and
financial-user wiring remain separate work.

From the runtime source root:

```sh
python3 -I portable/funding/near-fund.py --config /private/funding.json --state /private/attempt-001 new
python3 -I portable/funding/near-fund.py --config /private/funding.json --state /private/attempt-001 status
python3 -I portable/funding/near-fund.py --config /private/funding.json --state /private/attempt-001 resume
python3 -I portable/funding/near-fund.py --config /private/funding.json --state /private/attempt-001 prepare-payment
python3 -I portable/funding/near-fund.py --config /private/funding.json --state /private/attempt-001 send-reviewed PLAN_SHA256
python3 -I portable/funding/near-fund.py --config /private/funding.json credit
```

The parent of the attempt directory must exist with mode 0700. `new` exclusively
creates it, authenticates the account baseline, records intent, creates one new
invoice, and requests one fresh exact-output quote for 2.10 USDC. It prints the
ZEC integer amount, deposit address and conservative safe-send deadline. Never
send to an expired, partial, failed or historical quote. New attempt state must
not be used to evade reconciliation of an ambiguous existing attempt.

`credit` reads the configured account balance without requiring or creating an attempt directory. It does not attribute balance to an invoice.

`status` and `resume` are the same read-only observation: known deposit
address, same invoice, known transaction hash and authenticated account balance.
They never sign, create a quote, broadcast, or refresh authentication. A missing
response after a durable intent is unknown and requires explicit operator
reconciliation; automatic POST replay is prohibited. Incomplete invoice/quote
creation can therefore return unknown rather than produce a new deposit address.

`prepare-payment` admits settled incoming funds, preserves the preexisting USDC
balance, checks the same unexpired invoice and simulates the exact transfer.
It returns the plan path and SHA-256. `send-reviewed` revalidates that plan,
nonce, invoice, quote, balance and gas estimate, persists signed bytes and the
transaction hash, then broadcasts once. An ambiguous response retains the hash
for status; a second send is refused. The Base fee bound is an admission
estimate, not an enforceable cap on every future L1 fee. Expired invoices require
explicit reconciliation and replacement; there is no automatic replacement.

Credit output separates invoice success, authenticated account balance, and
aggregate account growth relative to the fresh pre-invoice baseline. Even when
both are observed, this is not atomic ledger attribution of that payment. An
inference key alone cannot supply this account-balance observation.

Private attempt files include signed transaction bytes and account metadata.
They are never public fixtures. Keep them for recovery; do not delete and retry
an uncertain payment. The process lock serializes commands from this state
parent; custody assumes the invoking operator controls its private directory.

## Portable `~/fund`

The root operator entry (`operator.py fund`, behind `~/fund`) wraps these
commands. Each run first prints the account balance, the agent key's cap and
usage, and the last completed funding, then a terminal QR code
(`zcash:<address>?amount=<ZEC>`) with the address, amount and safe-send time.
1Click deposit addresses belong to one quote and expire at its deadline
(reusable `ANY_INPUT` addresses are partner-only), so `~/fund` resumes an open
quote and otherwise requests a fresh one. It retires an attempt only when it
completed, when its deadline passed with no deposit, or when its address was
never shown; retired attempts stay under `attempts/` for reconciliation.

When a funding completes, the key's cumulative spend limit is raised to its
usage plus the account balance through
`PATCH /v1/workspaces/{workspace}/api-keys/{key}/spend-limit` with the owner
session; it is never lowered. The first key of a new account is created with
the account balance as its limit. `operator.py key-limit <nanoUSD>` sets the
limit explicitly. A new quote is for a $2 invoice; `~/fund --amount N` (whole
dollars, 1 to 10) asks for $N instead. The amount is stored in the attempt's
`invoice-intent.json`, so resuming an open quote keeps its original amount.

Offline validation:

```sh
python3 -m unittest discover -s portable/funding/near_fund -p 'test_*.py' -v
```

Tests cover the original quote/payment guards and actual local subprocess
transport plumbing with synthetic output. They do not make provider calls,
sign real funds, prove Tor connectivity, or qualify live portable custody.
