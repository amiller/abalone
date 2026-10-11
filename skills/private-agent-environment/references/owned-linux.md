# Owned Linux rehearsal: proposed first qualification target

This is a source-derived procedure for a later authorized synthetic rehearsal,
not an installer or a passed evaluation. The chosen contract trusts the owner,
administrator and kernel. It tests agent containment and encrypted trace
recovery; full workspace locking additionally requires a lab-prepared encrypted
volume. A same-user outside agent has cooperative privacy only.

## Prerequisites and entry point

Use a clean topic checkout and disposable paths. Follow the repository's
[contribution build recipe](../../../CONTRIBUTING.md); it needs Linux, Node 24,
bubblewrap, built Pi/ACI packages, a valid curated manifest and an owner-only
`XDG_RUNTIME_DIR`. Missing dependencies are a stop, not permission to install or
run a weaker substitute. Offline fixture models prove exercised runtime
behavior only; useful autonomous setup needs a separately available, frozen
local model and harness. No real API keys or remote calls are required.

The following are **existing command forms**, not commands executed in this proposed procedure.
For a later lab run, define `environment_root` as a fresh directory in the
prepared encrypted volume, `workspace` as its synthetic work folder and
`local_model_id` as an already configured loopback model ID. Put `ABALONE_DIR`
under `environment_root`, outside `workspace`; otherwise granting the whole
workspace can expose state. Set `ABALONE_CONFIG` to the lab's reviewed fixture
configuration before invoking the launcher, with no admitted remote providers,
gift coupons or outside runners. Passphrase/key actions belong to the lab user.

```sh
export ABALONE_DIR="$environment_root/state"
export ABALONE_CONFIG="$environment_root/config"
bin/abalone trace key init
bin/abalone canary init "$workspace"
bin/abalone --incognito "$workspace" --model "$local_model_id" --keep-trace
bin/abalone trace list "$workspace"
bin/abalone trace open "$workspace" "$trace_id"
bin/abalone --incognito "$workspace" --model "$local_model_id" --with-trace "$trace_id"
```

`trace_id` is obtained from the completed run, not guessed. Do not collect the
output of `trace open` or `trace key export` into the setup agent's context for
a private session. Export/import key recovery exists, but export prints a raw
identity; rehearse only with disposable synthetic keys. `node keys add` validates
against a remote endpoint and is outside this offline procedure.

## State to verify

The launcher source uses strict-incognito tmpfs state for Pi and encrypts a
recoverable trace under `workspace/.abalone/traces/`. The passphrase-protected
identity, public recipient and trace high-water marks are under `ABALONE_DIR`;
the launcher also records egress metadata there. Outputs in `workspace` are
plaintext until the enclosing volume locks. Terminal scrollback/captures, swap,
crash dumps and host backups must be separately accounted for. A filesystem
mode of 0600 is access control, not encryption.

Inspect actual sandbox mounts, child processes, destination sinks and files
with the independent probes in the
[security profile](../../../docs/security.md).
Do not treat `/privacy`, `caps` or the model's explanation as an independent
oracle. Report any discrepancy between descriptors and observations before qualification.

## Stop, lock, reopen and recover

Exit the session through its intended UI and verify session/subprocess exit and
socket cleanup. Suspension is not exit. The user/lab operator then stops every
writer and locks the prepared volume using that volume's documented mechanism;
Abalone currently has no whole-environment lock command. Verify the mount is
gone and a test reader cannot find the synthetic workspace marker. If locking
fails, report “stopped, storage still unlocked”; do not say “locked.”

Unlock through the same storage mechanism, rerun prerequisite checks and use
the explicit reopen form above. This tests process restart, not host reboot.
First lifecycle qualification also requires an actual host reboot explicitly
authorized and performed by the lab operator; no reboot is performed in this proposed procedure.
Until that check completes, report reboot continuity as untested.

After reboot, an independent actor verifies a new boot occurred, the short
owner-only runtime directory was recreated, and the frozen local model starts
through its declared service/login procedure. Record any required login or
manual startup rather than implying unattended availability. Unlock the volume
through its declared mechanism and verify the same workspace, reviewed config,
`ABALONE_DIR`, recipient/identity and trace ID before reopening. Recheck the
required model route and denied destinations, including a route outage with no
direct or ordinary-provider fallback. Then recover the trace through the explicit
reopen form and verify the synthetic result. A process relaunch or successful
reopen before reboot cannot satisfy these post-boot checks.

Wrong key/passphrase must fail without plaintext. Recovery on another disposable
state directory requires the matching exported
identity, a ciphertext trace copy and an explicit import. A copied workspace
does not include the identity; absent high-water marks reduce rollback evidence.
Declare that reduction and test it rather than promising freshness on migration.

Before teardown, distinguish trace removal (`bin/abalone trace delete
"$workspace" "$trace_id"`), key destruction, volume removal and credential
revocation. Never infer secure erasure or remote revocation from file deletion.
