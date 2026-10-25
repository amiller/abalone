# Offline terminal workspace staging

`stage-runtime.py` copies the selected terminal workspace into an exclusively
controlled offline image tree. It does not install packages, mount filesystems,
run target code, create accounts, enable services, select a boot target, change
networking, or format persistence. Never point it at the running root filesystem.

The current worker uses the real SDK with a **scripted local model**. Staging it
does not establish provider inference, available credit, live funding, Tor routing,
or a qualified boot image. Existing credit remains unknown until connected.

Two independently reviewed manifests are required:

- A JSON object mapping every name in `SOURCE_NAMES` to its SHA256. This fixes the
  selected workspace, native terminal, browser launcher, status projection and
  seven unit sources. Tests, local state and QEMU diagnostic drop-ins are excluded.
- An artifact manifest with exactly `version: 1`, `files` and `links`. Each file
  record contains `sha256` and integer `mode` (420 or 493). Allowed destinations
  are `bin/node` and `vendor/pi/…`, relative to `/opt/portable`. Every regular file
  and symlink in the supplied artifact tree must be listed. Symlinks must resolve
  inside its reviewed `vendor/pi` content. Node must be an AArch64 ELF; its full
  digest still needs independent provenance and actual ARM execution evidence.

Keep the manifests **outside** the artifact tree and pin their literal byte
hashes separately. The helper checks hashes; generating a manifest does not
constitute reviewing its contents. Keep SDK bundles unchanged when their own
verifier requires exact contents. A sibling compatibility symlink may expose the
expected `vendor/pi/packages/coding-agent` entry without modifying that bundle.
Matching native and transitive system libraries remain the assembler's job.

From a selected source checkout, first inspect the dry plan:

```sh
python3 portable/raspberry-pi/image/stage-runtime.py \
  --sysroot /target \
  --source-manifest /reviewed/runtime-sources.json \
  --source-manifest-sha REVIEWED-SOURCE-MANIFEST-SHA256 \
  --artifacts /reviewed/runtime-artifacts \
  --artifact-manifest /reviewed/runtime-artifacts.json \
  --artifact-manifest-sha REVIEWED-ARTIFACT-MANIFEST-SHA256
```

Add `--apply --confirm PORTABLE-RUNTIME-IMAGE` as root to write that offline tree.
Files publish through exclusive temporary files with explicit ownership and modes;
new directories receive explicit 0755 even under umask077. Differing existing
outputs, unsafe paths, links, hardlinks, unreviewed runtime drop-ins and reserved
account collisions refuse. An interrupted application is not transactional: retain
the partial tree and inspect it before any continuation. Concurrent writers are
unsupported. Matching completed output can be staged again before later policies.

The account preflight reserves agent970, UI971, credit972, operators973 and IPC974.
It rejects unrelated primary or supplemental membership in protected groups,
unlocked existing service accounts and identity aliases. It writes declarations
to `/etc/sysusers.d/portable-runtime.conf`, with nologin shells and no administrator
membership, plus private home-directory declarations for systemd-tmpfiles.
The assembler then creates the accounts in the target with its reviewed sysusers
tool, for example inside the isolated builder:

```sh
systemd-sysusers --root=/target
python3 portable/raspberry-pi/image/stage-runtime.py --sysroot /target --verify-accounts
```

This is an offline account database operation; it does not start target systemd.
After verification, stage network and persistent-API policies, normalize vendor
first-boot actions, inspect the effective unit graph, and enable the selected
workspace/display/status units and graphical target. Runtime staging must precede
those other stagers: unknown existing drop-ins refuse instead of being silently
preserved. The separate workspace owner keeps files alive when the backend stops;
no temporary handoff-preservation override belongs in an image.

The fixed file list is intentionally a runtime slice, not a complete release.
The image assembler must also retain project/component licenses, package notices,
kernel/firmware provenance, dependency inventories and the reviewed source revision.
It must separately qualify account creation, actual SDK/native dependencies,
sandboxed Chromium, keyboard/display input, Tor-only egress, startup failures,
encrypted recovery, admitted inference and real hardware boot.

