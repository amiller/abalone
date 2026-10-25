# Local enrollment transaction slice

`enrollment.py` is an uninstalled root embedding API, not a usable first-boot
console yet. It provides one transaction with exact passphrase confirmation and
fixed Zai record schema, durable-intent ordering, human-passphrase Argon2id
candidate parameters, and explicit partial states. No operator, broker protocol,
image stager or live device is changed by this slice.

`enrollment_native.py` implements the fixed `Native()` adapter and reuses `topology_collector.py`/`topology.py` structural
checks with a distinct blank-admission path: immutable manifest, exact common
boot/root/vault parent, partition 3 geometry, no mounts/holders/duplicate UUIDs,
full 2 GiB zero scan and identity rechecks. It must not fabricate existing-LUKS
observations to satisfy the locked-vault collector. All phases hold the existing
`financial_lease.py` lifecycle flock. Retained block/key descriptors, zero swap,
core exclusions, mapper identity and ordinary mount/close cleanup are required.
The adapter has not yet been installed or qualified against real cryptsetup,
block devices or the setup unit capability set. There is no command-line device
selector. The trusted embedding console must validate the fixed installed storage
directory and sibling source closure before adding it to Python’s import path;
`python -I` does not implicitly admit sibling imports. Call
`Native.require_local_custody()` before collecting any secret.

The proposed interruption invariant preserves the existing three partitions:
write and fsync a public marker into the last 4096 bytes of the zero vault before
formatting. Formatting must provably preserve that range until a valid LUKS2
header is fsynced and read back. The proposed format explicitly fixes the data
offset at 32768 sectors (16 MiB), metadata 16 KiB and keyslots 16744448 bytes;
the pinned cryptsetup implementation must honor those front-region bounds. Only then may mkfs overwrite the encrypted tail.
Every later enrollment attempt requires the entire partition to be zero, so a
marker, partial header, or existing LUKS container refuses a new format. The
marker need not survive normal encrypted filesystem use after the durable
header exists. It contains no key. **Exact installed cryptsetup write-bound
qualification is a prerequisite**, not an assumption made by this module.
No automatic resume or destructive retry is implemented. An interrupted state
requires explicit diagnosis; an existing complete vault uses ordinary unlock.

The adapter contract is deliberately local: `lifecycle` retains/cleans FDs and
owned resources; `admit_blank` returns the existing manifest-shaped admission;
`admit_format_write_bound` checks the exact reviewed tool closure;
`retain_target`/`revalidate` bind block identity and size;
`persist_intent` calls `write_tail_intent` after those checks;
`sync_and_verify_header` checks durable LUKS2 UUID and Argon2id metadata and test-passphrase success before
filesystem creation; `verify_mapper`, `mount_verified`, `unmount_verified` and
`close_verified` enforce the existing fixed mount/mapping policy. Record methods
create only `credit/provider.json` on that verified encrypted mount, with
UID972 directory0700/file0600, exclusive creation, full writes, fsync and readback.
No API-key bytes may be returned or logged. The consumer service is not started
until ordinary subsequent unlock succeeds.

The proposed KDF is Argon2id, 256 MiB, parallelism2, iterations4. This deliberately
replaces the synthetic fixture's PBKDF2/1000 policy, but still needs actual Pi
resource/timing qualification. Passphrases are exact NUL-free12–512 bytes and
must match confirmation. No Unicode normalization or secure heap-zeroization
claim is made. The trusted tty3 enrollment collector must restore noecho on every
exit, keep secrets off argv/environment/files/logs, and provide separate clear
confirmation before first-use formatting. It must not grant the agent/UI format
authority. Existing `operator-vt.py` and `vault-broker.py` are unchanged.

Native commands use retained target and sealed key descriptors; the key descriptor
is rewound before every cryptsetup invocation. The record directory stays root-owned
until the exclusive file has been written, assigned UID972 and synced; only then
is the directory assigned UID972. The setup unit needs DAC_READ_SEARCH for final
readback and SYS_PTRACE for the existing PID1 mount-namespace comparison, in
addition to SYS_ADMIN and CHOWN. These capabilities remain runtime-unqualified.
