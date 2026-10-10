# Environment profiles

All procedures here are proposed, not qualified. An owned Linux rehearsal is the
first target; the other profiles require their own platform evidence. No single
bootable image or hardware guarantee covers these choices.

| Profile | Boundary and trust | State and lifecycle decisions |
| --- | --- | --- |
| Owned persistent Linux host | Trust the owner, administrator, kernel and launcher. Whole-process bubblewrap can contain the agent; same-user outside processes retain owner authority. A separate service account can restrict a caller, but sudo-capable callers and root remain administrators. | Choose ordinary plaintext owner-only state or strict-incognito encrypted traces. An existing encrypted volume is needed for a claim covering workspace files and other durable state. Declare whether it remains unlocked while unattended. |
| Owned Mac/server | Trust the owner and administrator. Current macOS client/remote-task support is narrower than Linux interactive isolation. A Linux guest is a proposed compatibility route, not a qualified Mac journey; an ordinary VM owner can enter it and inspect memory/disks. | Record VM owner, shared folders, host caches, guest state, startup/login dependencies and local-model services. Verify stop actually ends the guest/session and locks applicable storage. Boot encryption does not automatically lock a running login session. |
| Encrypted USB, host launch | The host OS and administrator see unlocked data. Encryption protects the declared locked payload; launching from a stick does not contain the agent or remove host traces. | Pin one host OS/architecture and filesystem. Put workspace, state, logs and model caches in the declared persistence set; choose whether keys travel separately. Stop writers, verify locking, then eject. Test loss, damaged media and a backup restore. |
| USB, cold boot | A different path from host launch. Trust hardware, firmware and the boot chain. Booting one's OS may avoid the borrowed installed OS; it does not establish confidentiality on malicious hardware. Tails persistence is a precedent, not Abalone compatibility evidence. | Name the supported machine, boot image and device. Rehearse networking/model dependencies, opt-in persistence, restart and recovery. Installation, formatting and firmware changes need a separately authorized implementation stage. |
| Borrowed ordinary remote host, including Mac | The operator/admin/hypervisor can inspect the running session. Proceed only under declared operator trust when that meets the user's intent. An attested device identity or authenticated SSH connection does not conceal plaintext from its owner. | Include remote workspace, guest disks, logs, snapshots and retention/removal commitments. Use task-scoped credentials and explicit export/result boundaries; remote deletion is not independently provable erasure. |
| Borrowed confidential runtime | A separately proposed route. Admit exact measurements, software/model identity, live-channel key binding, operator controls and persistence/key policy before private input. Attesting inference alone does not attest the agent runtime. | Re-attest reconnect/restore/migration destinations. Record backup key release, freshness, rollback/fork assumptions and downgrade refusal. Unsupported confidentiality must produce a correct refusal or a user-selected trusted-host alternative. |

## Choices that must survive every profile

- **Persistence:** distinguish encrypted trace from plaintext output files,
  provider keys, browser state, logs, metadata and backups. Disposable execution
  can retain encrypted history; “incognito” does not mean nothing remains.
- **Credentials:** import only explicit task-scoped synthetic credentials for
  rehearsal. Do not copy a personal home, browser profile, SSH agent, password
  manager or cloud credentials. Record which process holds raw keys. The current
  development provider-key path is not a credential broker.
- **Routes:** enumerate main, auxiliary, compaction/reviewer, subagent, browser,
  package/update/telemetry and remote-tool paths that actually exist. An owned
  remote local-model server is another trusted machine. Local loopback and an
  admitted attested route are different claims; neither implies anonymity.
- **Recovery:** retain independently protected key/identity material and a tested
  ciphertext backup where required. Never put the sole recovery secret only on
  the portable drive it unlocks. A copy may restore availability without proving
  freshness. Interrupted close, rollback and fork need distinct outcomes.
- **Migration/removal:** inventory every state location and observer; confirm the
  destination's contract before restoring. Rotate/revoke remote credentials when
  their custody changes. A copied folder does not carry all keys or high-water
  marks, and removing a local key is not proof no exported identity survives.

Historical pilot lessons motivate these checks: a dedicated account/vault helped
separate ordinary files and locked state, while passwordless sudo remained
deferred, a VM ran under the ordinary operator and could be entered, proxy
variables could be bypassed, and a VM wrapper allowed direct fallback. These
were incomplete protections and historical observations, not qualification here.
