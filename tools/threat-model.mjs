// Writes local-data/capabilities.md from `abalone caps` (lib/caps.mjs document()) on the shipped config, with an empty
// ABALONE_DIR so no local key or standing policy shows. The enforcement-point table and glossary are kept here.
// Run: node tools/threat-model.mjs   (diagnostic output; not a deployment security qualification)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abalone-tm-"));
process.env.ABALONE_DIR = tmp;
delete process.env.ABALONE_CONFIG;
const { ROOT } = await import("../lib/config.mjs");
const { document } = await import("../lib/caps.mjs");
const doc = document("/FOLDER");
fs.rmSync(tmp, { recursive: true });
const clean = (s) => String(s).replaceAll(tmp, "$ABALONE_DIR").replaceAll(ROOT, "$REPO").replaceAll("/FOLDER", "$FOLDER");

const POINTS = [
  ["Disclosure gate: every release (ask_frontier pours, session pours, ask_abalone answers)", "bytes ≤ max_bytes, session budget, no control/bidi characters, no canary, metadata_only JSON schema, answerer listed, standing or human approval", "lib/gate.mjs `checkPour`"],
  ["Human approval of ask_abalone answers", "outside standing, an answer waits as pending; only `abalone approvals` (stdin and stdout a TTY) writes the decision; the approved text is gated again", "bin/abalone-mcp.mjs `askAbalone`, `pourStatus`; lib/approvals.mjs"],
  ["Standing policies", "none ship; only `abalone approvals --standing add` writes them, after the policy id is typed back", "lib/config.mjs `standing`; lib/approvals.mjs `standingCmd`"],
  ["Interactive pour prompt", "exact payload, destination, residual sensitivity; continue privately is the default", "lib/mediate.mjs, lib/disclose.mjs, curated/abalone.ts `ask_frontier`"],
  ["Private sandbox (the harness and its model)", "bwrap, own network namespace with loopback only; sees /usr, CA certs, passwd/group, node, the repo, $ABALONE_DIR (approvals/ read-only), its run dir and the folder; runner login dirs are empty tmpfs", "lib/sandbox.mjs `piArgv`; bin/abalone.mjs `session`"],
  ["Pi tool capability check", "read/grep/find/ls only under the folder, private-out and skills; edit/write only under the folder and private-out; paths resolved as Pi resolves them", "lib/caps.mjs `missing`; curated/abalone.ts `tool_call` hook"],
  ["bash tool", "nested bwrap with no network, $ABALONE_DIR, runner logins and run dir hidden, clean environment", "lib/sandbox.mjs `bashArgv`"],
  ["Network egress", "only providers.json admitted hosts (TLS end to end through per-host unix sockets) and ⌂ local loopback ports; every connection logged to egress.jsonl", "lib/egress.mjs; curated/egress-preload.mjs"],
  ["Upstream admission behind an ACI aggregator (RedPill, Phala)", "at launch, a model is offered only if every session the gateway lists for it is an admitted upstream (providers.json upstreams.admit: Phala, NEAR) with TEE, TCB and GPU asserted; Chutes and Tinfoil are refused (issue 0007)", "lib/upstream.mjs; bin/abalone.mjs `session`"],
  ["Attestation before the first prompt byte", "ACI gate (TDX quote, compose, SPKI pin) and NEAR (gateway and model quotes, nonce, NRAS, SPKI pin); failure refuses, no fallback route", "aci/; curated/near-provider.ts; lib/near.mjs `checkReport`"],
  ["Outside runner (runner:claude)", "launched by the launcher, outside the private sandbox; sees only the pour, its own login, and a CONNECT proxy to the vendor's hosts", "lib/runner.mjs; lib/sandbox.mjs `runnerArgv`"],
  ["Lockdown", "only curated/manifest.json entries with matching sha256 load; ambient extensions, skills, context files and prompt flags refused", "lib/manifest.mjs; bin/abalone.mjs `REFUSED`"],
  ["Folder canaries", "a session and abalone-mcp refuse to start without them unless --no-canaries (shown in the strip and the tool description); the gate blocks their values", "lib/canary.mjs; lib/gate.mjs `canaries`"],
  ["File modes", "everything under $ABALONE_DIR is 0600 files, 0700 dirs", "lib/config.mjs `umask`"],
];
const NON = [
  "**Policy wording is not enforced by code.** \"Forbids names, IDs, amounts\" is an instruction to the private model. Code checks only the list under Enforced by code. A model that ignores its policy is caught only by a canary, the metadata_only schema, or the human reading the payload.",
  "**PRECONDITION. A same-user process can approve.** `abalone approvals` refuses without a TTY, so a shell tool cannot drive it, but any process running as this user can write `$ABALONE_DIR/approvals/` directly. On a single-user machine an agent with a shell *is* the user. The human-approval property holds only when the calling agent has no shell or file tools (`claude --tools \"\"`, see docs/mcp-quickstart.md), or in the hardened mode below.",
  "**Plaintext at rest.** `private-out/`, `agent/sessions/`, `approvals/pending/` and `disclosures.jsonl` hold private text unencrypted, protected only by file modes (0600/0700) and disk encryption if you have it.",
  "**An approved pour reveals what it says.** Approval is the human's judgment of the exact text. Paraphrase, aggregation and the union of several pours can still identify people.",
  "**Side channels.** Byte counts, timing and the number of pours are visible to whoever receives them.",
  "**An aggregator can add a route mid-session.** Upstream admission is checked when abalone starts. If RedPill routes an admitted model to a new, non-admitted upstream during a session, the prompt goes there; it shows only in that response's receipt (issue 0007).",
  "**Canaries are a plumbing check.** They catch verbatim, base64 and hex copies of planted values, not paraphrase or other encodings.",
  "**metadata_only is a letters-only free-text channel.** Paths and column names are identifiers without digits; every other field is a bounded number or a word from a fixed list. Within the caps that still leaves about 1,000 letters per pour (2,000 bytes) and 6,000 bytes per session for words a model chooses (`marisol_pike`, `diagnosis_hiv`), plus a few bits in counts and year ranges. Digits cannot pass, so IDs, amounts and dates cannot pass as digits; spelled out in letters, they can.",
  "**Before approval the caller still learns one bit per call:** pending versus refused, and the timing. It gets no byte count and no error text.",
  "**A forged approval looks like a real one.** A same-user process that writes approvals/pending/<id>.decision.json is logged as approval user.",
  "**TEE operators.** Attestation shows what code runs; the operator axis in the observer table says who could still look.",
];
const GLOSSARY = [
  ["pour", "private text released to an outside party (○): an ask_frontier payload, a session pour to an outside model, or an ask_abalone answer. Every pour goes through the gate and is logged in disclosures.jsonl."],
  ["gate", "lib/gate.mjs `checkPour`, the one deterministic check every pour passes. Verdicts: go (standing), ask (needs the human), block."],
  ["standing", "a policy the human pre-approved for one answerer with `abalone approvals --standing`. A pour under it leaves without asking. None ship."],
  ["pending", "an ask_abalone answer outside standing, waiting in approvals/pending/ for the human."],
  ["released", "the disclosures.jsonl label of a pour that left, with its approval: standing, user, user-edited (or user-once in the session)."],
  ["⌂ local", "runs on this computer (a loopback model server, the bash sandbox)."],
  ["◈ attested", "a remote provider whose TEE attestation passed before the first prompt byte."],
  ["○ outside", "anything else: frontier vendors, the MCP caller. Text from ○ is labelled open and never widens a later pour."],
  ["runner", "a frontier CLI (claude -p) run on one pour in its own sandbox, with its own login in runner-home/."],
  ["canary", "a random value planted in the folder by `abalone canary init` and recorded outside it; the gate blocks any pour holding one."],
  ["answerer", "who a pour goes to: claude (runner), nearai-outside, mcp-caller (policy.json answerers)."],
];

