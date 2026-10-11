# Task contract v1 (`abalone-task/1`)

**Product scope:** this is the interface between the **Abalone client** and the **dsmack worker service**. `abalone-task/1`, `/abalone/offer/1` and `/abalone/task/1` are existing compatibility identifiers, not a separate network name. This task interface does not specify or establish dsmack-wide peer enrollment or discovery. See [product scope](../../README.md).

Shared by the client (`abalone commission`, `/commission`, `/tasks`), the worker peer (`/abalone/offer/1`,
`/abalone/task/1` in `lib/node.mjs`), the runner's task API (`docs/protocols/runner-task.md`) and the receipt
verifier (C2). Validators: `lib/contracts/task-v1.mjs`. A change to any field below is `abalone-task/2`; v1 peers
refuse a v2 object.

**Canonical JSON** (every hash and signature below): UTF-8, keys sorted at every level, no whitespace, `/` not escaped.
The same rule as the runner's clientData. `h(x)` = lowercase hex SHA-256 of canonical JSON of `x`. Amounts are
integer µ$ (1 USD = 1,000,000), as in the gift ledger. Times are Unix milliseconds.

## Transport

Both protocols run on the existing libp2p connection, after `/abalone/attest/1` has verified the peer on a fresh
nonce. The client sends nothing about a task to a peer it has not verified on that connection.

- `/abalone/offer/1`: the client writes `{}`, the peer answers `{offers: [Offer]}` and closes. Unauthenticated.
- `/abalone/task/1`: one request frame `{op, task_id, idem, ts, body, sig}`, then reply frames. Every request is
  signed by the gift's device key: `sig = Ed25519(device, "abalone-task/1\n" + op + "\n" + task_id + "\n" + ts + "\n" + idem + "\n" + h(body))`.
  The peer checks it against the device bound to the account at redeem (`lib/node.mjs` ledger), with the same
  5-minute clock window as gift requests. Reply frames: `{ok: true, ...}` / `{error: {code, message}}` for one-shot
  ops; `watch` streams `{event}` frames until the client closes or the task is terminal and drained.

| op | body | reply | idempotency |
|---|---|---|---|
| `commission` | `{authorization, inputs: [{path, b64}]}` | `TaskHandle` | `task_id`. Same authorization bytes again: the existing handle, nothing new started or reserved. Different bytes under a used `task_id`: `409 task_id_reused`. |
| `watch` | `{from_seq}` | `Event` frames from `from_seq` | read-only |
| `instruct` | `{msg_id, text, mode: "steer"\|"follow_up"}` | `{accepted, seq}` | `msg_id` (client random); a repeat returns the first `seq` |
| `take` / `release` | `{}` | `{control: "human"\|"agent"}` | state-setting; repeat is a no-op |
| `bash` | `{msg_id, command}` | `{accepted, seq}` | `msg_id`; only while `control = human` |
| `stop` | `{reason}` | `Completion` (when terminal) | `stop:<task_id>`; stopping a terminal task returns its Completion unchanged |
| `status` | `{}` | `TaskHandle` + `Usage` | read-only |
| `collect` | `{}` | the bundle as `{files: [{path, b64}]}` | read-only; byte-identical on every call (the bundle is written once, at terminal) |
| `list` | `{}` | `[TaskHandle]` for this account | read-only |

`idem` on the wire is the column above (`task_id` for commission, `msg_id` for instruct/bash, `stop:<task_id>`, or a
fresh random value for read-only ops).

## Offer

Signed by nothing beyond the channel: it arrives over the verified connection, and the client refuses it unless
`evidence` equals what the handshake verified (type, CDHash, compose hash). `offer_id = h(offer without offer_id)`.

```
{ v: "abalone-task/1", type: "offer", offer_id,
  worker: { peer: <PeerId>, operator: "owner-operated" | "independent", label },
  evidence: { type: "macrunner" | "dev", cdhash?, compose_hash? },        // the peer's own; must equal the handshake's
  runtime: { image: "<name>@sha256:<digest>", agent: "pi", tools: ["read","bash","edit","write"] },
  resources: [{ id: "small", cpus: 2, mem_mb: 2048, max_seconds: 1800, max_input_bytes: 20971520 }],
  network: { egress: [] },                         // hosts the task guest may reach; [] = none
  inference: { route: "peer → runner proxy → NEAR", models: ["z-ai/glm-5.3-flash"], sees_plaintext: ["task guest", "peer", "runner proxy"] },
  accepts: ["released", "open"],                   // input labels; a Mac runner never accepts "private"
  persistence: { continuation: "runs to terminal while the client is away", retention_ms: 86400000, after: "outputs and events deleted" },
  tariff: { version: "t1", execution_per_second: <µ$>, interval_seconds: 15, inference: "NEAR list price × usage", storage: 0, sponsored: <bool> },
  expiry: <ms> }
```

`operator` is what the worker's owner declares, shown verbatim. `owner-operated` means the person who commissions also
runs the Mac; `independent` means someone else does. Neither is an attestation claim. `sponsored: true` or
`execution_per_second: 0` marks a development offer: its runs do not demonstrate paid execution.

## Authorization

Built and signed by the client. `auth_hash = h(authorization)`; the request `sig` above covers it through `h(body)`.

```
{ v: "abalone-task/1", type: "authorization", task_id: <32 hex, client random>,
  account: <gift account>, device: <device pub hex>, worker: <PeerId>, offer_id, tariff_version,
  task: { prompt, resource: "small" },
  inputs: [{ path, sha256, bytes, label: "released" | "open" }],   // the only files the guest gets, read-only at /in
  inputs_root: h(inputs),
  model, capabilities: { tools: [...], egress: [...] },            // each ⊆ the offer's
  cap: <µ$>, expires: <ms>, ts: <ms> }
```

