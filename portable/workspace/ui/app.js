const $ = (id) => document.getElementById(id);

// Honest labels: the backend agent is a local scripted model driving real SDK
// tools. Connection and funding states stay simulated fixtures.
const AGENT_LABEL = 'Local scripted agent; real tools';
const RUN_LABELS = {
  starting: 'Starting', running: 'Working', done: 'Complete', aborted: 'Stopped',
  error: 'Error', timeout: 'Timed out', killed: 'Terminated', unavailable: 'Unavailable',
  gone: 'Ended (not on server)',
};
const TERMINAL_RUN_STATES = ['done', 'aborted', 'error', 'timeout', 'killed', 'unavailable'];
const AGENT_POLL_MS = 450;
const AGENT_STOP_TIMEOUT_MS = 8000;
const MAX_POLL_FAILURES = 6;

const store = {
  get(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { sessionStorage.setItem(key, value); } catch { /* storage unavailable */ } },
  remove(key) { try { sessionStorage.removeItem(key); } catch { /* storage unavailable */ } },
};

const state = {
  scenario: 'funded', payment: 0, run: 0, running: false, runningPreview: false,
  token: null, terminalBusy: false,
  serverOk: null, agent: { available: false, kind: null, detail: null },
  agentRun: null, pollFailures: 0,
  // One entry per retained PTY session: {id, label, buffer, offset, exited,
  // disconnected, pollToken, draft, note}. Only the selected session is
  // polled; switching reattaches from that session's own offset.
  terminalSessions: [], selectedTerminal: null,
};
let streamText = null;      // active streaming assistant text node
let streamedChars = 0;      // whether any text_delta arrived this run
const pendingTools = [];

const phases = ['Awaiting payment', 'Payment detected', 'Confirming', 'Converting', 'Credit ready'];
const connected = () => ['funded', 'unfunded'].includes(state.scenario);

function render() {
  const labels = { funded: 'Tor ready · simulated', unfunded: 'Tor ready · simulated', connecting: 'Tor connecting · simulated', offline: 'Offline · simulated', reconnect: 'Tor interrupted · simulated' };
  $('connection').textContent = labels[state.scenario];
  $('connection').classList.toggle('waiting', !connected());
  $('credit').textContent = state.scenario === 'funded' ? '$4.82 credit ↗' : state.scenario === 'unfunded' ? 'Add credit ↗' : 'Credit unknown ↗';
  $('credit-freshness').textContent = state.scenario === 'funded' ? 'Example provider · fresh fixture' : state.scenario === 'unfunded' ? 'Example provider · $0 fixture' : 'No balance refresh';
  $('payment-steps').hidden = !connected();
  $('credit').title = state.scenario === 'funded' ? 'Example provider · simulated balance · refreshed just now' : 'No live balance has been fetched';
  $('composer-hint').textContent = agentHint();
  $('funding-description').textContent = connected() ? 'Example provider credit. This preview demonstrates the funding journey without a wallet or payment address.' : 'Waiting for a connection. Your balance is unknown; no payment instruction is available.';
  $('payment-steps').replaceChildren(...phases.map((phase, i) => { const item = document.createElement('li'); item.textContent = phase; item.className = i <= state.payment ? 'done' : ''; if (i === state.payment) item.setAttribute('aria-current', 'step'); return item; }));
  $('advance-payment').textContent = state.payment === 4 ? 'Reset funding preview' : `Simulate: ${phases[state.payment + 1].toLowerCase()}`;
  $('advance-payment').disabled = !connected();
}

function agentHint() {
  if (state.serverOk === null) return 'Checking workspace server…';
  if (state.serverOk === false) return 'No workspace server · static preview';
  if (!state.agent.available) return `Agent unavailable · ${state.agent.detail || 'Pi SDK not built'}`;
  if (state.agent.kind === 'fixture') return 'Fixture transport (server tests only)';
  return AGENT_LABEL;
}

