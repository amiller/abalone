# Choosing checks

Run the smallest checks that exercise the changed behavior while developing.
The private planning workspace has no runtime test gate. Research validators there
apply to their own artifacts. The code repository owns the client tests; its name
or visibility does not make a second copy of the runtime suite necessary.

The optional commit hooks check staged imports and regenerate admission hashes.
They do not build, install dependencies or run runtime tests. GitHub's current
Docs workflow checks local documentation links on pull requests and main pushes.
Runtime checks are invoked explicitly; a green Docs job is not runtime validation.

## During development

| Change | Start with |
| --- | --- |
| Private notes or planning | Check the edited artifact; no runtime install or suite |
| Public prose or links | `make verify-docs` |
| Executable setup instructions | Documentation checks and a rehearsal of the changed procedure |
| Acquisition or compact policy display | `node --test tests/coupon-acquire.test.mjs tests/session-policy.test.mjs` |
| Launcher or local isolation | The affected session, state, mounts, egress or incognito checks; include refusal paths |
| Shared provider verification | Relevant recorded Chutes/NEAR checks, including invalid evidence and key binding |
| Standalone Pi provider | `STOCK_PI_ROOT=/isolated/published-pi node --test tests/private-inference-stock.mjs` |
| Installation or portable packaging | Installer/packaging checks against synthetic inputs, then an unpacked-client rehearsal |

Keep the staged-import and admission-manifest checks. Stage the intended source
before `node tools/manifest-index.mjs --write`; use `--check` to verify the staged
manifest. A Git hook's admission check is not a replacement for behavior tests.

The standalone Pi checks use an independent, published Pi installation and packed
provider package. They are outside `make verify-offline` and current CI. Run them
explicitly when changing that integration, its credential/transport boundaries,
packaging, or pinned Pi/verifier versions. A full offline pass alone does not
cover compatibility with ordinary Pi.

List suites with `tests/verify.sh --list`. Run selected offline suites, for example:

```sh
tests/verify.sh offline documentation session-policy
tests/verify.sh offline tui
```

A unique first word or the exact full suite name selects a suite. Ambiguous names
refuse before any suite runs; use the full name from `--list`. This selection is a
convenience, not an automatic impact analysis. Explain why the checks cover the
changed behavior. Do not weaken assertions merely to get a passing result.

## Before integration

Runtime changes need relevant positive and negative checks, independent review,
and one full offline integration run after the candidate has stabilized. Run
heavy builds on the designated development host. Check prerequisites first:
Node/build/dependency versions, bubblewrap, tmux, browser availability, runtime
directory and Python scientific-package compatibility for the selected suites.

When a suite fails, diagnose and rerun that suite first. Environment repairs and
individual assertion fixes do not require restarting every suite during iteration.
After material runtime changes, use the settled candidate for the final gate.

Reuse passing evidence with its original revision and environment, explaining why
later edits cannot affect it. Prose-only changes after a passing gate need docs
checks and any affected display/procedure check, not another full runtime run.
Do not call reused evidence a fresh run or an exact-head gate.

The runner keeps distinct logs and a result record with source revision, tracked
changes, untracked-source presence, requested suites, lockfile hashes and environment. A build identity can be supplied through
`ABALONE_TEST_BUILD_ID`; without it, builds are explicitly unrecorded. Those records
help attribute results; they do not prove all installed dependencies match a lock.
Preserve evidence, then remove test installs/build outputs according to disk policy.

## Release and live checks

`make verify-offline` uses local, synthetic or recorded inputs. `make verify` also
runs network checks without spending. Real credentials, paid inference, hardware,
installation qualification and owner acceptance are separate checks. Run them when
the claimed outcome changes, not after every source edit. Live or paid checks need
a bounded purpose and budget. Offline fixtures do not establish live readiness,
friend acceptance or platform support that was never exercised.