const cell = (s) => clean(s).replaceAll("|", "\\|");
const out = `# Ordinary-session capability snapshot

Generated by \`node tools/threat-model.mjs\` from \`abalone caps\` on the shipped config (contract ${doc.contract}). Diagnostic output only; see docs/security.md for the selected profile.
This ordinary-session snapshot does not describe the owned-host friend boundary.

**Claim:** ${doc.claim}. Through abalone-mcp: the only text derived from the folder that reaches the calling agent is an ask_abalone answer that passed the gate and that the human approved in \`abalone approvals\`, or that fell under a standing policy the human created. None ship.

**Precondition:** the caller has no shell or file tools (\`claude --tools ""\`), or abalone runs as a separate user (hardened mode, below). On a single-user machine an agent with a shell *is* the user, so it can read the folder and approve its own pours.

## Guarantees as booleans (from caps)

${Object.entries(doc).filter(([, v]) => typeof v === "boolean").map(([k, v]) => `- \`${k}\`: ${v}`).join("\n")}

## Enforced by code on every release

${doc.enforced_by_code.map((l) => `- ${l}`).join("\n")}

## Enforcement points

| Point | What it enforces | Where |
|---|---|---|
${POINTS.map((p) => `| ${p.map(cell).join(" | ")} |`).join("\n")}

