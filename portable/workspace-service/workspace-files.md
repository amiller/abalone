# Read-only workspace files

The UI service proxies GET `/api/files?path=` (one directory) and
`/api/file?path=relative/file` through authenticated `files.list` and `files.read`
IPC. Only the agent service opens workspace files. The constructor supplies its
fixed workspace; callers can supply only a relative UTF-8 path, never a UID,
root, descriptor, policy, or environment. No financial authority is added.
Direct development mode returns unavailable instead of reading files as UI UID.

The service pins its workspace directory descriptor on startup. Each operation
passes that descriptor to a short-lived `/usr/bin/python3 -I` helper with a
minimal environment. Components open relative to directory descriptors with
O_NOFOLLOW, directories require O_DIRECTORY, and final reads require a regular
single-link file. Symlinks, traversal and special files are refused. Replacement
of the configured root pathname does not replace the pinned capability. A
renamed already-open directory remains that original directory capability; this
is not a mount namespace or a confinement boundary against the owning agent UID.
Kernel permissions continue to exclude financial UID972 state.

Limits: four active helpers across all clients, three-second operation deadline
then SIGKILL and a one-second reap wait (cleanup failure retains the root FD), 2KiB paths, 32 components, 200 returned directory entries,
128KiB UTF-8 text, and an 800KB aggregate child output cap. Truncated listing is
explicit, not pagination. File metadata is checked before and after reading;
concurrent writes may be refused. This is a read-only snapshot, not an atomic
filesystem snapshot. Refresh reloads the selected file and directory. The UI
renders all names and content as text. Unsupported names and files cannot be
opened. There is no edit, upload, download, recursive search, or symlink following.

Tests cover actual directory replacement, repeated directory/symlink swaps,
FIFO/hardlink/binary/size refusal, strict IPC fields, and real HTTP-to-service
file access while the SDK is unavailable. Separate private qualification uses
actual namespace UIDs970/971/972/974 with synthetic financial bytes only.
Actual service-mode browser evidence covers empty/list/read/oversize/navigation
and unavailable states; no provider or account access is involved.

Run the local protocol, file, and cleanup checks without an SDK build:

```sh
node --experimental-test-module-mocks --test \
  portable/workspace-service/tests/service-protocol.test.mjs \
  portable/workspace-service/workspace-files.test.mjs \
  portable/workspace-service/cleanup-failure.test.mjs
```

Module mocking is used only to exercise cleanup failures in the test process;
the production service has no replacement-manager option. These same-UID tests
do not establish the separate-account permission boundary or ARM packaging.
