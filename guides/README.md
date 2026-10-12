# Guides

Guides explain how to stay private with existing software: what private
inference protects, how to pay for it, which network to connect from. They are
independent of Abalone's code; a route described here may work with any client.
Maintained procedures for the Abalone client itself stay in [docs/](../docs/README.md).

| Guide | Status |
| --- | --- |
| [Private inference](private-inference/README.md) | draft |
| [Acquiring private inference](acquiring-private-inference/README.md) | draft |
| [Local models](local-models/README.md) | todo |
| [Tor](networking/tor/README.md) | todo |
| [Nym](networking/nym/README.md) | todo |

## Status header

The first line of every guide is its status:

- `Status: todo`: a placeholder listing the questions the guide should answer.
- `Status: draft`: written, not yet reviewed. Treat its claims as unchecked.
- `Status: reviewed`: reviewed as described below, against the commit named in
  the pull request that changed the status.

## Contributing a guide

Pick a `todo` guide, answer its questions, and open a pull request that sets the
status to `draft`. Cite a source for each factual claim: a document in this
repository, a project's own documentation or a reproducible check. Name each
observer (sponsor, issuer, provider, payment network, network operator) instead
of calling a route anonymous.

A guide needs one of two reviews before its status becomes `reviewed`:

- **Editorial only:** explanations and pointers that do not tell the reader
  what is protected (background reading, terminology, links to other projects'
  instructions).
- **Security-sensitive:** anything a reader would rely on to stay private, such
  as what a payment route links to them, which network hides their address, or
  how to handle a key, seed or gift code. The reviewer checks each claim against
  its source and the [security profiles](../docs/security.md), and the pull
  request records what was checked. When in doubt, ask for this review.

An acquisition route is marked `reviewed` only after a second person, not the
author, has obtained access through it live and the pull request records the
date and outcome.

Changing a guide needs the documentation checks in
[CONTRIBUTING](../CONTRIBUTING.md#changes-and-review), not the runtime suite.