Run `python3 portable/raspberry-pi/image/tests/test-runtime-stage.py` for small offline fixtures.
They check mode publication under a restrictive umask, identity/authority refusals,
manifest closure, unsafe paths, repeat staging and actual sysusers declaration
semantics in an isolated target. The tests require `unshare` and
`/usr/bin/systemd-sysusers`. The fake ELF/SDK fixtures are never executed and do
not qualify the real ARM payload or the target's sysusers version.

The artifact manifest must explicitly include `bin/portable-clock` with its reviewed
SHA256 and mode 0755. It uses the existing artifact input tree and manifest, with
no new CLI flag: supply a prebuilt ELF64 little-endian AArch64 command. Staging
checks its hash and architecture; it does not compile, execute, or establish
runtime qualification of that binary. Missing clock input is refused.

The source manifest includes the clock observer and command sources, GPL COPYING,
Go BSD notice, command MIT license, and NOTICE describing linked-binary obligations.
The static `portable-clock.service` is copied but never enabled; no clock config,
time sources, readiness receipt or desktop dependency is created. `UNITS` is an
installation inventory, **not an enablement list**. Activation requires separately
reviewed trusted configuration and disposable-VM clock qualification. Existing
images need a separately reviewed continuation, not replay of this full stager.

Vault console closure additionally includes root-owned0755 aliases under
`/opt/portable/bin` for vault-broker.py, common.sh, unlock-vault.sh, lock-vault.sh
and vault-status.sh. Their source copies remain0644. The broker and operator
units are copied, not enabled; the base broker has no credit-session flag.
Explicit root-owned vault.conf and optional broker credit-session drop-in are
separate image inputs. No graphical or agent financial authority is introduced.

### Explicit direct-Zai profile

Select `--profile direct-zai` with a source manifest over
`source_names('direct-zai')` from `stage-runtime.py`. Omitting the flag retains the
existing profile and source manifest. The selected profile adds the fixed direct
broker, curl transport, inherited-lease entry and root financial supervisor wrapper;
it installs three explicit drop-ins selecting the fixed inference socket, direct
consumer and existing unlock/start, stop/drain/lock composition. It never enables
units, creates credentials, formats a partition or writes vault configuration.
The internal `portable-credit.service` name is retained for that existing bounded
lifecycle; it runs inference in this profile, not a PPQ balance fetch. Credit and
funding remain unknown/unconfigured. UI and agent users gain no vault authority.

The inference parent is created by target tmpfiles as UID972:GID974 mode02750.
The source unit's capability bounds, host mount view, session limit and stop
semantics are unchanged. No privileged backend restart or readiness helper is
installed: agent readiness must requalify when the trusted broker socket becomes
available after unlock. Qualify that lifecycle before a physical release.

The caller still supplies a complete, reviewed Node/SDK/clock artifact manifest.
Direct mode additionally requires the installed scoped SDK package layout,
pi-ai compatibility exports, lazy OpenAI entry and OpenAI notice. These structural
checks catch the known omitted dependency; they do not execute or qualify the SDK,
resolve transitive dependencies, verify upstream provenance or replace its complete
packager manifest. Retain all dependency notices and the existing Node license
closure. No build, install, network lookup or ambient provider fallback occurs.

This profile contains no host exporter, private key holder, virtio channel, fake
Tor/time service or rehearsal CA. Independent user enrollment, trusted real clock
configuration, selected real Tor network policy and deliberate broker/operator
unit activation remain separate image inputs. Existing images require a reviewed
continuation rather than replaying this fresh-tree stager. The offline tests cover
both profiles, exact drop-ins, lazy-dependency refusal, real mapped-root repeated
publication and an isolated systemd dependency-graph check (executables replaced
with `true` for host portability); they do not establish live ARM/Pi readiness.

`--local-enrollment` additionally stages the four local enrollment modules and
`portable-vault-enrollment.service`. It requires `--profile direct-zai` and an
exact source manifest over `source_names('direct-zai', True)`. The service is a
separate trusted root tty3 setup path; tty2 unlock/lock and the UI/agent authority
remain unchanged. No unit is enabled and no vault configuration, passphrase,
API key, enrollment marker or filesystem is created by staging. Native adapter,
capability/TTY behavior, physical-medium binding and crash recovery require their
own qualification; copying these sources is not an enrollment success claim.