function unavailableMessage() {
  if (state.serverOk !== true) {
    return 'No workspace server is answering /api/status. Start one with: node portable/workspace/server.mjs --workspace <disposable-directory> (see portable/workspace/README.md), then reload this page. This interface will not fabricate agent output.';
  }
  const detail = state.agent.detail || 'the vendored Pi SDK is not built';
  return `Agent unavailable: ${detail}. Build the vendored SDK and restart the workspace server (see the “Agent adapter” section of portable/workspace/README.md), then reload. Real output is never faked; terminals keep working and the preview fixture in the footer can still demonstrate the interface.`;
}

function appendActivity(el) { $('activity').append(el); $('activity').scrollTop = $('activity').scrollHeight; }
function message(kind, text, labelText) {
  $('activity').querySelector('.welcome')?.remove();
  const el = document.createElement('div'); el.className = `message ${kind}`;
  const label = document.createElement('strong');
  label.textContent = labelText ?? (kind === 'user' ? 'You' : kind === 'preview' ? 'Preview · browser fixture' : kind === 'agent' ? 'Agent · scripted local' : 'Status');
  el.append(label, document.createTextNode(text)); appendActivity(el);
}
function toolLine(name, detail) {
  const el = document.createElement('div'); el.className = 'message tool';
  const label = document.createElement('strong'); label.textContent = `Tool · ${name}`;
  el.append(label, document.createTextNode(` → ${detail}`));
  el.dataset.tool = name; appendActivity(el); return el;
}
function toolDetail(args) {
  if (typeof args !== 'string' || !args) return '(no arguments shown)';
  try { const parsed = JSON.parse(args); if (parsed && typeof parsed.path === 'string') return parsed.path; } catch { /* raw JSON string */ }
  return args.length > 220 ? `${args.slice(0, 220)}…` : args;
}
function openStream() {
  if (streamText) return;
  $('activity').querySelector('.welcome')?.remove();
  const el = document.createElement('div'); el.className = 'message agent';
  const label = document.createElement('strong'); label.textContent = 'Agent · scripted local';
  streamText = document.createTextNode('');
  el.append(label, streamText); appendActivity(el);
}

// ---- Agent lifecycle (real backend adapter) ----

function isTerminalRun(runState) { return TERMINAL_RUN_STATES.includes(runState); }
function runLabel(runState) { return RUN_LABELS[runState] ?? runState; }

function renderAgentEvent(event) {
  if (event.type === 'state' && event.state === 'running') { $('agent-status').textContent = RUN_LABELS.running; return; }
  if (event.type === 'agent_event') {
    const inner = event.event;
    if (inner === 'message_start') { if (event.role === 'assistant') openStream(); return; }
    if (inner === 'text_delta') { openStream(); streamText.appendData(String(event.delta ?? '')); streamedChars += String(event.delta ?? '').length; return; }
    if (inner === 'message_end') { streamText = null; return; }
    if (inner === 'tool_start') { pendingTools.push(toolLine(String(event.tool ?? 'tool'), toolDetail(event.args))); return; }
    if (inner === 'tool_end') {
      const name = String(event.tool ?? 'tool');
      const index = pendingTools.findIndex(el => el.dataset.tool === name);
      if (index !== -1) { const el = pendingTools[index]; el.append(document.createTextNode(event.isError ? ' · failed' : ' · done')); pendingTools.splice(index, 1); }
      return;
    }
    if (inner === 'auto_retry_start') { message('system', `SDK retry started (attempt ${event.attempt ?? '?'}); retries are supposed to be disabled.`); return; }
    return; // lifecycle markers (agent_start, turn markers) stay visible via status
  }
  if (event.type === 'worker_reported_done' || event.type === 'done') {
    // Worker completion is provisional until the manager confirms clean exit.
    if (state.agentRun) state.agentRun.reportedOutcome = event;
    return;
  }
  if (event.type === 'aborted') { if (state.agentRun) state.agentRun.sawOutcome = true; message('system', 'Run stopped. Your draft and workspace files remain.'); return; }
  if (event.type === 'unavailable') { if (state.agentRun) state.agentRun.sawOutcome = true; message('system', `Agent became unavailable: ${event.reason ?? 'unknown reason'}.`); return; }
  if (event.type === 'error' || event.type === 'fatal') {
    if (state.agentRun) state.agentRun.sawOutcome = true;
    message('system', `Run failed: ${event.message ?? event.error ?? event.reason ?? 'unknown error'}. Nothing is resent automatically.`);
  }
}

