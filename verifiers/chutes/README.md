# Chutes private inference integration

This directory is a self-contained Pi package. Load it in ordinary Pi or use its
JavaScript transport from another client. It does not import Dsmack's launcher,
coupon dependencies, session store or vendored Pi.

Follow [private inference in Pi](../../guides/private-inference/pi.md) for setup
and a useful sample task. Pi supplies its extension APIs; this package installs
only the pinned quote verifier and ML-KEM dependency. Node >=22.19 follows the
tested Pi release. Linux is tested; other platforms remain unqualified.

## Protection

`transport.mjs` checks the instance's fresh nonce and ML-KEM key binding, evidence
certificate binding, TDX quote, reviewed MRTD/RTMR measurements, up-to-date TCB
and signed NVIDIA GPU verdict. `provider.mjs` seals messages, tool definitions,
tool arguments and tool results to the verified key and authenticates the full
reply. `pi-extension.ts` registers that path using stock Pi's provider interface.

`chutes_measurements.json` is a reviewed snapshot of Chutes' unsigned measurement
list. The instance ID is a provider label; the quote binds the encryption key.
The VM measurements do not bind the serving code or establish which model
answered. No audited provider retention, local sandbox or network anonymity is
claimed. Credentials and conversation persistence follow the
[documented Pi setup](../../guides/private-inference/pi.md#connections-and-retention).

## Development checks

The repository's recorded Chutes fixture checks positive and negative attestation
cases. `tests/private-inference-stock.mjs` additionally runs against an independent
published Pi install and a packed copy of this package. It exercises sealed native
read/edit requests, authenticated replies and failures with agent retries enabled.
The synthetic instance used in that test is not live provider qualification.

Compatibility is pinned to Pi 1.1.0. Its agent error classifier treats billing
errors as final; the transport uses that documented-in-source compatibility
contract as well as disabling SDK retries. Requalify the actual agent replay
tests before changing the peer versions. There is no independent guarantee that
a future Pi version keeps the same error classification.
