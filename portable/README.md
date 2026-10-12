# Portable sessions

This directory is reserved for running Abalone from a portable live system such
as [Tails](https://tails.net/about/index.en.html). Nothing here is supported
yet: USB/Tails is unqualified
([getting started](../docs/getting-started.md#supported-system)), and the NEAR
route fails on Tails because NVIDIA's attestation service refuses Tor exits
(issue [#15](https://github.com/amiller/abalone/issues/15)).

The direction is being explored in the maintainer's private research pull
request "Research Abalone on Tails: portable session spike". Results that hold
up will land here as public instructions and checks.