## Non-guarantees

${NON.map((l) => `- ${l}`).join("\n")}

Limitations as caps lists them:

${doc.limitations.map((l) => `- ${clean(l)}`).join("\n")}

## Hardened mode: abalone as a separate user

\`abalone setup --separate-user <folder> --model <id>\` prints one-time root commands; abalone never runs them. After them:

- A system user \`abalone\` owns the folder (\`chmod go-rwx\`), its state (\`/var/lib/abalone/.abalone\`: approvals, private-out, sessions, canary records, configured provider keys) and the running abalone-mcp (a systemd unit, \`User=abalone\`). The code is a root-owned copy in \`/opt/abalone\`.
- The caller reaches abalone only through \`/run/abalone/mcp.sock\`, with \`bin/abalone-connect\` as its MCP command. Modes are set explicitly: the unit has \`UMask=0077\`, \`/run/abalone\` is 0750 abalone:abalone-callers (callers can traverse it and see the names of the run dirs inside), the socket is chmod 0660 after listen (owner abalone, group abalone-callers, the service's group), each session's run dir with its egress and control sockets is 0700 (mkdtemp), and \`ExecStartPre\` creates the state and approvals directories 0700 abalone:abalone. Approvals are files in that 0700 directory; there is no approvals socket. The printed commands end with \`stat\` lines that show the expected modes.
- The human approves with \`sudo -u abalone … abalone approvals\`. sudo asks for the password and keeps its ticket per terminal, so the caller's shell, which has no terminal, cannot reuse it. Never add a NOPASSWD rule for this.

What changes: a caller with a full shell, running as the human's user, can no longer read the folder, read private-out, or write a decision. Unix permissions now enforce this, and the caller's tool settings no longer matter. The socket is its only interface. What stays: root, and anything that can get the human's password, can still do all of it. The human loses direct access to the folder and reads it through sudo. Byte counts, timing and the pending-or-refused bit remain side channels. Tested: the socket transport as one user (\`tests/mcp-socket.sh\`). Not tested: the separate user itself, which needs root.

## Capabilities (folder = \`$FOLDER\`)

| Holder | Action | Object | Granted by |
|---|---|---|---|
${doc.capabilities.map((c) => `| ${[c.holder, c.action, c.object, c.granted_by].map(cell).join(" | ")} |`).join("\n")}

## Observers

| Observer | Sees | Mechanism |
|---|---|---|
${doc.observers.map((o) => `| ${[o.observer, o.sees, o.mechanism].map(cell).join(" | ")} |`).join("\n")}

## Glossary

${GLOSSARY.map(([t, d]) => `- **${t}**: ${d}`).join("\n")}
`;
fs.mkdirSync(path.join(ROOT, "local-data"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "local-data/capabilities.md"), out);
console.log("wrote local-data/capabilities.md");
