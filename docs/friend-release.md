# Prepare one friend release

Use [the hidden-entry friend landing](../site/friend.html) for this release.
`site/index.html` is a historical fragment/argument gift experiment and is not
the supported friend-release entry. The legacy release script's generated
`index.html` must be replaced with this separately reviewed landing asset before
publication. Do not send coupons through its old URL/command interface.

This is the packaging contract for [friend-URL acceptance](https://github.com/amiller/abalone/issues/4).
It prepares files locally; it does not publish source, change visibility or
authorize provider spending. Runtime/trace-choice changes need independent review.

The friend entry is the outside [Abalone incognito skill](../skills/abalone-incognito/SKILL.md).
Its setup agent prepares the reviewed helper, then hands an interactive terminal
to the user and stops observing before hidden/private input. The helper remains
the patched Pi/Abalone distribution; this is not stock Pi/Hermes integration.
Milestone1 is the explicit trusted-owned-host profile without OS isolation;
bubblewrap containment/setup is milestone2. Prior isolated helper checks do not
qualify that changed profile. Current checks are separate from an agent's skill discovery and
terminal handoff, which still need an actual no-secret rehearsal. Publish the
skill and explain its host setup separately from the immutable runtime archive;
do not regenerate that archive for instructions-only changes.

1. Freeze/review the selected client. Run the required integration gate, including
   declared development fixtures, and record the actual result. Review synthetic/
   recorded fixture provenance; omit private plans, logs, credentials, live traces,
   operator state and private history.
2. Build once with `tools/release.sh REV`. Record source SHA/tree, locks/build
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
   and each public file. Without `--trial-dir`, `--friend` refuses before gift entry.
   Serve the four files as sibling assets with these exact names.
5. Rehearse the actual installer on a clean supported Linux machine as nonroot.
   Verify no ambient account/operator credentials, pre-bearer readiness, human
   input, bounded redemption, first request, admission expiry, trace choices and
   cleanup. Hidden repair or disabled guards do not count. Keep user gifts separate.
6. Review the complete publication manifest and precise GitHub actions: selected
   source/history, candidate refs, package, installer, checksums, public inputs and
   sanitized notes. Request final publication authorization after the concrete files
   and owner-approved walkthrough are ready. Never expose private workspace/history.
7. After authorized publication, download every recipient URL without maintainer
   authentication and compare reviewed hashes. Only then update README status.
   A private repo/404 is not public acquisition.

The first slice is bounded direct NEAR on the selected Dsmack public testnet
profile. Another provider, optimistic settlement, portable IP isolation and
broader deposit settlement remain separate work. Candidate, reviewed integration,
package qualification and actual user validation are distinct states.

## Stable entry URL and changing availability

The friend landing/discovery URL should resolve to the current reviewed,
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
