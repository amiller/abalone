# Read-only credit projection prototype

The shared implementation is [`lib/provider-credit-projection.mjs`](../../lib/provider-credit-projection.mjs); portable service and vault adapters remain in this directory.

This source is separate from the image and current workspace API. It installs no
service, creates no account, requests no invoice/quote, and provides no network
transport or credential discovery. A new instance defaults to `unconfigured`,
with unknown balance/allowance and no payment address.

## Trusted owner and lease

`startCreditService({socketPath, lease, balance, ...bounds})` requires actual
Linux UID972. The fixed socket parent must already belong to UID972, and every
ancestor must be a real directory owned by root or UID972 without group/world
write. Existing paths are refused, not deleted. No account/group creation or
socket-path selection comes from a client. The socket is reachable for peer
checks; actual `SO_PEERCRED`, read by the existing bounded Python helper, admits
UID971 only. UID970, UID972, root and all others are refused by this endpoint.
Root can still control the machine; that refusal is API policy, not root isolation.

The constructor accepts either neither adapter (honest unconfigured state) or
both a trusted balance monitor and a lease. The lease has
`{signal, assertCurrent(signal), release()}`. It must bind the exact unlocked vault,
mount, account record and generation. It must synchronously signal revocation
before that authority can change, and assertions must return exactly `true`
only while current. Synthetic tests do not implement this real vault binding.
The projection holds the lease until stopped/revoked, so ordinary vault lock must
stop/drain it first; there is no automatic unlock or lock bypass.

The balance monitor is the existing `createBalanceMonitor` interface. Its
credential getter and transport remain exclusively inside the trusted financial
process. The projection never receives a credential field or wallet address.
Only the returned trusted supervisor object's `refresh()` can start a refresh;
there is no refresh operation over the socket. Schedule it only after the real
lease, fixed transport, Tor and clock policies are admitted. There is no poller
or network default in this prototype.

Before and after refresh, and on each coalesced status read, the projection
checks the lease. Revocation clears cached amounts synchronously. Assertion
failure, monotonic-clock failure or deadline expiry closes the projection.
Timeout returns unavailable but retains underlying work until it settles.
Close aborts the monitor, waits for monitor and all outstanding assertions to
drain, then releases the lease exactly once. Failed monitor cleanup retains the
lease; failed release rejects close. Uncooperative callbacks leave cleanup
pending instead of reporting success. A production lease/transport therefore
needs genuinely bounded cleanup. Errors crossing the socket contain no callback
messages. Constructor validation failures before ownership transfer leave the
lease with the caller; after projection construction, startup failure closes it.

## Wire contract

One newline-terminated request per connection, at most 256 bytes:

```json
{"rid":1,"op":"status"}
```

Only these fields and this operation are accepted. The nonnegative safe integer
`rid` is echoed. Up to four connections are accepted, each with a two-second
absolute deadline (including peer verification). Malformed/extra/multiple frames
and unauthorized peers are disconnected. There are no secret/token/UID request
fields and no mutation commands.

Success is `{rid,ok:true,credit}`. The exact credit shape is:

```json
{
  "version":1,
  "session":"random per-process identifier",
  "state":"unconfigured",
  "validForMs":1000,
  "accountBalance":{
    "provider":"ppq","scope":"account","currency":"USD",
    "amountDecimal":null,"observedAt":null,"providerAsOf":null,
    "freshness":"unknown","source":"provider-reported"
  },
  "allowance":{"state":"unknown","reason":"journal-not-bound"},
  "funding":{"state":"not-configured"}
}
```

State can also be `configured` or `unavailable`. Amounts are bounded plain
nonnegative decimal strings only after a valid provider observation. Freshness
is `unknown`, `fresh` or `stale`; monotonic age independently downgrades an old
observation. A failed refresh preserves the old amount as stale, unless lease
loss/deadline closes the projection, which removes the amount entirely.
Configuration does not imply connectivity or spendability. Provider account
balance is not local allowance or evidence that a particular invoice was paid.
Allowance stays unknown until a separate real journal binding is reviewed.
Funding stays not configured; this protocol carries no addresses or bearer keys.

The workspace now includes an opt-in read-only consumer, configured by its trusted
`--credit-socket` service CLI option. It authenticates UID972 with kernel peer
credentials and verifies socket ownership; only UID971 consumes this endpoint.
The full schema is validated and its lease expires using request-start monotonic
time. Failed reads, session changes and expiry clear the amount. The browser
refreshes before a short lease expires without extending stale data on errors.
`/api/status` carries this projection separately as `credit`, even if agent IPC
is unavailable; agent IPC does not proxy financial authority. The browser labels
provider account balance separately from unknown local allowance; funding remains
not configured. Desktop status remains a separate projection. This is source
integration, not a claim that a real credit service or account is deployed.

## Offline checks

```sh
node --test tests/provider-credit-projection.test.mjs
python3 -B portable/funding/tests/run-credit-uid-proof.py
```

Eleven core cases cover injected real balance-adapter lifecycle, lease loss,
timeout/drain, rejected schema/canary, age/rollback and cleanup failure. The
namespace proof uses actual mapped UID972/971/970/974 and kernel SO_PEERCRED;
checks accepted read status, denied other UIDs/mutations, malformed/oversized
frames, synthetic-canary absence and revocation. It runs with no external
network interfaces and a private RAM tmpfs/chroot; no packages are installed.
It needs subordinate UID/GID mappings, existing Node/Python and mount/user/network
namespaces. The temporary Node copy lives only in the private tmpfs and disappears
with the namespace. Fixtures never contact a provider or read real credentials.
Actual image service deployment, a real vault lease/provider adapter, accurate
clock admission and financial readiness remain separate gates. The read-only
workspace integration is checked with `node --test portable/workspace/credit-client.test.mjs`;
`tests/credit-client-namespace.mjs` extends the private UID harness with the actual
workspace client, singleflight reads, wrong-user refusal and stopped-service handling.
