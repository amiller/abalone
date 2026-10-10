# Contract: the strict-incognito trace store (`abalone-trace/2`)

Owner: Track A (`agent/incognito`). Status: pinned 2026-10-08; revised the same night after review (v1 → v2: maintained formats, a passphrase-protected key, a launcher-side writer, high-water marks). Code: `lib/trace.mjs`, `bin/abalone.mjs` (`session`, `traceCmd`). Other tracks and the UI/runtime-facts integrator may rely on everything below; a change bumps the version string.

## Entry and mode

`abalone --incognito <folder>` starts a strict-incognito session in `<folder>`. Nothing else turns the mode on: the launcher deletes any inherited `ABALONE_INCOGNITO` and sets it itself. The session refuses to start without a trace key (`abalone trace key init`), refuses `--resume`/`--continue`/`--session`, and refuses a `--model` whose provider is not ⌂ local or ◈ admitted.

Inside the mode:

- **Inference**: only `providers.json` `local` (⌂, loopback) and `admitted` (◈, attested before the first prompt byte) providers. The `runner` and `nearai-outside` providers are not registered, `ask_frontier` is not registered, and the gift peer is not connected. A turn on any other model is refused at input and again before the request is built.
- **Network**: the existing egress allows admitted TEE hosts, their verifier hosts and loopback model ports, with no runner CONNECT hosts. There is no `/fetch`, no Tor and no public shell. Bash has no network.
- **Browser**: the launcher's browser bridge refuses `tabs` and `grant` (`/browser grant`), and the capability table has no `browse` row. A page is a destination outside ⌂/◈, and the page's content would carry the session's context there.
- **Launcher control socket**: only `trace-append` and `trace-context`. `folder`, `fetch`, `runner`, `redeem`, `gift` and `report` are refused.
- **Harness state**: the Pi sandbox sees `$ABALONE_DIR` as an empty tmpfs. Only `canaries/` and `approvals/` are bound in, read-only. Pi runs with `--no-session`, and its agent dir (settings, crash log, debug log) is `$run/agent` in the per-user runtime dir, removed at exit. Every harness write inside the sandbox stays in memory and vanishes at exit: notebook, `agents.jsonl`, `folders.json`, evidence cache, extraction scratch. The launcher (outside the sandbox) appends `egress.jsonl` (host names only) and the trace high-water mark (below).

## Files

```
<folder>/.abalone/traces/<YYYYMMDDTHHMMSSZ>-<id>.trace     the encrypted trace, one per session, append-only
$ABALONE_DIR/keys/trace-<kid>.age                          age identity, encrypted under the user's passphrase (age scrypt)
$ABALONE_DIR/keys/trace-<kid>.pub                          its age recipient (age1…), all a writer needs
$ABALONE_DIR/keys/trace-active                             the kid new traces are encrypted to
$ABALONE_DIR/trace-hwm/<id>.json                           high-water mark {id, file, frames, last, closed}
```

`$ABALONE_DIR` defaults to `~/.abalone`. Neither key file is under the folder, so copying the folder does not copy them. Every sandbox hides `$ABALONE_DIR/keys`: Pi gets a tmpfs over it in every mode, and bash gets a tmpfs over all of `$ABALONE_DIR`.

**The writer is the launcher, outside the sandbox.** Pi's extension sends each new session entry over the launcher's control socket (`trace-append`, a unix socket in the run dir, which bash cannot see). The launcher encrypts the entry and appends it. The stream key exists only in the launcher's memory, and each session draws a fresh one. No code path reopens an existing trace for writing, so a resumed or continued session (`--with-trace`) always starts a new trace under a new key. The sandbox never holds a key that decrypts any trace, its own included. The launcher writes the final frame after Pi exits, whatever the exit code, so a Pi crash still closes the trace. Only a launcher killed without a chance to run (SIGKILL, power loss) leaves it unclosed.

Model tools treat `<folder>/.abalone/` as outside the workspace: the folder listing omits it, in-content `list`/`read`/`grep`/`write` and `@` mentions refuse or skip it, native `read`/`write`/`edit` lack the capability for it, and bash sees it read-only.

## Format

A trace is UTF-8 lines, each ending in `\n`.

Line 0, the header, plaintext JSON: `{"v":"abalone-trace/2","id":"<16 hex>","kid":"<16 hex>","key":"<b64 age file>","ss":"<b64 secretstream header>"}`.

