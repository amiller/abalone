# Existing-browser extension: TEE inference working in the user's current session

User clarification, 9 October 2026: the intended browser experience is an Abalone extension in the user's existing signed-in browser, with a TEE-hosted GLM model driving useful browser work. A separate Abalone Chromium profile and a terminal `/browser grant` command alone do not demonstrate this journey. This is a product requirement and implementation handoff, not a claim that the extension is implemented.

## Product shape

The browser remains on the user's computer with its existing tabs, accounts and cookies. The Abalone extension connects an explicitly selected tab to the local agent shell. Selected page observations go to the admitted TEE inference route; model-requested actions return through the local broker and extension. The user sees activity and can stop, take control or disconnect from either surface.

The interaction reference is a coding-agent/browser-extension experience such as [Claude Code with Chrome](https://code.claude.com/docs/en/chrome). Abalone uses its own inference and admission path. This is not an instruction to route the browser through Claude or to provide the user's account credentials to a model.

Existing signed-in state is useful. Installing the extension should not require recreating the account, exporting the cookie jar, copying the whole profile, or restarting the everyday browser with a debugging port. A separate profile remains an optional identity choice, not the default substitute for the requested experience. Neko is not required.

## Demonstration journey

Use a synthetic signed-in Research Library account and fictional saved papers, clearly labeled. The browser looks and behaves like the existing working surface; Abalone does not become a bespoke research-library application.

| Stage | What the user does and sees | Success they recognize |
| --- | --- | --- |
| Enter from the existing tab | With Research Library already open and signed in, click the Abalone extension. Alternatively type `/browser grant` in the shell and select the tab in the browser. | “This is the tab and account I was already using.” |
| Connect the two surfaces | Choose the local shell session. The extension names the selected tab/site, model destination and allowed actions. Both surfaces show the same connection and control state. | “This terminal agent can work in this tab; I know which session is connected.” |
| Give an ordinary task | “In my saved papers, find the two about TEE inference, compare their abstracts, add both to my Abalone collection, and save a reading note here.” | They express the outcome rather than constructing low-level browser commands. |
| Watch useful work | The agent types the search, opens each result, reads the abstracts and performs the requested collection changes. The browser visibly navigates and changes; the shell shows compact tool activity. | “It can use the authenticated application, not just quote an arbitrary public page.” |
| Inspect completion | The browser's Abalone collection contains the two papers. The shell reports `reading-notes.md`, with links and the comparison. | The website state and local file both support the completion claim. |
| Take control and return | Click Take control in the extension or use `/browser take`. Inspect or edit the page personally. Resume deliberately or disconnect while leaving the tab and login usable. | Control visibly returns to the person. The agent does not keep reading or acting after revocation. |

First installation and pairing are part of Journey 0's verified-acquisition work, including the extension and native host. A demonstration that starts after extension installation must state that precondition.

## Authority and information flow

- Reuse browser-held authentication for the website's normal requests. Do not request or serialize cookie stores, saved passwords or a full profile into model context or traces. Page content itself can contain sensitive information; inspect what observations and URLs actually expose.
- The model can receive the selected tab's permitted observations, current task context and necessary tool results. Other tabs and browser-wide history are not automatic context. Broader scope requires a deliberate user action.
- The website still receives normal requests and actions under the signed-in account. TEE inference does not make the browser anonymous, move it into a TEE, or conceal actions from the site.
- Read, navigation, click and type capabilities must support the authorized task coherently. A task-level grant should not turn every routine click into a new approval. Material scope expansion and additional consequential actions follow the applicable user authority.
- The broker enforces grants independently of the model. Page instructions cannot widen the grant, switch the connected shell, or authorize new recipients. Check scope after navigation, redirects, new tabs and reconnects.
- Stop and Take control cancel outstanding/queued agent actions and prevent new observations while the human controls the tab. Revoke invalidates authority; reconnect must not resurrect it implicitly. Surface the same state in browser and terminal.
- Keep inference route, browser identity, execution location, network identity and retention distinct. Display effective retention honestly: the inspected ordinary connected session uses local plaintext history. Strict incognito currently rejects browser grants; do not silently relax that mode to make the demo work.

## Implementation direction

Prefer a browser extension connected to a local Abalone native host, with explicit binding to a selected shell session. Chrome provides [native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) for extension/native-application communication and an extension-origin allowlist. This is a starting transport, not complete authentication or permission design. Validate messages and bind requests to the actual grant, tab, origin, shell session and connection lifetime.

Start the permissions review with user-initiated tab access; [Chrome's activeTab documentation](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab) describes temporary access and its navigation lifetime. Select exact permissions based on the required operations. Do not infer permanent cross-origin access from activeTab, or describe broad debugger permissions as a browser-enforced one-tab sandbox. Compare DOM-based observation/actions with any debugger API actually needed and document the difference between browser enforcement and extension/broker enforcement.

Use the existing observation/action and grant model where it fits. A first version can use page text and structured elements. Screenshots or visual computer use require separately verified model capability and declared capture scope; the walkthrough's browser images are illustrations for the human, not evidence that a model consumed screenshots.

The extension sends observations through the local harness's admitted inference route. It should not contain a second generic model gateway or silently fall back to a non-TEE provider. Local native-host trust and remote service admission are separate assumptions.

## Current implementation gap

The inspected `notes/contracts/browser-grant.md` explicitly specifies a Chromium/CDP backend and no extension. Its default launches a separate Abalone profile; attach mode requires a browser started with a debugging port. That is useful underlying browser work, but does not establish the requested extension-based connection to an ordinary running profile. The existing-browser extension is now the primary product journey; CDP is a prototype/backend option rather than completion evidence for it.

## Acceptance milestones

1. **Connection:** install the reviewed extension/native-host pair, keep an existing signed-in browser open, select a tab, and bind it to the intended shell. Wrong extension/session and unsolicited page-origin messages cannot create a grant.
2. **Useful task:** on a synthetic authenticated site, carry out search, navigation, reading and an explicitly requested account-state change. Verify the resulting page state and a source-linked local artifact.
3. **Human control:** exercise Stop, Take control, resume, disconnect, expiry, navigation and reconnect while actions are pending. Browser and terminal agree about ownership; stale commands cannot execute afterward.
4. **Context and retention:** per-answer Activity identifies observed pages, model requests, browser actions, recipients and saved records. Check payloads/traces for unintended credential-store or unrelated-tab data using synthetic fixtures. Test rejected scope expansion and prompt injection without depending solely on model compliance.
5. **Evidence:** capture the actual installed extension, existing signed-in tab, meaningful task, visible actions and completed result. A grant-only screenshot, copied profile, mock browser, or unrelated CDP demonstration does not satisfy this journey.

The brochure scenes remain proposed interfaces with fictional site data. Runtime implementation belongs to the worker agent; do not count the new artwork as an implemented browser extension.
