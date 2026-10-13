# Task runner interface

This is the runner integration contract consumed by `lib/macrunner.mjs` and the
[task protocol](task-v1.md). Actual runner deployment is qualified separately.

Contract: `docs/protocols/task-v1.md`. The peer VM (abalone peer compose) commissions tasks; each task runs in its own
Containerization VM booted by the same signed Runner.app, alongside the peer VM. Everything below is on the peer VM's
existing `/run/egress.sock`, host `runner.local`. Only the peer VM's compose may call it (a compose flag
`"tasks": {"images": [...], "max_concurrent": 2}`, below).

## 1. Admitted task images

The peer compose lists the task images it may start, digest-pinned:
`"tasks": {"images": ["abalone-task@sha256:<digest>"], "max_concurrent": 2, "resources": {...}}`. They are admitted
by being in the admitted peer compose, so the peer's compose hash covers them. `/task/start` refuses any other image.
The first image is the standard Abalone/Pi image: node 22, git, `/bin/sh`, the abalone tree at `/abalone` with `vendor/pi/`
built (`vendor/pi/packages/coding-agent/dist/cli.js` and its `node_modules`), and the entrypoint
`node /abalone/bin/task-guest.mjs`. No provider keys, no extra packages. The entrypoint reads `/in` (read-only), works
on a copy in `/work` (writable rootfs), keeps Pi's state in `/task-state`, and writes `patch.diff`, `test.log`,
`files/…` and `finish.json` to `/out` before it exits. Its stdin/stdout protocol is in its header comment; it waits
for the peer's `init` frame on stdin, so the runner must buffer until the first attach.

## 2. Resource menu

The defined resource menu has one entry. The runner enforces it; the peer only names it.

| id | vCPUs | memory | `/out` volume | wall-time cap |
|---|---|---|---|---|
| `small` | 2 | 2 GiB | 1 GiB | 1800 s |

## 3. The per-task compose

The peer builds it and the runner checks it against the template before booting:

```
{ "manifest_version": 2, "name": "abalone-task-<task_id>", "runner": "docker-compose", "kms_enabled": false,
  "docker_compose_file": "{\"services\":{\"task\":{\"image\":\"abalone-task@sha256:…\",\"command\":[\"node\",\"/abalone/bin/task-guest.mjs\"],
     \"labels\":{\"abalone.task_id\":\"…\",\"abalone.auth_hash\":\"…\",\"abalone.inputs_root\":\"…\"}}}}",
  "egress": { "max_requests": 0, "max_tokens": 0, "allow": [], "tcp": [] },
  "task": { "resource": "small" } }
```

Refuse unless: the image is in the peer compose's `tasks.images`; `egress` is empty (no task network; inference
goes over the attach stream to the peer, §5); no volumes or binds besides the two the runner makes; `resource` is
in the menu. The labels make the task VM's own `compose_hash` commit to the task ID, authorization and inputs.

## 4. API

| call | body / query | answer |
|---|---|---|
| `POST /task/start` | `{task_id, compose: <object above>, inputs_tar_b64}` (body ≤ 28 MiB; every other route ≤ 1 MiB) | `{task_id, compose_hash, state: "booting"}`. Unpacks the tar into a fresh read-only volume at `/in`; makes an empty write volume at `/out`. Same `task_id` and same compose again: the same answer, no second VM. Same `task_id`, different compose: 409. |
| `GET /task/status?id=` | | `{state: booting\|running\|exited\|stopped\|failed, started_at, wall_seconds, exit_code, reason}` |
| `CONNECT task-<task_id>.runner.local:1` | | 200, then a raw byte stream to the entrypoint's stdin/stdout (NDJSON both ways). One connection at a time; a second gets 409. Closing it does not stop the task; a new CONNECT resumes. Bytes written while no connection is open are buffered up to 4 MiB and then dropped from the oldest, with the drop count reported in `status`. |
| `POST /task/stop` | `{task_id, grace_seconds}` | SIGTERM to the entrypoint, VM stop after the grace. Idempotent. |
| `GET /task/collect?id=` | | after exit or stop: one deterministic tar (sorted, mtime/uid/gid zeroed): `guest/` entries (`app-compose.json`, `clientData.bin`, `attest.json` with the task boot evidence in domain `mac-compose-task-boot/1`, `receipts.jsonl`), then the `/out` volume's entries under `out/`, read host-side from its ext4 image after exit. The exit receipt's `out_sha256` hashes the `/out` tar alone, which is this tar's suffix from the first `out/` header; the peer keeps that suffix verbatim as `guest/out.tar`. The same bytes on every call. |
| `POST /task/delete` | `{task_id}` | removes volumes and run dir. |

Wall-time cap reached: stop as above, `status.reason = "time_cap"`. `status.wall_seconds` is the execution meter the
peer charges against (task-v1 Usage `execution.seconds`); the peer polls it every 15 s.

## 5. Receipts for the task VM

Task VMs are not separately App Attested. The task VM has its own receipt key in its boot clientData
(`mac-compose-boot/1`, its own `compose_hash` and `receipt_pub`), and the runner binds that clientData with a runner App
Attest assertion over sha256(clientData), in the `/attest` evidence shape; that evidence is `guest/attest.json`. The
chain is Apple root → runner CDHash → task compose_hash → task receipts. `kms_enabled: false`: no `/key`, no parcel. The runner additionally appends receipts (same chain, same
`mac-compose-receipt/1` domain, extra field `event`) for: `task-start` (`compose_hash`, `inputs_sha256` of the tar),
`attach`/`detach`, `exit` (`exit_code`, `wall_seconds`, `out_sha256` = sha256 of the `out/` tar). The runner receipt verifier must accept those bodies; `lib/bundle.mjs` checks `out_sha256` against the collected outputs.

The task VM has no NIC and no egress rule, so it produces no provider receipts. Inference: the entrypoint multiplexes
model requests over the attach stream to the peer, which forwards them through its own existing NEAR rule and charges
the task. Those exchanges appear in the peer VM's receipts.

## Scope exclusions

No persistent task volumes, no snapshots, no GPU, no network egress for tasks, no image builder.
