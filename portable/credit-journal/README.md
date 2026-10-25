# Portable payment recovery journal

This prototype records one active funding instruction and its progress across
process restarts. It performs no network requests, creates no addresses and
does not send funds. Amounts are integer base-unit strings. Adapters must verify
provider and chain evidence before advancing a state; journal entries alone
are not proof of payment or spendable credit.

`begin()` resumes an identical instruction idempotently and refuses a second
instruction while payment remains unresolved. `advance()` requires ordered
progress and rejects conflicting event reuse. Expiry does not automatically
cancel a payment: adapters must reconcile late deposits and refund obligations
before recording cancellation. A stale writer lock requires operator recovery;
it is never removed merely because time passed.

Writes are serialized by a kernel `flock` on the persistent `payment.flock` inode,
held for the whole read-modify-rename-fsync mutation, with atomic rename and
file/directory fsync on Linux; the containing filesystem must provide these
semantics. The lock helper is stdlib `python3` (`fcntl`): it locks the inherited
descriptor without blocking, then sleeps on a pipe. Lock lifetime equals writer
lifetime — if a writer dies, even by SIGKILL, the kernel closes the pipe, the
helper exits on EOF and the flock is released, so the next writer resumes from
the last committed, validated snapshot. No npm dependencies are involved, and
an orphaned helper cannot retain the lock: it exits as soon as its stdin pipe
reaches EOF. A competing live writer is refused immediately (non-blocking),
never queued. Reads open the journal `O_NONBLOCK` so a substituted FIFO is
refused by `fstat` instead of hanging the service, and journal size is capped
at 1MiB before parsing. Every mutation is held to the same contract on the
write side: the callback must return a synchronous boolean (promises,
thenables and any other return value are refused without writing), and the
complete updated snapshot is serialized, revalidated against the event
history and size-checked against the 1MiB cap before the temporary file is
created or renamed. A journal therefore can never be committed into a state
its own reader would refuse after a restart; a refused growth or invalid
snapshot leaves the previous committed `payment.json` intact. The lock file
`payment.flock` must be an owned private regular file with no hard links
(`nlink` 1), like the journal file itself. A failed or interrupted write
requires reading back and reconciling state before retrying any external
operation. This journal
cannot make an external transfer atomic with a local write; payment adapters
need their own idempotency and reconciliation protocol.

A leftover `payment.lock` from the legacy exclusive-create scheme is refused,
never removed automatically regardless of age: it may record an interrupted
writer whose replacement never committed. An operator must reconcile offline
first — read `payment.json` and any `.payment-*.tmp` remnants, compare them
against provider and chain records, settle or refund any in-flight payment —
and only then delete `payment.lock` by hand.

Run the journal only from the financial service's trusted process ancestry
inside its private financial-state directory: owned by the running uid, mode
0700, no symlinked path, on the unlocked encrypted volume described below.
The advisory lock and permission checks defend trusted concurrent code against
accidents; they are not a boundary against an adversary who can already write
to that directory or spawn service processes.

Store only recovery references here. Files have restrictive permissions but are
not encrypted. Deploy on an unlocked encrypted financial-state volume, separate
from disposable workspace files. Do not put credentials, seeds or private
transaction evidence in UI responses or agent context.

Run checks with `node --test portable/credit-journal/journal.test.mjs`.
These checks cover process reopening, state ordering, duplicate events, writer
contention (including SIGKILL of a lock-holding child and FIFO/oversize
refusal), cap-crossing growth refusal, the mutation callback contract, orphan
temporary-file handling and corruption. Power-loss recovery still needs VM
and hardware tests.
