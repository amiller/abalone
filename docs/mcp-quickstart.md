# Using Abalone from Claude Code over MCP

This is the connected-session MCP interface, not the incognito gift entry.
Read [security profiles](security.md) before applying approval or sandbox claims.
Ordinary MCP outputs and approval state can contain plaintext; a same-user caller
with shell/file access can bypass that state's permissions.


You keep a private folder on this computer. Claude Code (the calling agent, ○ outside) works on your request but never reads the folder. It asks abalone's private agent, which reads the folder inside a sandbox with a ⌂ local or ◈ attested model. Nothing from the folder reaches Claude Code until you approve the exact text in your own terminal.

> **Precondition: launch Claude Code with `--tools ""` (step 3).** On a single-user machine an agent with a shell *is* you. With Bash, Claude Code can `cat` the folder, and it can write the approval file and approve its own pours. A second audit did exactly that, and the forged approval was logged as `user`. If the orchestrator must keep its shell, use the hardened mode at the end of this page.

## 1. Prepare the folder and the private model

```
REPO=/path/to/abalone
$REPO/bin/abalone canary init ~/private/folder     # plants ref-<id>.txt, records its values in ~/.abalone/canaries/
```

Keep the planted file. abalone refuses to start in a folder whose canary file is missing or changed, and in a folder with no canaries unless you pass `--no-canaries` (then the strip and the tool description say so).

Choose the private model, which reads the folder:
- ◈ attested: `--model nearai/z-ai/glm-5.3-flash`, after `$REPO/bin/abalone key add nearai` (paste a NEAR AI key). Attestation is verified before the first prompt byte; a failure refuses, with no fallback route.
- ⌂ local: `--model ollama/<model>` with ollama on 127.0.0.1:11434, or `llama.cpp/<model>` on 127.0.0.1:8080.

## 2. The MCP config

Save as `abalone-mcp.json` anywhere outside the folder:

```json
{ "mcpServers": { "abalone": {
    "command": "/path/to/abalone/bin/abalone-mcp",
    "args": ["--model", "nearai/z-ai/glm-5.3-flash"] } } }
```

The server runs in Claude Code's working directory, and that directory is the folder the private agent works in. The `ask_abalone` tool description names it, so the calling agent can confirm. Set `"env": {"ABALONE_DIR": "..."}` to keep abalone's state somewhere other than `~/.abalone`.

## 3. Launch Claude Code with only the abalone tools

```
cd ~/private/folder
claude --tools "" --strict-mcp-config --mcp-config /path/to/abalone-mcp.json \
  --allowedTools mcp__abalone__ask_abalone,mcp__abalone__pour_status
```

Why each flag:
- `--tools ""` removes Claude Code's built-in tools (Read, Grep, Bash, Edit, Write, WebFetch, ...). They run as you, outside any sandbox. With them, Claude Code could read the folder directly, and it could write `~/.abalone/approvals/` and approve its own pours. With `--tools ""`, its only tools are abalone's.
- `--strict-mcp-config` loads only this MCP config, so no other configured server (a filesystem server, a browser) is available to it.
- `--allowedTools` lets the two abalone tools run without a permission prompt. Approval happens in step 4, not here.

Add `-p "<task>"` for a one-shot run, or leave it off to talk to it.

## 4. Approve in your own terminal

In a second terminal:

```
/path/to/abalone/bin/abalone approvals
```

It waits for pours. For each one it shows the destination (mcp-caller ○ outside), what the caller asked, the policy, the gate's verdict, residual sensitivity (what code checked, the policy wording that only the model was told, numbers and capitalized words in the text) and the exact payload. Then you choose:

- `a` approve once: Claude Code's `pour_status` returns this exact text.
- `e` edit: opens `$EDITOR` on the text, then shows it again. The edited text is gated again (canaries, schema, size).
- `d` deny: Claude Code gets "denied by the user" and nothing else.
- `s` skip: decide later.

`abalone approvals` refuses to run without a terminal (stdin and stdout a TTY), so a shell tool cannot drive it.

Meanwhile Claude Code sees `{"status": "pending", "id": ...}` from `ask_abalone` and calls `pour_status(id, wait_seconds)`, which returns when you decide or after `wait_seconds` (default 60, at most 300) with `pending`.

## Standing policies

A standing policy means **pre-approved**: an answer under it goes to Claude Code without asking you, up to the policy's `max_bytes` and the session budget. None ship. To make one:

```
abalone approvals --standing                               # list
abalone approvals --standing add mcp-caller metadata_only  # asks you to type the policy id back
abalone approvals --standing rm mcp-caller metadata_only
```

Code still blocks canaries, control characters and schema violations under a standing policy. It does not check the policy's wording. `metadata_only` is the narrowest. The gate accepts only its JSON schema: paths and column names are identifiers with no digits, and types, units, level counts, year ranges and rounded row counts come from fixed lists or bounded ranges. Digits cannot pass, but the names are still a letters-only free-text channel: about 1,000 letters per pour, within the caps, for words like `marisol_pike`.

## Hardened mode: when the orchestrator keeps its shell

```
/path/to/abalone/bin/abalone setup --separate-user /srv/abalone/folder --model nearai/z-ai/glm-5.3-flash
```

This prints one-time root commands. abalone does not run them. Read them, then run them yourself. They create an `abalone` user that owns the folder, the approvals store and a systemd-run abalone-mcp listening on `/run/abalone/mcp.sock`. Your agent connects with `{"command": "/path/to/abalone/bin/abalone-connect", "args": ["/run/abalone/mcp.sock"]}`, and you approve with the printed `sudo -u abalone … abalone approvals`. The folder must be outside your home directory, which other users cannot traverse. Design and limits: [threat-model.md](security.md#profiles-and-their-boundaries).

## What is logged

`~/.abalone/disclosures.jsonl` has one line per pour: `pending` (hash only), `released` (the text, with approval `standing`, `user` or `user-edited`) or `refused` (hash only, and the reason; the caller saw only "refused"). The private agent's full output for each call is in `~/.abalone/private-out/`, unencrypted (mode 0600). See [threat-model.md](threat-model.md).
