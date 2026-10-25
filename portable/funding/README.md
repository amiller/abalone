# Portable funding adapters

The shared [balance monitor](../../lib/provider-balance.mjs) and
[credit projection](../../lib/provider-credit-projection.mjs) accept injected
credentials, transport and lifecycle checks. Their unit suites live in `tests/`;
portable vault, UID and service composition stays here.

Bounded prototype adapters for the portable funding path, plus an optional
vault-backed credit-display consumer. The balance and issuance adapters inject
their credential, transport and validation operations. The optional consumer
has a fixed HTTPS transport through Tor; starting it can make balance requests.
Nothing creates an address or account automatically. Tests use synthetic
credentials and nonpayable fixture values; wallet seeds are outside these modules.

## Optional leased credit consumer

`credit-lease-entry.mjs` connects the inherited vault lease, `ppq-record.mjs`,
balance monitor and read-only credit service. Its private record must be exactly
`{version:1, provider:'ppq', creditId:'...'}`; an SDK authorization record is not
interchangeable. The UI receives only the projection, never this record.

`ppq-balance-curl.mjs` uses fixed `/usr/bin/curl`, the fixed balance endpoint,
SOCKS remote DNS at `127.0.0.1:9050`, certificate verification and TLS1.2 or later.
It passes the request body through stdin, does not follow redirects, bounds collected
output and waits for process closure after cancellation. It does not create
credit, issue funding instructions or authorize inference.

The fixed root bootstrap is
[`financial-lease-run.py`](../raspberry-pi/storage/financial-lease-run.py). Its supervisor is
bounded to a 300-second session; a future service lifecycle must reacquire a
fresh lease when restarting. No credit unit is enabled by this source slice,
and the default workspace UI stays unconfigured. Deployment must provide the
owned runtime socket directory and configure the daemon and UI socket together.
Actual ARM consumer acceptance, production custody and real provider observation
remain separate from supporting offline tests.

The installed CLI opts into recovery of the fixed
`/run/portable-credit/credit.sock` endpoint. Recovery requires the expected socket
ownership and mode plus a bounded, request-free connection probe returning
`ECONNREFUSED`. A live listener, an ambiguous probe, a regular file or a symlink
is refused. Generic API callers retain existing-path refusal by default. This
relies on the fixed unit serializing starts and trusted UID972/root code being
the only writers; inode rechecks do not make unlink atomic against concurrent
trusted writers.

## Provider balance ([shared module](../../lib/provider-balance.mjs))

`createBalanceMonitor({ getCredential, transport, now?, staleAfterMs?, requestTimeoutMs? })`
observes a PPQ account balance through the documented
`POST https://api.ppq.ai/credits/balance` endpoint (request body
`{"credit_id": ...}`). The success schema it accepts — a JSON object whose
single key `balance` holds a number — derives from a prior sanitized
observation, not a provider stability guarantee: any other shape, non-finite,
negative or exponent-form amount is rejected, never coerced.

- The public snapshot is exactly
  `{provider:'ppq', scope:'account', currency:'USD', amountDecimal, observedAt, providerAsOf:null, freshness, source:'provider-reported'}`.
  `freshness` is `unknown` before the first observation, `fresh` while newer
  than `staleAfterMs`, and `stale` once older or after any failed refresh.
- Concurrent refreshes share one in-flight request. The deadline covers both
  credential acquisition and transport. Callbacks receive an AbortSignal via
  `getCredential({signal})` and `transport(request, {signal})`. Timeout aborts
  and rejects the visible request, but retains its ownership slot until the
  underlying callback settles: an ignored abort never enables overlapping
  refreshes, and a late credential never starts transport. Late responses never
  publish. Callbacks must settle only after their owned I/O has drained.
- `close()` rejects visible work, aborts, and returns a shared drain promise. It
  permanently refuses refreshes. If a callback never settles, close stays
  pending; no false cleanup success is reported. A trusted bounded transport
  and credential lease provider remain necessary before deployment. JS
  credential strings/copies are not claimed to be securely zeroized.
- Invalid, non-finite or
  backward clock readings leave existing observations stale; a successful
  later refresh is required to restore freshness.
- A failed or timed-out refresh preserves the previous observation (reported
  stale) or leaves the state unknown; it never fabricates a zero or any other
  value.
- Errors are sanitized to a short code (`timeout`, `transport-failed`,
  `http-status`, `invalid-schema`, `invalid-response`,
  `credential-unavailable`, `invalid-clock`, `cancelled`, `closed`) plus at most a numeric HTTP status. The credential
  and the raw transport response never appear in results or errors.
- The balance is display information only. It is not a spend cap, a key
  allowance or proof that credit is spendable, and it is **never accepted as
  evidence that an invoice was funded** (see the credit-provenance seam below).
  A legitimate pre-existing account balance displays exactly the same way —
  independently of any pending or settled funding attempt — and the monitor
  deliberately produces a shape that the provenance seam does not consume.

## Funding instruction issuance (`issuance.mjs`)

`new FundingIssuance({ directory, validator, refusalValidator, proofValidator, quoteTransport, now?, quoteTimeoutMs?, proofFreshAfterMs? })`
records one durable issuance attempt per funding instruction in an owned
private directory:

1. A validated intent — expected assets in positive integer base units (digit
   strings are length-bounded **before** `BigInt` conversion; anything longer
   than 78 digits is refused without parsing) plus refund and recipient
   references, nothing else — is committed
   with a request mark **before** the non-idempotent quote transport is invoked.
2. The transport is called exactly once per attempt.
3. The validated response or an uncertain outcome is committed **before** any
   public success. The public projection is
   `{id, phase, status, paymentInstruction}` — payment instruction fields and
   phase only, never the raw provider response.