The peer refuses before reserving or booting anything (`refused`, below) when: the device does not match the
account; `worker` is not this peer; `offer_id` is not a current offer; a capability, egress host, model or resource
is outside the offer; an input label is not in `accepts`; an uploaded file's hash or size differs from `inputs`; the
total exceeds `max_input_bytes`; `expires` is past; or `cap` > the account's remaining balance. The parent
conversation is not a field: only `task.prompt` and `inputs` leave the client.

## Task handle

```
{ task_id, worker: <PeerId>, auth_hash, state, control: "agent" | "human", seq: <last event seq>, created, updated }
```

`state`: `booting` → `running` → one terminal state:

| terminal | meaning | what the user is told |
|---|---|---|
| `completed` | the agent finished its turn and the guest exited cleanly | result and tests are in the bundle |
| `failed` | guest or agent error | the error event; charges to that point |
| `cancelled` | `stop` from the client | partial outputs collected; charges to that point |
| `budget_exhausted` | the next charge would pass `cap` | stopped at the cap; nothing charged beyond it |
| `timed_out` | `max_seconds` reached | as cancelled |
| `worker_lost` | the peer restarted while the task ran | recorded at the next peer start; charges are the debits already in the ledger |

Refusals (`refused`) and an unreachable peer (`worker_unavailable`) are client-side outcomes with no task record at
the peer, and no charge.

## Event

`{ seq, ts, kind, data, prev, hash }`, `hash = h({seq, ts, kind, data, prev})`, `prev` = previous `hash` (64 zeros
for seq 1). Kinds: `state`, `agent` (Pi RPC event, text and tool calls), `instruct`, `control`, `bash`, `charge`,
`error`. The chain head commits to the order; it does not prove no event was omitted at the peer.

## Usage

```
{ tariff_version, cap, reserved, sponsored,
  execution: { seconds, per_second, charge },
  inference: { calls, prompt_tokens, completion_tokens, charge },
  storage: { charge: 0 },
  charged, released, settled: <bool>, ledger: [<idem>...] }
```

`reserved = cap` at commission, held against the account like a gift request's hold. Charges are ledger debits:
execution every `interval_seconds` (`task:<id>:exec:<n>`), inference per call (`task:<id>:infer:<k>`). Each debit's
idem makes a retried or replayed write a no-op. Before each charge the peer checks `charged + next ≤ cap`; if not, it
stops the task as `budget_exhausted`. At terminal it appends one `task-settle` entry (`task:<id>:settle`) and releases
`cap − charged`. `settled: false` means an estimate; only the `task-settle` ledger entry is settlement.

## Completion

Written once at terminal; `completion_hash = h(completion)`.

```
{ v: "abalone-task/1", type: "completion", task_id, auth_hash, offer_id, inputs_root,
  worker: { peer, operator }, peer_evidence: { type, cdhash?, compose_hash? },
  guest: { image, compose_hash, receipts: { count, head } },   // the task VM's runner receipts (runner-task-needs.md)
  status, reason, events: { count, head },
  outputs: [{ path, sha256, bytes }],          // includes patch.diff and test.log when the task produced them
  usage,
  settlement: { ledger: "peer <PeerId> slice <slice>", entry: "task:<id>:settle", entry_sha256,   // sha256 of the exact ledger line
                reserved, charged, released, debits: [<idem>...] },
  retention: { until, delete: "stop after collect, or automatic at until" } }
```

## The bundle (what `collect` returns, what C2 verifies)

```
bundle.json        { v: "abalone-task-bundle/1", task_id, files: { <path>: <sha256> } }
offer.json         the Offer the client accepted
authorization.json { authorization, sig }       (the commission request's device signature)
completion.json
completion.sig     macrunner: the peer's runner /attest response, data = "abalone-task-completion/1|<completion_hash>"
                   dev: Ed25519 signature by the peer's libp2p key (verifiable from the PeerId), labelled unattested
events.jsonl
outputs/<path>
guest/             app-compose.json, clientData.bin, attest.json, receipts.jsonl, out.tar (the runner's exact /out tar, whose sha256 is the exit receipt's out_sha256); absent for dev
```

What the receipt must bind, and where:

| claim | bound by |
|---|---|
| task ID, authorization, input commitments | `completion.auth_hash`, `inputs_root`; the task compose's labels (runner-task-needs.md) |
| worker and attested session | `completion.sig` verified with `verifyMacRunner` against admitted CDHash and peer compose; `expectData` = the completion string above; `worker.peer` must equal the authorization's `worker` |
| runtime/image | task compose `image` (digest-pinned), its `compose_hash` in `guest/clientData.bin` under the task VM attestation |
| declared policy | task compose egress + resources; `offer_id` |
| ordered events | `events.head`; `guest.receipts.head` (runner's own chain) |
| outputs | `outputs[].sha256` = the files in `outputs/` |
| status, usage, settlement | `completion.status`, `completion.usage`, `completion.settlement` (the worker's `task-settle` ledger line by hash; reconciled against the issuer's `abalone gifts` view of the account) |

Historical verification passes the completion time as `now` to `verifyMacRunner`; freshness against later
revocation is a separate, labelled check. The bundle shows hashes of the inputs, not the inputs. Short or guessable
inputs can be recovered from their hashes, so share a bundle only when the inputs are open.
