# Private room handoff from an existing coding agent

Product direction confirmed by Andrew, 10 October 2026. This refines [Journey 0](journey-0-audit-to-private-session.md), especially rehearsal and first private use (J0.3/J0.4). It records the intended experience and success conditions; an implementation and exact commands still need qualification.

## Purpose and feeling

The user points their existing Claude Code, Codex or other coding agent at Abalone's repository. That agent helps inspect, acquire and try Abalone, then gives the user space for private work. Andrew's wording: it should “turn its eye away” and cooperate by “giving you the private room.”

The experience should feel welcoming and ordinary: a capable assistant prepares a room, demonstrates how it works, and steps outside. The user should know when practice ends, who can see the next input, and how to return. Nacre's character and the clarity of the terminal handoff are part of success. Avoid a long security lecture or an unexplained silent disconnect.

Abalone is a privacy-oriented Pi client with curated skills and admitted providers. This journey should remain small and useful; it does not require operating a dsmack node, buying a gift, or building a general service marketplace. Existing runtime boundary mechanisms remain necessary even when the Pi patch is small.

## Two supported journey designs

1. **Commands for the user's terminal.** The outside agent explains and supplies inspected setup/start commands. The user runs the private session in their own terminal. Private input never needs to pass through the outside agent's tools.
2. **Practice, prepare, hand over.** The outside agent rehearses with synthetic material and checks useful work, refusal and close behavior. It prepares a fresh session that the user can take over. Before inviting private input, the agent relinquishes observation and control through the declared handoff mechanism.

Do not invent a working attach/detach command or imply a terminal stopped being observable merely because it was opened in another window. Choose the simpler terminal-command route first if the host agent cannot meaningfully hand over a terminal it controls.

## Handoff contract

Before the handoff, the outside agent may inspect public source, explain limitations, install through a reviewed path and use synthetic examples. It must not request the real private task or folder contents to prepare the room. Setup diagnostics should be sufficient without those contents.

At the handoff, visibly distinguish rehearsal from the fresh private session. Show the effective provider, workspace authority, retention choice and who can observe the session. Tell the user where to type next. Example intent, not mandatory copy: “Your private session is ready. Continue in that terminal; I'll wait here.”

After the handoff, the cooperating outside agent stops tailing/capturing the terminal, reading private files, polling private state, or collecting the session transcript. No automatic session summary, notification payload, shared logfile or recovery action sends private content back to it. The user introduces sensitive material only after this transition.

On return, the outside agent receives only what the user deliberately brings back through an explicit sharing action. Closing the room does not authorize summarization. If help is needed, offer synthetic reproduction or user-reviewed diagnostics; inspecting the private session is a new, explicit access decision.

This differs from the existing MCP delegated-work pattern, where an outside agent calls Abalone and receives approved outputs. Preserve that integration as a separate journey; do not make automatic MCP result delivery the default for the private-room handoff.

## Cooperative privacy and enforced separation

A same-user agent with unrestricted shell/filesystem access can technically inspect that user's state. “Steps outside” describes cooperation unless an actual isolation boundary removes the capability. A separate terminal alone supplies no such enforcement. Document the strongest boundary the selected implementation actually provides, and label the cooperative route honestly.

A separately enforced profile may use an appropriate user/process/environment boundary. This note does not choose that mechanism or claim the current separate-user setup has passed end-to-end acceptance. The test and UI must distinguish observed non-access by a cooperating agent from denied access by an adversarial process.

Retain the current encrypted recoverable trace semantics unless a separate decision changes them. Ephemeral execution, retained encrypted history, deletion and a never-persist mode are distinct. This handoff does not itself provide anonymous routing, USB/Tails support, secure erasure or protection against an untrusted host.

## Success conditions for the implementation agent

| Condition | Evidence to collect |
| --- | --- |
| A fresh outside agent can prepare the room from the repo | Start with the repository and public instructions only; record missing prerequisites and maintainer interventions. No copied operator credentials or private workspace. |
| Practice is useful | Synthetic material yields a useful result, a meaningful refusal and a clear close/recovery explanation. |
| The person recognizes the transition | They can identify where to type, who receives the next input and what will remain. Inspect the visible handoff and ask them to explain it. |
| Private content stays out of the outside agent's context | Introduce a distinctive synthetic secret only after handoff. Inspect the outside agent's conversation, tool outputs, captures and notifications for it. Include a positive control showing the detector finds a deliberate test disclosure. This establishes the exercised channels, not universal non-observation. |
| Cooperation or enforcement is described accurately | For cooperation, inspect the absence of continued observation. For an enforced profile, additionally attempt unauthorized access and demonstrate refusal. Never use the former result to claim the latter. |
| Stop, failure and return preserve the boundary | Interrupt setup and the private session; no automatic private diagnostics or summary escapes. Returning without sharing discloses no content; selected sharing sends only the user-reviewed material. |
| The experience feels like being given space | A short real walkthrough shows preparation, rehearsal, explicit handoff, private work and voluntary return. Label agent-driven setup, mocks and actual boundaries. A green test log alone is insufficient. |

## Bounded next task

Inspect the existing launcher, incognito flow and Journey 0. Identify the smallest viable terminal-command route and its precise observer/retention model. Produce a short interaction sketch, a runnable synthetic rehearsal and a proposed handoff acceptance fixture. Record what is already implemented versus missing. Keep runtime changes, release qualification and public publishing separate from accepting this note.

If an agent-controlled session can be handed over, document how its capture, input and background watchers end before adding that route. Do not expand into dsmack operator onboarding or portable-OS construction to finish the first handoff.