Quotes are accepted only through the injected pure validator
`(intent, quote) => instruction | null`, grounded in the exact expected intent;
whatever it returns is re-projected onto bounded payment instruction fields
(`address`, `asset`, `amount`, optional `uri`/`memo`/`expiresAt`), dropping unexpected fields. Validators are trusted code: they must not place
secrets or raw response content inside allowed string fields.

Phases: `intent`, `requested`, `quoted`, `bridge-success`, `invoice-settled`,
`provider-credit-ready`, plus `uncertain` and `refused` outcomes. The
settlement stages are deliberately distinct: a bridge receipt
(`recordBridgeReceipt`) or an invoice receipt (`recordInvoiceSettled`) alone
never becomes spendable credit, and **funding success is never inferred from an
account balance total** — a fresh, positive, provider-reported balance says
nothing about whether *this* invoice's credit arrived. `provider-credit-ready`
is reachable only through the credit-provenance seam below.

### Credit provenance (the only path to `provider-credit-ready`)

`recordCreditProof({ id, proof })` replaces any balance-based transition. It
requires the injected `proofValidator` seam — an offline, injectable verifier
(no live API, no credentials) — to *positively* correlate the proof with the
exact attempt context `{id, instruction, invoiceEvidenceRef, settledAt}` and
return an explicit correlation
`{accountRef, creditedAmountDecimal, observedAt, evidenceRef}` or `null`.
The validator is responsible for authenticating and correlating the evidence;
the adapter additionally enforces these shape, amount and time checks:

- `accountRef` and `evidenceRef`: bounded nonempty references naming the exact
  credited account and the verified evidence.
- `creditedAmountDecimal`: a strictly positive plain decimal — **zero credit
  never proves a funded invoice**, whatever the surrounding shape.
- `observedAt` must not predate the invoice settlement it claims to prove, must
  not be forged from the future relative to the supervisor clock (`now`), and
  must be sufficiently recent (`proofFreshAfterMs`, default 5 minutes).

Only the bounded four-field provenance projection is persisted; raw proof
material (signatures, receipts) never reaches the journal or the public
projection. If provenance cannot be supplied — the validator returns `null` or
throws, or any invariant fails — the call is refused, the attempt simply stays
`invoice-settled`, and the account balance keeps being displayed separately by
`lib/provider-balance.mjs`. No spendable-ready claim is fabricated: the public projection
never upgrades past `invoice-settled` without verified provenance.

### Quote failures are validated conservatively

Receiving an invalid or mismatched quote does **not** establish that the
provider did nothing — the provider may already have created an invoice we
cannot validate. Such outcomes are recorded as `uncertain`
(reasons `mismatched-quote`, `invalid-quote`) with status
`needs-reconciliation`, exactly like timeouts and transport errors: no
automatic reissue, ever. `refused` — the only outcome that permits a new
attempt to start automatically — has **positive definitive-refusal semantics**:
it exists only when the injected `refusalValidator`
`(intent, quote) => {evidenceRef} | null` affirmatively returns validated
provider evidence that the request was refused with no side effects (for
example an offline-verified signed refusal receipt). A null, throwing, or
malformed verdict is no evidence at all, and even a hand-forged journal entry
claiming a refusal without a bounded evidence reference is refused on replay.

### Durability and fail-closed reads

Durability reuses the shared persistent kernel lock primitive
(`holdJournalLock` from `../credit-journal`): a kernel-held `flock` on a
`payment.flock` inode held for the whole read-modify-rename-fsync mutation,
an atomic rename of an fsynced private temporary file, directory fsync, and a
1MiB size cap enforced identically on read and before every commit. State files
are opened `O_NOFOLLOW|O_NONBLOCK` and validated as owned private regular
files with no hard links. Existence locks with age or PID deletion are not used
anywhere. Like the payment journal, this cannot make the external quote call
atomic with the local write; that is exactly what the uncertain phase is for.
A **missing journal directory is an error on read, never an empty journal** —
a wrong path must not silently read as “no instruction was issued”; only a
missing state file inside a validated directory means that. Power-loss
recovery still needs VM and hardware tests.

## Not in this slice

The issuance adapter has no default HTTP transport. No real PPQ calls have been
qualified, and there is no coin signing, live conversion or invoice flow,
operator reconciliation tooling, or
coordination between this journal and `portable/credit-journal` payment state
(they must not share a directory). Do not run against a live service or real
credentials.

## Running checks

```sh
node --test tests/provider-balance.test.mjs portable/funding/issuance.test.mjs
```

Requires Node and a `python3` with `fcntl` for the shared lock primitive, like
`portable/credit-journal`.

## Quote signature only (`quote-signature.mjs`)

`verifyOneClickQuoteSignature(responseJson)` accepts at most 128 KiB of JSON
text and returns `{authenticated, coverage}`. It verifies the exact supported
primitive-field projection from NEAR 1Click SDK **0.1.26**, using a fixed
manager key and Node's built-in cryptography. No key supplied by a caller or
quote is trusted. No 0.1.24 fallback exists.

An authenticated result identifies either `oneclick-0.1.26-dry-projection` or
`oneclick-0.1.26-issued-projection`; refusal returns `coverage:null`.
These labels describe the projection, not validation of every required field.
This helper does **not** decide whether a quote is payable. Independently check
request binding, amounts, chain, controlled recipient/refund address, fees,
clock and expiry. Outer swap status and PPQ credit are not signed by this
helper. Authenticate the full provider response over the fixed HTTPS origin
and preserve its durable hash separately.

See [source provenance and coverage limits](quote-signature.PROVENANCE.md)
and the retained [ISC license](quote-signature.LICENSE). Run focused public
checks with `node --test portable/funding/quote-signature.test.mjs`.
