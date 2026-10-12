# Prepare an Abalone release

This is the packaging contract for [gift-URL acceptance](https://github.com/amiller/abalone/issues/4).
It prepares files locally; it does not publish source, change visibility or
authorize provider spending. Runtime/trace-choice changes need independent review.

The gift entry is the static page `site/redeem/index.html` (served by GitHub
Pages) and the [Abalone incognito skill](../skills/abalone-incognito/SKILL.md). The
setup agent explains Abalone, installs the reviewed release, redeems and saves
access with `abalone credit`, then opens a fresh user terminal for
`abalone credit session`. The helper remains the patched Pi/Abalone distribution;
this is not stock Pi/Hermes integration.
Milestone 1 is the explicit trusted-owned-host profile without OS isolation;
bubblewrap containment/setup is milestone 2. Prior isolated helper checks do not
qualify that changed profile. Current checks are separate from an agent's skill discovery and
terminal handoff, which still need an actual no-secret rehearsal. Publish the
skill and explain its host setup separately from the immutable runtime archive;
do not regenerate that archive for instructions-only changes.

1. Freeze/review the selected client. Run the required integration gate, including
   declared development fixtures, and record the actual result. Review synthetic/
   recorded fixture provenance; omit private plans, logs, credentials, live traces,
   operator state and private history. The gate includes the offline usability
   suite, `tests/usability/offline.sh` (`usability` in `tests/verify.sh offline`):
   a cold run from the redeem link with a valid and an expired offer, the Dsmack
   (extension) commands a credit session shows, and its first screen at 80x24 and 120x40 on light and
   dark terminals. Look at the saved screens and messages in
   `local-data/usability/<run>/`. Its XFAIL list holds checks that fail until a
   known fix integrates. Do not add entries to make a release pass; an entry is
   removed when its fix integrates (a passing entry fails the gate).
2. Build once with `tools/release.sh REV`. It copies `site/friend.html`, a static
   doorway to the hosted entry and this guide, as the prepared `index.html`. Record source SHA/tree, locks/build
   evidence, artifact SHA256, licenses/notices and security contact. Compare selected
   source bytes and safe archive members to the package. Reused evidence is not fresh.
3. Assemble genuine four-file public inputs against that exact artifact:
   `trial.json`, `issuer-pin.json`, `staging-approval.json`, `readiness.json`.
   Check signatures, source hashes, route, profile and expiry through normal loading
   and fresh issuer admission. No coupon, owner/provider token or signing key belongs
   here. Readiness is an observation, not a perpetual availability guarantee.
4. Render after assembly; pins depend on the final build, so the bundle is not
   embedded inside its own artifact:

   ```sh
   python3 tools/render-installer.py \
     --rev REV --artifact-sha256 ARTIFACT_SHA256 \
     --base https://github.com/amiller/abalone/releases/download/RELEASE_TAG \
     --trial-dir PUBLIC_TRIAL_DIRECTORY --out PREPARED_INSTALLER
   ```

   Substitute real reviewed values in the prepared output. It pins the artifact
   and each public file. It accepts only the `linux-node24-owned-host` profile;
   without `--trial-dir`, `--credit` refuses before downloading.
   Place the rendered output as `install.sh` beside the four public files, then
   create the landing's checksum file from those exact reviewed bytes:

   ```sh
   sha256sum install.sh issuer-pin.json staging-approval.json trial.json readiness.json > FRIEND-SHA256SUMS
   ```

   Review that file and serve it with all five sibling assets. `tools/release.sh
   REV BASE` alone emits a generic installer; it does not assemble a trial bundle
   or this checksum file.

   `sh install.sh --credit` is the recipient's install-only entry for the
   durable credit procedure in [access and installation](redeem.md). It
   downloads the archive and the four public files, checks each pinned SHA256,
   refuses an archive without `abalone credit`, rechecks any existing install,
   saves the files with a receipt under `~/.abalone-app/REV/public-credit/`,
   links `~/.local/bin/abalone` and prints the absolute paths. It needs `flock`,
   not bubblewrap, and requires pins for the `linux-node24-owned-host` profile.
   It redeems nothing and starts nothing. Bare `sh install.sh` installs, prints
   a legacy redeem hint and asks about canaries. Its only other form is the
   legacy `--peer <peer address> <code>.<grant>` redeem. The release notes must
   say the release provides `--credit`.
5. Rehearse the actual installer on a clean supported Linux machine as nonroot.
   Verify no ambient account/operator credentials, pre-bearer readiness, human
   input, bounded redemption, first request, admission expiry, trace choices and
   cleanup. Hidden repair or disabled guards do not count. Keep user gifts separate.
   Before promotion, run the live usability suite from the rehearsed install on that
   real saved credit: `tests/usability/live.sh --live --credit <credit id>`. It spends
   from the credit. A task passes when every turn settles with no `length` stop or
   dialog, it prints at most one warning line, and its edit landed or its answer
   names the facts in the synthetic fixtures; read the answers in `live.json` too.
6. Review the complete publication manifest and precise GitHub actions: selected
   source/history, candidate refs, package, installer, checksums, public inputs and
   sanitized notes. Request final publication authorization after the concrete files
   and owner-approved walkthrough are ready. Never expose private workspace/history.
7. After authorized publication, download every recipient URL without maintainer
   authentication and compare reviewed hashes. Only then replace the availability
   line in [access and installation](redeem.md) with the exact release
   links. A private repo/404 is not public acquisition.
8. Publish the entry page separately: select GitHub Actions as the Pages source,
   run `.github/workflows/pages.yml` from reviewed main, and load the page with a
   synthetic `#code=` fragment to confirm no request carries it. The page does no
   redemption; deploying it is not a release.

The first slice is bounded direct NEAR on the selected Dsmack public testnet
profile. Another provider, optimistic settlement, portable IP isolation and
broader deposit settlement remain separate work. Candidate, reviewed integration,
package qualification and actual user validation are distinct states.

## Stable entry URL and changing availability

The gift landing/discovery URL should resolve to the current reviewed,
versioned installer, artifact and public bundle with exact checksums. Keep each
version immutable. Updating the public approval or bundle means rendering and
reviewing a new installer version; it does not require rebuilding unchanged
client bytes. Never make the client ignore expired signatures or source pins.

Private management-session JWT renewal alone does not change the public bundle.
The service must still renew its authorization and advertise only a window it
can support. An approval, issuance policy, coupon or staffing window can expire
independently. A stable download URL is not perpetual coupon validity or service
availability. Discovery must show fresh available/unavailable/unknown state and
the actual supported claim deadline; a previously green observation is insufficient.


## Supported landing and qualification scope

`site/redeem/index.html` is the hosted entry; `site/friend.html` is a static
doorway that links to it and to this repository's guides, and the build copies it
as `index.html`. Neither page reads, forwards or redeems a coupon, and neither
carries version-specific installer links. Do not advertise readiness merely
because packaging completed.

The current debug-staging gift trial permits synthetic, non-sensitive content
only, operator-readable issuer custody and explicit firmware warnings. Broader
private use separately requires reviewed custody/configuration authority, provider
owner powers, recovery/rollback behavior, retention and relevant settlement
checks. Network anonymity needs its own selected routing/loss qualification.
Keep these scope limits with [the security profile](security.md); do not turn a
passing synthetic fixture into a production privacy or funding claim.

PDF selection in a credit session uses the owned-host extraction path
(`pdftotext`). Earlier PDF evidence came from a preinstalled synthetic run and
covers only that captured path; the installed durable-credit PDF path still needs
its own live check.
