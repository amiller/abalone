# Run the optional client from a folder

**Source preview:** this layout is implemented for the next client distribution.
It has not been published as a qualified release. Current gift recipients should
use the [released redemption procedure](abalone-coupon-redeem.md). Using private
inference in [ordinary Pi](../guides/private-inference/pi.md) remains the simplest
path for someone who already uses Pi.

The optional Dsmack client can run from one verified archive. It contains the
client and matching public coupon inputs. No launcher installation is needed.
This packaged client remains a Linux x86_64 / Node 24 procedure; those are not
requirements for the guides or the independent provider package. Coupon sessions
also need `flock` and Linux tmpfs. Sandbox sessions require bubblewrap separately.

## Unpack and run

For a release that actually provides `abalone-REV-portable.tar.gz`:

1. Download the archive and its checksum file into a new directory you control.
   Compare the digest with trusted release notes; a checksum beside a download
   alone does not establish its origin or safety.
2. Check and extract it, substituting that release's revision for `REV`:

   ```sh
   sha256sum -c abalone-REV-portable.tar.gz.sha256
   tar -xzf abalone-REV-portable.tar.gz
   cd abalone-REV-portable
   ./abalone/bin/abalone
   ```

3. The client uses `work/` as its initial workspace when started from this
   container. Paste a gift privately when prompted and review its offer before
   accepting. A matching bundled trial is found automatically. Installation
   claims nothing; redemption is a separate, explicit operation.

To select your own project, change to that directory and run the absolute path
to `abalone/bin/abalone`. The container itself, its runtime and saved state should
not be your working documents. Local tools in the coupon route have ordinary
account access; choosing `work/` is not OS isolation.

## What travels with the folder

Keep the whole `abalone-REV-portable/` container together:

| Path | Purpose |
| --- | --- |
| `abalone/` | Client runtime and reviewed code |
| `public-credit/BUNDLE/` | Matching public trial, issuer pin, approval and readiness observation |
| `portable.json` | Package metadata that selects portable state |
| `state/` | Saved credentials/access and non-temporary client state; created 0700 on use |
| `work/` | Initial documents folder; edits remain after closing |

Moving the whole container preserves its saved access. An explicit `ABALONE_DIR`
overrides the default and puts state elsewhere. Old, unmarked installations keep
using `~/.abalone`; no credentials are automatically copied or migrated.
Do not put a `portable.json` marker beside an unrelated installation.

`state/` can contain secrets. Copying, syncing or backing up the container copies
that state too. Incognito conversation preparation uses verified memory-backed
run directories outside the container; terminal output and workspace edits have
separate lifetimes. Explicit encrypted traces remain in the selected workspace.
Closing the client does not revoke a provider credential. Deleting files does
not prove secure erasure. See [retention and local host limits](security.md#local-host-and-retention).

Bundled `readiness.json` is an unsigned observation. It does not promise that a
coupon remains claimable, an approval remains fresh, or a provider is available.
The normal admission, expiry, consent and original-key recovery checks still run.

## Optional launcher installation

If you want a launcher in `~/.local/bin`, use a release's reviewed installer.
The new source installer supports:

```sh
sh install.sh --credit --plan
sh install.sh --credit
```

`--plan` prints exact URLs, pinned digests, destination paths, requirements and
operations, with no network or filesystem writes. It works before runtime or OS
preflight. Compare its pins with trusted release notes and inspect the script.
A real run prints the same plan before checking the host and downloading.
It stages and checks files, refuses a differing existing install, and links the
launcher. It executes no downloaded program, redeems no gift, plants no canary,
and starts no conversation. Plain `sh install.sh --plan` previews runtime-only
installation; `--credit` additionally installs public coupon inputs.

This installer places an **unmarked** runtime under `~/.abalone-app/REV/`;
subsequent client use retains the existing home-state default. It does not move
portable state. Legacy gift arguments are refused; use the client to redeem.
The currently released preview.8.1 installer predates `--plan`; do not assume
that historical script supports the new options.

## Prepare an archive from reviewed inputs

Maintainers can repackage a built, portable-aware runtime with matching public
files without rebuilding Pi or executing the runtime:

```sh
python3 tools/pack-portable.py \
  --runtime-archive /path/abalone-REV.tar.gz \
  --runtime-sha256 TRUSTED_RUNTIME_SHA256 \
  --trial-dir /path/public-inputs --rev REV --out local-data/portable-preview
```

The helper verifies the pinned runtime and rejects escaping paths/links, special
files and local-state directories. It copies only the four named, bounded public
JSON files and writes the archive's checksum. It requires the current owned-host
profile and a portable-aware runtime. Packaging is not publication, independent
review or live/friend qualification.
