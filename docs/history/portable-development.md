# Portable development workflow

> Historical: the workflow for the `portable-pi` feature branch, which is no longer the integration target; see [development workflow](../development.md).

`portable-pi` is the portable feature integration branch. Keep bounded changes
on separate topic branches and worktrees; target their PRs at `portable-pi` rather
than `main`. Follow the repository's [development workflow](../development.md)
and [contribution instructions](../../CONTRIBUTING.md).

## Start a topic

Once the feature branch is available on the hosted repository, fetch it explicitly
and create an isolated checkout from that revision:

```sh
git fetch https://github.com/amiller/abalone.git portable-pi
git worktree add -b work/portable-wallet ../portable-wallet FETCH_HEAD
```

For an unpublished local feature branch, create the worktree from the local
`portable-pi` ref instead. Keep credentials and disposable runtime state outside
tracked files. Do not copy private planning, transcripts or preserved history
into this repository.

After the change passes its relevant checks and publication review, push only
that topic and open a draft PR with base `portable-pi`. Describe the final behavior,
actual validation, platform scope and dependencies. Seek independent review before
merging into the feature branch. Feature integration does not qualify `main` or
an installable release; their offline gate and review requirements remain.

## Keep the loop small

Run terminal, conversation and wallet interactions as normal processes in a
desktop session. Restart the changed process and complete one relevant journey.
Use focused fixtures for financial and error handling; never silently replay a
potentially charged request. Wallet exploration begins read-only, with signing
and transaction approval remaining in the wallet.

Use QEMU for boot, storage and network-isolation changes. Check physical hardware
at complete feature milestones for ARM compatibility, resource use and speed.
Do not rebuild an image to check an unrelated terminal or wallet interaction.
Preserve logs and results, then remove disposable installs and build outputs.

The older
`work/portable-pi-workspace` draft PR is legacy work targeting `main`; it does
not define the new topic-PR base or establish release readiness.
