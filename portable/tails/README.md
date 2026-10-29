# Tails integration placeholder

This directory reserves a platform boundary for future Tails integration.
It contains no working Tails port, boot recipe or qualified live-system image.
See the [portable overview](../README.md) for shared components and the
[development workflow](../../docs/development.md) for contribution boundaries.

Keep upstream Tails source checkouts, downloaded images, builds and raw evidence
outside this source tree. None is imported here. A future integration must record
its upstream revision, provenance and actual acceptance without committing large
build outputs or private operator state.

The Raspberry Pi platform's boot, clock, network and storage rules are specific
to that platform. Shared inference and funding code does not automatically inherit
Tails' anonymity, amnesia, persistence behavior or security properties. Establish
those boundaries explicitly before claiming a supported Tails experience.
