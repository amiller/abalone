# Abalone threat model

The maintained threat model is [Security profiles](security.md). It distinguishes
the owned-host friend preview, bubblewrap containment and connected/MCP sessions.
Read the selected profile before applying a confinement or retention claim.

`node tools/threat-model.mjs` writes a local capability snapshot for inspecting
the configured ordinary-session implementation. That snapshot is not the friend
profile's security contract and does not replace deployment qualification.