- `key` is an age v1 file (X25519 recipient stanza, the `age-encryption` package 0.3.1, Filippo Valsorda's TypeScript implementation) whose payload is the 32-byte secretstream key. `age -d -i <identity>` decrypts it.
- `kid` is the first 8 bytes of SHA-256 over the recipient string, in hex.
- Every later line is one frame: base64 of `crypto_secretstream_xchacha20poly1305_push(state, record, ad = SHA-256(header line), tag)` (libsodium, via `libsodium-wrappers` 0.8.4). The tag is `MESSAGE` for records and `FINAL` for the close record. libsodium manages the nonces and the stream state.

Record plaintext is JSON: first `{"t":"start", mode, folder, model, at, reopened}`, then `{"t":"entry", e: <Pi session entry>}` for every session entry in order (messages, in-content tool results, attestation records), and last `{"t":"close", at, entries, reason}` with the FINAL tag.

`open` refuses, and prints nothing, when:

- the header names a different id from the file name;
- the passphrase is wrong, or the key for `kid` is absent;
- the age header does not unwrap;
- any frame fails authentication, including a reordered, edited or swapped frame (the AD binds every frame to its header);
- a frame follows the FINAL one;
- the trace has fewer frames than this computer's high-water mark;
- the trace has as many frames as the mark but a different last frame.

A trace with no FINAL frame is printed with an explicit NOT CLOSED line.

What this gives: confidentiality and integrity of every record, their order, binding to the header, a distinguishable clean close, and, on the computer that wrote it, detection of truncation and rollback. What it does not give: without the high-water mark (another computer, or a deleted `$ABALONE_DIR`), a cut at a frame boundary looks like an interrupted session. Deleting both the trace and its mark is not detectable. File size, frame count and timing are visible without the key.

**Why these packages.** Review asked for maintained formats over a hand-composed STREAM. Secretstream gives append-only framing with libsodium's own nonce handling and FINAL tag. age gives a standard recipient format, so the identity also works with the `age` CLI and age plugins. Together the two packages are about 1.9 MB unpacked, and they sit in the root `package.json`. The launcher uses them outside the sandbox only.

## Key custody and recovery

The private key is an age identity, stored only encrypted under a passphrase the user chooses (`abalone trace key init`; age scrypt, work factor 2^18, about 2 s on this laptop). A session needs only the recipient, so starting incognito never asks for the passphrase. The passphrase is asked for only by `trace open`, `--with-trace` and `trace key export`, on the terminal, hidden. For automation, `ABALONE_PASSPHRASE_FD=<n>` reads it from that file descriptor instead; it is never read from an environment variable.

Recovery: `abalone trace key export` prints the `AGE-SECRET-KEY-1…` identity for a password manager. `abalone trace key import` reads it on stdin and stores it under a new passphrase, for example in a fresh `$ABALONE_DIR` on another computer. There is no escrow. Lose the identity or its passphrase and the traces are gone. Deleting `$ABALONE_DIR/keys/trace-<kid>.age` on purpose destroys every trace encrypted to that key at once, including copies of the folder held elsewhere, provided no exported copy of the identity survives.

## CLI

```
abalone trace key init | export | import           create (passphrase) / print identity / store an identity
abalone --incognito <folder>                       strict-incognito session; on exit prints what remains and how to reopen
abalone --incognito <folder> --with-trace <id>     new incognito session (new trace, new key) that starts with that trace's conversation in context
abalone trace list <folder>                        traces, sizes, record counts, closed or not; no key needed
abalone trace open <folder> <id>                   unlock and print to this terminal; adds nothing to any session
abalone trace delete <folder> <id>|--all           leave no trace: delete trace files and their high-water marks
```

Errors propagate with no fallback.

## Close, reopen, delete

On exit, the launcher writes the FINAL frame and then prints:

- the trace path, its record count and the kid;
- where the key is, and that copying the folder does not copy it;
- that files written in the folder are unencrypted;
- the host names this session connected to, from `egress.jsonl`;
- that Pi's session, logs and scratch were in memory only;
- the open, continue and delete commands.

The launcher decrypts nothing at close.

Reopening is always a separate, explicit command that asks for the passphrase. `trace open` prints to the terminal and adds nothing to any session. `--with-trace` works only together with `--incognito`. The launcher decrypts before Pi starts and keeps the transcript in its own memory. The extension fetches it once over the control socket (`trace-context`) and shows it as a message, so the user sees what was added. It goes to the session's ⌂/◈ model with the next prompt and is recorded in the new session's own trace. Nothing indexes traces: the notebook never reads `.abalone/`, and in incognito the notebook is not written.

`trace delete` removes trace files from `<folder>/.abalone/traces/` and their high-water marks. It does not reach:

- copies made elsewhere (backups, a copied folder, sync);
- blocks that an SSD or copy-on-write filesystem keeps;
- what the TEE provider processed during the session;
- files the agent wrote in the folder;
- the host names in `egress.jsonl`.

Deleting the key, as above, is the stronger option.

## Runtime facts (for `session_info`, `/privacy` and the strip)

The launcher writes `$run/session.json` (0400, path in `ABALONE_SESSION_DESCRIPTOR`; this is the candidate branch's descriptor name):

```
{ version: 1, mode: "strict-incognito", workspace, inference, network: { shell: "none", public_web: false, egress },
  retention: { kind: "encrypted-trace", format: "abalone-trace/2", trace: <path>, key_id: <kid>, key_file: <path>,
               encrypted: true, session_can_read_back: false, other_harness_writes: "tmpfs (memory), gone at exit", reopened: <id>|null } }
```

`/privacy`, the system prompt and `abalone caps` (`mode`, `claim`, `encrypted_at_rest`, limitations) read the mode from the launcher's environment and descriptor, never from a model claim.

## Stated limits

- **Trusted host.** Root, and any process running as this user, can read the live session's memory and the launcher's stream key, and can copy the encrypted identity file and try passphrases offline (scrypt slows guessing; a weak passphrase is still weak). tmpfs can swap to disk unless swap is encrypted.
- **Terminal.** Whatever the session shows is in the terminal's scrollback, and in its logs if the terminal keeps any. `trace open` prints plaintext there too.
- **Folder files.** Files the agent or the user writes in the folder are ordinary plaintext. Only the trace is encrypted.
- **Provider.** The admitted TEE provider processes the conversation. Attestation says what code runs there; it does not stop the operator observing metadata (timing, sizes, account).
- **External copies.** Anything copied out of the session (clipboard, screenshots, retyping) is outside the claim.
