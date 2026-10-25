# Dsmack portable workspace

Experimental components for a portable agent computer. The Raspberry Pi USB
prototype uses ordinary Bash and the native Pi terminal interface. Develop the
next terminal and wallet interactions as ordinary desktop processes; restart the
changed process rather than rebuild an OS image for each edit.

## Layout

- [ZCon demo](zcon-demo/README.md): what the USB stick does and how the pieces fit.
- [Raspberry Pi platform](raspberry-pi/README.md): target-specific boot images,
  administrator enrollment, clock, display, network and encrypted storage.
- [Tails integration](tails/README.md): reserved integration boundary; no working
  Tails port is provided here.
- Shared [inference broker](inference/README.md) and
  [funding](funding/README.md): inference and financial operations with distinct
  authority and lifetimes.
- Shared [browser workspace](workspace/README.md): terminals and a Pi SDK
  lifecycle adapter. The browser and earlier custom curses UI are retained
  prototypes; neither defines the native terminal experience.
- `workspace-service/` and `credit-journal/`: shared service integration and
  credit-observation components.
- [Development workflow](DEVELOPMENT.md): topic worktrees and PRs targeting the
  `portable-pi` feature branch.

A platform must explicitly integrate and verify the shared components. Their
presence does not establish Tor enforcement, secret custody, persistence or
compatibility on another live system.

## Current scope

The [ZCon demo](zcon-demo/README.md) runs native-agent tasks, encrypted credit
recovery and Zcash funding on Raspberry Pi hardware. Those runs do not establish
general conversation reliability or reproduce a fresh installation. A response
that reaches its token limit is shown as incomplete. A provider, transport or
admission failure before an answer is retried up to three times; a refused
response is not, and a retry may be charged as a second completion.

Use QEMU for changes to boot, storage or network isolation, and hardware checks
at feature milestones for ARM compatibility and performance. This is a feature
checkpoint, not an installable release. Full offline integration, independent review and
release qualification remain separate. Use disposable state and follow the
component instructions. [Supported-system scope](../docs/getting-started.md#supported-system)
applies.
