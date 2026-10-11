# Code contribution instructions

Read README.md, CONTRIBUTING.md and docs/development.md. This repository must be usable without the
maintainer's private planning workspace. Keep private notes, credentials and raw
operator state out of commits. Make bounded changes on topic branches/worktrees;
use independent review before integration. Runtime/protocol changes need relevant
positive and negative checks. Documentation-only work needs link and whitespace
checks. Do not change live services or publish artifacts as a side effect of editing.

Source is public; installed-release and live-service qualification remain
separate from integration. First-party code is MIT licensed; existing
component notices remain applicable. Source publication and installable-release
qualification are separate reviewed actions. Do not expose private history,
change visibility or publish a release as a side effect of development. Existing historical component
documents retain their original scope; docs/roadmap.md sets current priorities.
