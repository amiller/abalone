# Workspace interface

Dependency-free HTML, CSS and JavaScript for a portable agent workspace. Serve
this directory through the sibling workspace server
([`../server.mjs`](../server.mjs)) for a real local shell and the real agent
lifecycle adapter. Opening it through a plain static server still exercises the
interface: the agent composer then reports that no workspace server is
answering instead of fabricating output. No external fonts, scripts or image
services are loaded.

The agent tab is wired to the server’s real agent lifecycle API. The backend
embeds the vendored Pi SDK with a **scripted local model** — model turns are a
local script, while the admitted `read`/`write` tools execute for real inside
the server workspace. The interface labels this honestly: “Local scripted
agent; real tools”. It is not provider inference. When the SDK is not built,
`GET /api/status` reports the reason and the composer shows it; no canned
success is ever displayed in its place. Tor connection and funding states
remain explicitly simulated fixtures until live adapters exist.

Keyboard access: Tab navigates controls, Ctrl/Cmd+K focuses the agent composer,
Ctrl/Cmd+Enter submits, and arrow keys switch between terminal/file tabs and
between terminal session tabs. Ctrl+C in the command input interrupts the
selected shell. Below 1101px (with the sidebar visible) the left navigation
switches between the full agent and terminal panes; wider screens keep the
split view, and the stacked single-column layout below 651px is unchanged.
The shell view is a plain-text PTY transcript, not a full-screen terminal
emulator.

## API use

All requests use the same origin. Mutation requests send Content-Type
`application/json` and `X-Workspace-Token` from the status response.

- `GET /api/status`: `{terminalAvailable, csrfToken, workspace, agent}`. The
  composer hint and submit gating come from `agent {available, kind, detail}`;
  unavailable runs surface the server’s reason plus how to fix it.
- `POST /api/agents` `{prompt}`: `201 {id}` starts a run. `503` shows the
  unavailable detail, `409` reports capacity; in every failure case the prompt
  stays in the composer and nothing is resent automatically. The prompt is only
  cleared after a `201`.
- `GET /api/agents/:id/events?after=N`: `{events, offset, truncated, state}`.
  The UI polls with the previous offset (450 ms) and renders streamed
  `text_delta` text as it arrives, tool progress lines (`tool_start`/`tool_end`
  with the target path), and terminal outcomes (`done` reports that the scripted
  agent wrote `agent-run.txt` in the server workspace — inspectable from the
  terminal tab; the UI has no file-read API and does not pretend to show it).
  `truncated` is surfaced instead of hidden. Poll failures retry a bounded
  number of times, then report a lost stream without resubmitting anything.
  Polling continues until the `state` field is terminal. The payload-free
  `worker_reported_done` marker records a provisional worker claim. The
  backend publishes canonical `done` and its completion details only after
  the worker process actually exited cleanly, so a done-then-hang or
  done-then-nonzero worker ends as a still-polled run settling to
  `timeout`/`error`, never as success.
- `DELETE /api/agents/:id`: Stop awaits the backend outcome (the event poll
  must reach a terminal state) with an abort timeout; a timed-out stop says so
  instead of claiming success.
- `GET /api/terminals`: `{sessions: [{id, exited}]}`. Terminal sessions are
  tabs: “New session” opens an additional PTY and closes nothing, and the
  explicit “Close session” action closes only the selected PTY. Each tab
  retains its own transcript buffer, output offset and command draft, so
  switching reattaches exactly that session; only the selected session is
  polled, a switch cancels the previous poll loop (a late poll or input
  result is never applied to a different terminal), and Ctrl+C targets the
  selected session. On load the UI restores this tab’s surviving sessions
  from sessionStorage — including which session was selected — replaying each
  transcript from the server’s bounded buffer; sessions that no longer exist
  are reported, sessions from other tabs are never adopted, and no automatic
  replacement is created. The server’s eight-session cap surfaces as a
  message when “New session” hits it, leaving existing sessions untouched.
- Terminal output polling (`after=` previous offset), input sending and Ctrl+C
  behave as before; input mutations are never silently retried.

Reload behavior: this tab’s terminal session list and selected session, the
agent run id and the composer draft are kept in `sessionStorage`, so a reload
restores the same PTYs (selected tab included, transcripts replayed) and
reattaches the same agent run (from event offset 0) instead of restarting
work. New tabs start fresh sessions.

## Preview fixture, visibly separate

Connection/credit scenarios and the browser “hello.txt” preview remain as
explicit fixtures under “Preview scenarios” in the footer. The preview fixture
runs the old scripted interaction entirely in browser memory, labelled
“Preview · browser fixture”, and never contacts the workspace server. The
file tab shows that browser-memory fixture only; real agent writes land in the
server workspace and are inspected through the terminal.

## Rendering policy

All server- and model-derived text is rendered with `textContent`/text nodes;
`innerHTML` is never used. Terminal control sequences are stripped, never
executed. A live provider adapter must keep these properties: honest
unavailable states, no automatic replay of ambiguous starts or inputs, and
connection/funding labels that never upgrade to live claims without
end-to-end evidence.
