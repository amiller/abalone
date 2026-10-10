# Task result bundle and receipt, v1 (`abalone-task-bundle/1`)

The bundle layout and the objects in it (offer, authorization, completion, events) are pinned in `task-v1.md`, "The
bundle". This file pins what makes the bundle a receipt: who signs what, what the runner must record about a task VM, and
what `abalone verify <bundle-dir>` checks and says. Verifier: `lib/bundle.mjs`. Tests: `tests/bundle.test.mjs`.
Sample: `tests/fixtures/bundle/fixture/` (a FIXTURE, see below).

## Signers

| Record | Signed by | How the key relates to the attested execution |
| --- | --- | --- |
| `completion.json` (task, auth_hash, inputs_root, events head, outputs, status, usage, settlement idems) | the worker peer, via its runner: `completion.sig` = the runner `/attest` response with `data = abalone-task-completion/1|h(completion)` | App Attest chain to the pinned Apple root; runner CDHash and peer compose_hash both in the verifier's `peers.admit.macrunner` |
| `guest/receipts.jsonl` (the task VM's runner receipts) | the task VM's `receipt_pub` (fresh, in the runner's RAM) | `guest/clientData.bin` (`mac-compose-task-boot/1`: task compose_hash, nonce, receipt_pub) is asserted verbatim by the runner's App Attest key under the peer VM's enrollment (`guest/attest.json`); runner CDHash and peer compose admitted |
| `authorization.json` `request.sig` | the client's device key (Ed25519) over `abalone-task/1\ncommission\n<task_id>\n<ts>\n<idem>\n<body_hash>` | not attested; the client's own copy (`--expect`) is the reference |

A dev worker signs `completion.sig` as `{type:"peer-ed25519", peer, data, sig}` with its libp2p key. The verifier
accepts that for integrity only and says it is a bare host signature, not attested execution.

## The runner's task record (souk-ab, implemented)

1. **Task boot binding.** `guest/clientData.bin` is canonical `{attested, compose_hash, domain:"mac-compose-task-boot/1", nonce, receipt_pub}`.
   `guest/attest.json` is in the `/attest` shape, with `assertClientData` equal to those exact bytes, asserted under the peer VM's current
   enrollment. The guest-callable `/attest` always wraps data in `mac-compose-assert/1`, so it cannot produce this. The verifier refuses
   anything else, and a test does so with the recorded real peer evidence: its Apple chain, CDHash, compose and signature all pass, and
   only the domain refuses it.
2. **Task receipts** in the runner's chain (`mac-compose-receipt/1`, `seq`, `prev`, `compose_hash`, plus `event`): `task-start`
   (`inputs_sha256`), then `attach`/`detach`, then `exit` (`exit_code`, `wall_seconds`, `out_sha256`, `reason`).
3. **`guest/out.tar`** holds the runner's exact `/out` tar, verbatim (entries under `out/`). Its sha256 is `exit.out_sha256`.

The task VM's compose labels `abalone.task_id`, `abalone.auth_hash` and `abalone.inputs_root` (runner-task-needs.md §3) put the
task binding inside the task compose_hash. The verifier checks the labels against the authorization.

## Checks, by claim

`abalone verify <dir> [--expect authorization.json] [--seen seen.txt]` runs offline in a fresh process. Exit 0 only if
there are no failures.

1. **Integrity (signatures and content).** The files match `bundle.json`, which is itself unsigned. The objects pass `task-v1` shape checks.
   `completion.sig` is over this completion. `h(authorization)` = `completion.auth_hash`, and the task_id, inputs_root, offer_id and
   worker agree. The device signature verifies. `events.jsonl` chains to `completion.events`. Each output file matches
   `completion.outputs`. The settlement adds up: `task:<id>:settle` is cited; reserved = the authorization's cap = charged + released;
   usage agrees; execution + inference = charged; the `charge` events in `events.jsonl` sum to it and their idems equal `settlement.debits`;
   usage is priced by the offer's tariff; the execution charge does not exceed billed seconds × rate; and the billed seconds do not exceed the
   runner's measured `exit.wall_seconds` (+1). `guest/` compose = clientData compose = `completion.guest.compose_hash`. The runner receipts verify under
   `receipt_pub`, chain from `task-start` to `exit`, and match `completion.guest.receipts`. The compose labels bind this task. `guest/out.tar`
   hashes to `exit.out_sha256` and holds the same outputs. With `--expect`, the authorization equals the client's. With `--seen`, no
   other execution record exists for this task_id (replay).
2. **An admitted execution produced this record.** The completion's runner evidence passes `verifyMacRunner`. The task boot assertion
   passes, its enrolled peer compose is admitted, the task image digest is in `peers.admit.task.images` and equals the offer's image,
   and the task compose is the no-network, no-KMS template. Certificates are checked **as of the
   enrollment's `enrolled_at`** (historical verification). Stated assumptions: Apple App Attest and the Mac's SIP/Secure Boot hold; the runner, as measured by its
   CDHash, isolates the task VM and alone holds its receipt key; the admitted peer built `/in` from exactly the authorized inputs and
   reports usage honestly; the Mac's owner can read the task's data; events neither the runner nor the peer saw are not covered.
3. **Task outcome (evidence, not a proof of correctness).** The command and exit status from `outputs/test.log`, compared with the authorization's
   `task.check`. With no `task.check` and no test log (e.g. a cancelled or budget-exhausted task), it reports "no test was requested"; a
   requested check with no test log is a failure. The files `patch.diff` touches, with test files called out. The money, labelled **Paid (gift credit)** or
   **Sponsored (development tariff): not paid execution**, with reserved, execution (seconds × rate, next to the runner's seconds),
   inference, charged and released amounts, and the settle entry.

Then **Failures**, **Unknowns** (e.g. no `--expect`, no `--seen`, the device-signed body includes input bytes the bundle omits,
and whether the worker's ledger really holds the line `settlement.entry_sha256` names, which `tools/reconcile-tasks.mjs` checks online) and
**Freshness**, which is kept separate from historical verification. Freshness asks whether the Apple evidence would still pass today, and says that admission
is judged by the verifier's current policy and that revocation is unknown, since no feed exists. The last line is the replay record
(`<task_id> <receipt_pub or events head>`) to append to the `--seen` file once the client accepts the bundle.

## What is safe to share

- A bundle holds the **outputs in plaintext** (patch, changed files, test log), the prompt (inside the authorization), the worker's event
  chain (agent text and tool calls) and the account and device ids. Share it only if all of that is shareable.
- Inputs appear only as unsalted sha256 (`authorization.inputs`, `inputs_root`, `task-start.inputs_sha256`). Anyone holding a candidate file
  can confirm it, and a short or guessable input can be recovered. Share a bundle only when the inputs are open or released.
- To share less, keep `completion.json`, `completion.sig`, `guest/` without `out.tar`, and `bundle.json` rewritten to list what remains. Claims 1 and 2 then
  still verify for what is present. The withheld files show up as failures. Selective sharing is not built in v1.

## FIXTURE

`tests/fixtures/bundle/fixture/` comes from `tests/fixtures/bundle/make-fixture.mjs` and carries a `FIXTURE` file, so every report is
labelled. The worker and runner keys are dev keys and the fix is hand-written. The repo, the device signature, every hash and chain, and the
`node --test` run are real. Claim 2 is refused on it by design. Replace it with a bundle collected from a real Track C run.
