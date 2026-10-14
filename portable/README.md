# Portable agent workspace

Experimental components for booting into a local agent workspace, with ARM64
rehearsals before Raspberry Pi USB testing. The presentation is independent of
the existing launcher.

- [Workspace](workspace/README.md): retained Linux terminals and a bounded Pi SDK
  lifecycle adapter. Its local model is scripted; SDK tool execution is real.
- [ARM64 rehearsal](raspberry-pi/README.md): disposable QEMU guest and kiosk setup.
- [SDK runtime bundle](raspberry-pi/sdk-runtime.md): package integrity checks and
  on-target runtime verification.

Qualification is limited to the documented prototype checks. The USB image,
Pi hardware boot, Tor-only startup, live inference and funding, and encrypted
reboot recovery remain development milestones. Use disposable state and the
component instructions. [Supported-system scope](../docs/getting-started.md#supported-system)
continues to apply.