function resetRunTranscriptState() { streamText = null; streamedChars = 0; pendingTools.length = 0; state.pollFailures = 0; }

function setRunningUI(running) {
  $('stop-agent').hidden = !running;
  $('stop-agent').disabled = false;
  $('send-agent').disabled = running;
}

function finishRun(runState) {
  const run = state.agentRun;
  if (!run || run.ended) return;
  run.ended = true; state.running = false;
  setRunningUI(false);
  $('agent-status').textContent = runLabel(runState);
  if (runState === 'done') {
    const outcome = run.reportedOutcome;
    if (typeof outcome?.lastText === 'string' && outcome.lastText && streamedChars === 0) message('agent', outcome.lastText);
    const wrote = outcome?.wrote;
    if (typeof wrote === 'string' && wrote) {
      message('system', 'Run complete. The scripted agent wrote ' + wrote + ' in the server workspace through the real SDK write tool. Inspect the file from the Terminal tab. Scripted model, not provider inference.');
    } else {
      message('system', 'Run complete. The local scripted task finished; no file write was reported. Scripted model, not provider inference.');
    }
    return;
  }
  // The terminal state can be observed before the worker's outcome event line
  // lands, so the status message must not depend on that event arriving.
  if (runState === 'gone') message('system', 'The server no longer reports this run; it finished, was stopped elsewhere, or the server restarted.');
  else if (runState === 'timeout' || runState === 'killed') message('system', `The server ended this run (${runLabel(runState).toLowerCase()}).`);
  else if (!run.sawOutcome) message('system', run.stopAcked ? 'Run stopped. Your draft and workspace files remain.' : `Run ended (${runLabel(runState).toLowerCase()}). Nothing was resent automatically.`);
}

async function pollAgent() {
  const run = state.agentRun;
  if (!run || run.ended) return;
  try {
    const result = await api(`agents/${encodeURIComponent(run.id)}/events?after=${run.offset}`);
    if (state.agentRun !== run) return;
    state.pollFailures = 0;
    run.offset = result.offset;
    for (const event of result.events) renderAgentEvent(event);
    if (result.truncated) message('system', 'Older activity was dropped by the server’s bounded event buffer.');
    if (isTerminalRun(result.state)) { finishRun(result.state); return; }
    setTimeout(pollAgent, AGENT_POLL_MS);
  } catch (error) {
    if (state.agentRun !== run) return;
    if (error.status === 404) { finishRun(run.stopAcked ? 'aborted' : 'gone'); return; }
    state.pollFailures += 1;
    if (state.pollFailures >= MAX_POLL_FAILURES) {
      $('agent-status').textContent = 'Stream lost';
      message('system', `Lost the agent event stream after ${state.pollFailures} tries (${error.message}). The run may still be active on the server; nothing is resubmitted automatically. Reload this page to reattach.`);
      run.ended = true; state.running = false; setRunningUI(false);
      return;
    }
    $('agent-status').textContent = 'Reconnecting…';
    setTimeout(pollAgent, 1000);
  }
}

async function startAgent(prompt) {
  if (state.serverOk === true && !state.agent.available) { message('system', unavailableMessage()); return; }
  state.running = true; setRunningUI(true);
  $('stop-agent').disabled = true; // no run id yet: Stop cannot act until the 201 returns
  $('agent-status').textContent = RUN_LABELS.starting;
  try {
    const result = await api('agents', 'POST', { prompt });
    $('prompt').value = ''; store.remove('portable-prompt');
    resetRunTranscriptState();
    state.agentRun = { id: result.id, offset: 0, ended: false };
    store.set('portable-agent', JSON.stringify({ id: result.id }));
    $('stop-agent').disabled = false;
    message('system', `Started run ${result.id}. ${AGENT_LABEL}.`);
    pollAgent();
  } catch (error) {
    state.running = false; setRunningUI(false);
    $('agent-status').textContent = 'Not started';
    if (error.status === 503) {
      state.agent.available = false; state.agent.detail = error.detail || state.agent.detail || 'Pi SDK unavailable';
      render(); message('system', unavailableMessage());
    } else if (error.status === 409) {
      message('system', `Agent capacity is reached (${error.detail || 'too many active runs'}). The prompt stays in the composer; try again once a run finishes.`);
    } else if (error instanceof TypeError) {
      // Unknown outcome: no response arrived, so the run may or may not have
      // started. A run existing on the server is not proof it is this prompt
      // (it may be another tab's), so nothing is attached or started here.
      message('system', 'The start request could not reach the server, so its outcome is unknown. The prompt stays in the composer; it is not resent automatically.');
      try {
        const listing = await api('agents');
        const alive = (listing.agents ?? []).filter(agent => agent.alive);
        if (alive.length === 0) message('system', 'The server lists no active runs, so the prompt most likely never started.');
        else message('system', `The server lists ${alive.length} active run${alive.length === 1 ? '' : 's'} (${alive.map(agent => agent.id).join(', ')}). An existing run is not evidence this prompt started — it may be another tab’s — so nothing is attached automatically. Reconcile explicitly: inspect the runs from the terminal, or reload to reattach a run this tab saved.`);
      } catch { /* listing unavailable too; the outcome stays unknown */ }
    } else {
      message('system', `${error.message}. The prompt is still in the composer; it was not resent automatically.`);
    }
  }
}

async function stopAgent() {
  const run = state.agentRun;
  if (!run || run.ended) return;
  $('stop-agent').disabled = true;
  $('agent-status').textContent = 'Stopping…';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_STOP_TIMEOUT_MS);
  try {
    // The DELETE resolves only after the worker has exited (or the kill
    // grace elapsed), so awaiting it is awaiting the backend outcome.
    await api(`agents/${encodeURIComponent(run.id)}`, 'DELETE', undefined, controller.signal);
    run.stopAcked = true;
    let outcome = 'aborted';
    try {
      // Drain any final events (abort line, streamed text) before concluding;
      // the record is reaped after a stop, so a 404 here is expected.
      const result = await api(`agents/${encodeURIComponent(run.id)}/events?after=${run.offset}`);
      if (state.agentRun === run) { run.offset = result.offset; for (const event of result.events) renderAgentEvent(event); if (isTerminalRun(result.state)) outcome = result.state; }
    } catch { /* record already reaped by the confirmed stop */ }
    if (state.agentRun === run) finishRun(outcome);
  } catch (error) {
    if (error.name === 'AbortError') message('system', 'The stop request timed out. Still waiting for the server’s outcome; the run is not assumed stopped and nothing is resent.');
    else if (error.status === 404) { run.stopAcked = true; if (state.agentRun === run) finishRun('gone'); }
    else message('system', `Stop request failed: ${error.message}. Still waiting for the run’s outcome via the event stream.`);
    if (state.agentRun === run && !run.ended) $('stop-agent').disabled = false;
  } finally {
    clearTimeout(timer);
  }
}

async function initAgentReattach() {
  const saved = store.get('portable-agent');
  if (!saved) return;
  let id = null;
  try { id = JSON.parse(saved).id; } catch { /* corrupted entry */ }
  if (!id) { store.remove('portable-agent'); return; }
  try {
    const result = await api(`agents/${encodeURIComponent(id)}/events?after=0`);
    resetRunTranscriptState();
    state.agentRun = { id, offset: result.offset, ended: false };
    for (const event of result.events) renderAgentEvent(event);
    if (isTerminalRun(result.state)) {
      finishRun(result.state);
      if (result.events.length === 0) message('system', `Reloaded; run ${id} already ${runLabel(result.state).toLowerCase()}.`);
    } else {
      state.running = true; setRunningUI(true);
      $('agent-status').textContent = `Reattached · ${runLabel(result.state).toLowerCase()}`;
      pollAgent();
    }
  } catch (error) {
    if (error.status === 404) { store.remove('portable-agent'); }
    else message('system', `Could not reattach to run ${id} (${error.message}). Nothing is restarted automatically.`);
  }
}

// ---- Explicit browser preview fixture (no backend involvement) ----

async function runPreviewFixture() {
  if (state.running) { message('preview', 'A real agent run is active; the preview fixture waits until it finishes.'); return; }
  if (state.runningPreview) return;
  if (!connected()) { message('preview', 'The preview fixture needs a connected scenario (see Connection & credit below).'); return; }
  if (state.scenario === 'unfunded') {
    $('funding').hidden = false; $('credit').setAttribute('aria-expanded', 'true');
    message('preview', 'This scenario needs compute credit. Use the simulated funding steps; no real payment is involved.');
    return;
  }
  state.runningPreview = true; $('preview-agent').disabled = true;
  message('preview', 'Running the scripted preview entirely in this browser. No workspace server, model or tools are involved.');
  await new Promise(resolve => setTimeout(resolve, 1200));
  $('file-content').textContent = 'Hello, world.\n\nA little computer. A place for your ideas.\n\nCreated by the preview fixture, in browser memory only.\n';
  message('preview', 'Created hello.txt in the browser-memory file viewer — a fixture, not the server workspace and not a real write.');
  state.runningPreview = false; $('preview-agent').disabled = false;
}

// ---- Shared API helper (textContent-only rendering of anything it feeds) ----

async function api(path, method = 'GET', body, signal) {
  const response = await fetch(`/api/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(state.token ? { 'X-Workspace-Token': state.token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    let detail = '';
    try { const data = await response.json(); detail = data?.detail ?? data?.error ?? ''; } catch { /* non-JSON error body */ }
    const error = new Error(`Request failed (${response.status})`);
    error.status = response.status; error.detail = typeof detail === 'string' ? detail : '';
    throw error;
  }
  return response.json();
}

function applyStatus(status) {
  state.token = status.csrfToken ?? state.token;
  state.serverOk = true;
  if (status.agent && typeof status.agent === 'object') {
    state.agent = { available: status.agent.available === true, kind: status.agent.kind ?? null, detail: status.agent.detail ?? null };
  }
  if (!state.agentRun) $('agent-status').textContent = state.agent.available ? 'Ready' : 'Unavailable';
  render();
}

// ---- Terminal: retained PTY sessions with visible tabs ----
// "New session" opens an additional PTY and closes nothing; only the explicit
// Close action closes a session, and it closes just the selected one. Each
// session retains its own transcript buffer, output offset and command draft,
// so switching tabs reattaches exactly that session's state. Only the
// selected session is polled; switching bumps the poll token so a late poll
// or input result is never applied to a different terminal.

// Plain text PTY view: strip control sequences rather than execute terminal escape codes.
function plainTerminal(value) { return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''); }
const TERMINAL_NOTE = 'Real commands run on this development host. This terminal has no demonstrated Tor or isolation boundary. Ctrl+C interrupts; full-screen terminal apps are not supported.';
const REATTACH_NOTE = 'Reattached to this tab’s surviving shell after the reload; no new session was created. Switching tabs replays each session’s retained server transcript.';

function findSession(id) { return state.terminalSessions.find(session => session.id === id); }

function storeTerminals() {
  store.set('portable-terminals', JSON.stringify({
    list: state.terminalSessions.map(session => ({ id: session.id, label: session.label })),
    selected: state.selectedTerminal,
    initialized: true,
  }));
}
function loadTerminals() {
  const raw = store.get('portable-terminals');
  if (raw) {
    try {
      const saved = JSON.parse(raw);
      const list = Array.isArray(saved?.list)
        ? saved.list.filter(entry => entry && typeof entry.id === 'string' && typeof entry.label === 'string').map(entry => ({ id: entry.id, label: entry.label }))
        : [];
      return { list, selected: typeof saved?.selected === 'string' ? saved.selected : null, initialized: saved?.initialized === true || list.length > 0 };
    } catch { /* corrupted entry: fall through to a fresh start */ }
  }
  const legacy = store.get('portable-terminal');
  if (legacy) { store.remove('portable-terminal'); return { list: [{ id: legacy, label: '1' }], selected: legacy, initialized: true }; }
  return { list: [], selected: null, initialized: false };
}

function renderTerminalOutput(session) {
  $('terminal-output').textContent = session.buffer;
  $('terminal-output').scrollTop = $('terminal-output').scrollHeight;
}
function appendSessionOutput(session, text) {
  session.buffer = (session.buffer + plainTerminal(text)).slice(-100000);
  if (session.id === state.selectedTerminal) renderTerminalOutput(session);
}

function renderTerminalTabs() {
  $('terminal-tabs').replaceChildren(...state.terminalSessions.map(session => {
    const tab = document.createElement('button');
    tab.id = `terminal-session-${session.label}`;
    tab.className = 'terminal-session-tab';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(session.id === state.selectedTerminal));
    tab.setAttribute('aria-controls', 'terminal-output');
    tab.tabIndex = session.id === state.selectedTerminal ? 0 : -1;
    tab.textContent = `Shell ${session.label}${session.exited ? ' · exited' : ''}`;
    tab.addEventListener('click', () => selectTerminal(session.id));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const ids = state.terminalSessions.map(candidate => candidate.id);
      const index = ids.indexOf(session.id);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length;
      selectTerminal(ids[next]);
      $(`terminal-session-${state.terminalSessions[next].label}`).focus();
    });
    return tab;
  }));
}

function renderTerminalView() {
  renderTerminalTabs();
  const session = findSession(state.selectedTerminal);
  $('close-terminal').disabled = !session || state.terminalBusy;
  if (!session) {
    $('terminal-output').textContent = '';
    $('terminal-state').textContent = 'No terminal sessions';
    $('terminal-note').textContent = 'This tab has no open terminal. New session opens another PTY; sessions from other tabs are not adopted automatically.';
    $('command').value = '';
    $('command').disabled = true;
    return;
  }
  renderTerminalOutput(session);
  $('terminal-state').textContent = session.exited ? 'Shell exited' : session.disconnected ? 'Terminal disconnected' : 'Live local shell';
  $('terminal-note').textContent = session.note ?? TERMINAL_NOTE;
  $('command').value = session.draft ?? '';
  $('command').disabled = session.exited || session.disconnected;
}

async function pollSession(session) {
  const token = ++session.pollToken;
  while (!session.exited && !session.disconnected && session.pollToken === token && state.selectedTerminal === session.id) {
    try {
      const result = await api(`terminals/${encodeURIComponent(session.id)}/output?after=${session.offset}`);
      if (session.pollToken !== token) return; // a newer loop owns this session now
      session.offset = result.offset;
      if (result.truncated) session.note = 'Older terminal output was discarded by the server’s bounded buffer.';
      if (result.output) appendSessionOutput(session, result.output);
      if (result.exited) {
        session.exited = true;
        session.note = 'The shell process exited. This tab keeps its transcript; commands cannot be sent to it.';
        renderTerminalView();
        return;
      }
    } catch (error) {
      if (session.pollToken !== token) return;
      session.disconnected = true;
      session.note = `${error.message}. Polling stopped for this session; selecting its tab again retries once. Commands are never resent.`;
      renderTerminalView();
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 350));
  }
}

function selectTerminal(id) {
  const session = findSession(id);
  if (!session) return;
  state.selectedTerminal = id;
  storeTerminals();
  if (session.disconnected) { session.disconnected = false; session.note = TERMINAL_NOTE; } // explicit reselect retries once
  renderTerminalView();
  if (!session.exited) pollSession(session);
}

function addSession(id, note) {
  const used = state.terminalSessions.reduce((max, session) => Math.max(max, Number(session.label) || 0), 0);
  const session = { id, label: String(used + 1), buffer: '', offset: 0, exited: false, disconnected: false, pollToken: 0, draft: '', note };
  state.terminalSessions.push(session);
  selectTerminal(session.id);
  return session;
}

async function initTerminal() {
  try {
    const status = await api('status');
    applyStatus(status);
    if (!status.terminalAvailable) throw new Error('Terminal service is unavailable');
    const listing = await api('terminals');
    const alive = new Set((listing.sessions ?? []).filter(session => !session.exited).map(session => session.id));
    const saved = loadTerminals();
    const restored = saved.list.filter(entry => alive.has(entry.id)).map(entry => ({
      id: entry.id, label: entry.label, buffer: '', offset: 0, exited: false, disconnected: false, pollToken: 0, draft: '', note: REATTACH_NOTE,
    }));
    const dropped = saved.list.length - restored.length;
    if (restored.length) {
      state.terminalSessions = restored;
      if (dropped > 0) {
        const target = restored.find(session => session.id === saved.selected) ?? restored[restored.length - 1];
        target.note = `${REATTACH_NOTE} ${dropped} previously open session${dropped === 1 ? '' : 's'} no longer exist${dropped === 1 ? 's' : ''} on the server.`;
      }
      selectTerminal(restored.some(session => session.id === saved.selected) ? saved.selected : restored[restored.length - 1].id);
    } else if (saved.initialized) {
      // This tab opened terminals before and none survived (closed here, or
      // the server restarted): create nothing and adopt nothing.
      state.selectedTerminal = null;
      renderTerminalView();
      if (dropped > 0) $('terminal-note').textContent = `${dropped} previously open session${dropped === 1 ? '' : 's'} from this tab no longer exist${dropped === 1 ? 's' : ''} on the server.`;
    } else {
      const result = await api('terminals', 'POST', {});
      addSession(result.id, TERMINAL_NOTE);
    }
  } catch (error) {
    if (error instanceof TypeError) state.serverOk = false;
    render();
    state.selectedTerminal = null;
    renderTerminalTabs();
    $('terminal-output').textContent = `${error.message}\n`;
    $('terminal-state').textContent = 'Terminal unavailable';
    $('terminal-note').textContent = 'Start the local workspace server to use a real shell. This static preview does not simulate command execution.';
    $('command').disabled = true;
    $('close-terminal').disabled = true;
  }
}

async function newTerminal() {
  if (state.terminalBusy) return;
  state.terminalBusy = true;
  $('new-terminal').disabled = true;
  try {
    if (!state.token) applyStatus(await api('status'));
    const result = await api('terminals', 'POST', {});
    addSession(result.id, TERMINAL_NOTE); // adds a PTY; every existing session stays open
  } catch (error) {
    const reason = error.status === 409
      ? `Terminal capacity reached (${error.detail || 'too many sessions on this server'}). Close a session before opening another; open sessions keep running.`
      : `${error instanceof TypeError ? 'Workspace server unreachable' : error.message}. No session was created.`;
    const session = findSession(state.selectedTerminal);
    if (session) appendSessionOutput(session, `\n${reason}\n`);
    else { $('terminal-state').textContent = 'Terminal unavailable'; $('terminal-note').textContent = reason; }
  } finally {
    state.terminalBusy = false;
    $('new-terminal').disabled = false;
    $('close-terminal').disabled = !findSession(state.selectedTerminal);
  }
}

async function closeTerminal() {
  const session = findSession(state.selectedTerminal);
  if (!session || state.terminalBusy) return;
  state.terminalBusy = true;
  $('close-terminal').disabled = true;
  $('new-terminal').disabled = true;
  session.pollToken += 1; // stop this session's poll loop before closing it
  try {
    await api(`terminals/${encodeURIComponent(session.id)}`, 'DELETE');
  } catch (error) {
    if (error.status !== 404) {
      appendSessionOutput(session, `\n${error.message}. The session was not closed; it stays selected.`);
      state.terminalBusy = false;
      $('new-terminal').disabled = false;
      renderTerminalView();
      if (!session.exited && state.selectedTerminal === session.id) { session.disconnected = false; pollSession(session); }
      return;
    } // 404: the server no longer knows it; drop the tab
  }
  const index = state.terminalSessions.indexOf(session);
  state.terminalSessions.splice(index, 1);
  const next = state.terminalSessions[index] ?? state.terminalSessions[index - 1];
  state.terminalBusy = false;
  $('new-terminal').disabled = false;
  if (next) selectTerminal(next.id);
  else { state.selectedTerminal = null; storeTerminals(); renderTerminalView(); }
}

// ---- Wiring ----

function switchTool(view) {
  for (const name of ['terminal', 'file']) { const active = name === view; $(`${name}-tab`).setAttribute('aria-selected', String(active)); $(`${name}-tab`).tabIndex = active ? 0 : -1; $(`${name}-view`).hidden = !active; }
}
// Narrow screens (651–1100px) show one workspace pane at a time and the
// sidebar switches between them; wider screens keep the split view and
// narrower-than-651px screens keep the stacked single-column layout.
function setPane(pane) {
  document.body.dataset.pane = pane;
  $('agent-nav').classList.toggle('selected', pane === 'agent');
  $('terminal-nav').classList.toggle('selected', pane === 'tools');
}
$('credit').addEventListener('click', () => { const open = $('funding').hidden; $('funding').hidden = !open; $('credit').setAttribute('aria-expanded', String(open)); });
$('advance-payment').addEventListener('click', () => { state.payment = (state.payment + 1) % phases.length; if (state.payment === 4) { state.scenario = 'funded'; $('scenario').value = 'funded'; message('preview', 'Funding preview complete. Example provider credit is ready. No real funds moved.'); } render(); });
$('scenario').addEventListener('change', () => { state.scenario = $('scenario').value; if (state.scenario === 'unfunded') { state.payment = 0; $('funding').hidden = false; $('credit').setAttribute('aria-expanded', 'true'); } render(); });
$('preview-agent').addEventListener('click', runPreviewFixture);
$('example').addEventListener('click', () => { $('prompt').value = 'Run the scripted task: write agent-run.txt into the workspace.'; $('prompt').focus(); });
$('agent-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const prompt = $('prompt').value.trim();
  if (!prompt || state.running || state.runningPreview) return;
  message('user', prompt);
  await startAgent(prompt);
});
$('stop-agent').addEventListener('click', stopAgent);
$('prompt').addEventListener('input', () => store.set('portable-prompt', $('prompt').value));
$('prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('agent-form').requestSubmit(); } });
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPane('agent'); $('prompt').focus(); } });
$('agent-nav').addEventListener('click', () => { setPane('agent'); $('prompt').focus(); });
$('terminal-nav').addEventListener('click', () => { setPane('tools'); switchTool('terminal'); $('command').focus(); });
$('file-nav').addEventListener('click', () => { setPane('tools'); switchTool('file'); $('file-tab').focus(); });
for (const name of ['terminal', 'file']) {
  $(`${name}-tab`).addEventListener('click', () => switchTool(name));
  $(`${name}-tab`).addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'terminal' : event.key === 'End' ? 'file' : name === 'terminal' ? 'file' : 'terminal'; switchTool(next); $(`${next}-tab`).focus(); } });
}
$('new-terminal').addEventListener('click', newTerminal);
$('close-terminal').addEventListener('click', closeTerminal);
$('command').addEventListener('input', () => { const session = findSession(state.selectedTerminal); if (session) session.draft = $('command').value; });
$('terminal-form').addEventListener('submit', async event => {
  event.preventDefault();
  const session = findSession(state.selectedTerminal);
  const input = $('command').value;
  if (!session || session.exited || session.disconnected || !input.trim()) return;
  try {
    await api(`terminals/${encodeURIComponent(session.id)}/input`, 'POST', { input: `${input}\n` });
    // A late acknowledgement must not erase text typed since submission,
    // nor the selected input of another retained shell.
    if (session.draft === input) session.draft = '';
    if (state.selectedTerminal === session.id && $('command').value === input) $('command').value = '';
  } catch (error) { appendSessionOutput(session, `\n${error.message}. Input was not retried.\n`); }
});
$('command').addEventListener('keydown', async event => {
  if (!(event.ctrlKey && event.key.toLowerCase() === 'c')) return;
  const session = findSession(state.selectedTerminal); // Ctrl+C targets the selected session only
  if (!session || session.exited || session.disconnected) return;
  event.preventDefault();
  try { await api(`terminals/${encodeURIComponent(session.id)}/input`, 'POST', { input: '\x03' }); }
  catch (error) { appendSessionOutput(session, `\n${error.message}\n`); }
});
setPane('agent');

const savedDraft = store.get('portable-prompt');
if (savedDraft) $('prompt').value = savedDraft;
render();
initTerminal();
initAgentReattach();
