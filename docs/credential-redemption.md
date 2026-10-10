# Claim and use an encumbered credential

Draft recipient contract, 10 October 2026. This defines Abalone's client work for
the paired issuer service's credential-redemption work.
It is a design target, not an available command or qualified service. It is an
optional access path and does not block the first incognito session milestone.
The prior client/issuer issue numbers belong to historical private planning.
Current public client work belongs in the [Abalone backlog](https://github.com/amiller/abalone/issues);
the issuer service may remain closed for the initial friend trial.

## Outcome and ownership

A recipient accepts a sponsored coupon, receives a provider credential privately,
and completes a useful task by calling the admitted provider directly. They need
neither the sponsor's account login nor a separate CVM setup. The sponsor does not
receive the issued secret through this flow, but may retain provider-side powers
to revoke or change limits. Recipient sharing of a bearer secret is not prevented.

dsmack owns issuance, protected sponsor provisioning, service authentication,
accounting observation and settlement evidence. Abalone owns discovery, informed
claiming, recipient keys, credential installation, provider admission, visible
state, recovery and forgetting. Inference routing is a separate subproject.

## Recipient binding decision

The current experimental handler requires a previously authorized recipient
subject as well as the coupon. A stolen token alone cannot claim it. Product
wording such as “send anyone a link” must not imply first-bearer redemption is
already supported by that prototype.

Release target: the friend needs no account or advance pairing. Coupon possession
authorizes the first claim, which atomically binds locally generated recipient
identity and delivery keys. The pre-bound flow may remain an experimental
integration fixture; it does not satisfy the release journey. Define identity/key
retention, simultaneous claims, theft/forwarding and retry rules before implementing
the transition. See the [coordinated public preview](gift-public-preview.md).
Specify how the authenticated recipient authorizes or proves the delivery-key
binding; a recipient_key field alone does not establish recipient identity.

## Journey contract

1. **Inspect the offer.** Display provider, denomination, nominal limit, expiry
   where supported, remaining sponsor powers, required service trust and intended
   retention. Provider caps can overshoot; do not promise a universal balance or
   a balance transferable across operators. Verify terms rather than trusting
   arbitrary text from the link. Define a versioned offer format before coding.
2. **Enter the private session.** If an outside agent helps setup, rehearse using
   synthetic offers and hand off before real coupon/key entry. Keep bearer
   material out of that agent's messages, terminal capture and automatic return
   summaries. Do not put it in shell command arguments or logs by default.
3. **Verify and claim.** Authenticate the service and verify the selected issuer
   attestation policy before sending the real coupon. Peer identity alone is not
   measured-code identity. Generate the recipient delivery key locally; bind the
   claim to the authenticated recipient and verified offer. No production fallback
   to local-unattested evidence is permitted.
4. **Receive and install.** Authenticate/decrypt the envelope and check its
   coupon, recipient, provider and key identity bindings. Install into an explicit
   credential slot scoped to this session/profile without overwriting an existing
   credential. Choose reuse/replacement explicitly. Credential availability does
   not bypass Abalone's ordinary provider/model admission checks.
5. **Use directly.** Show the actual inference destination and budget information,
   distinguishing provider observations from estimates and stale/unknown values.
   Prompts need not go through dsmack. Usage may produce observer evidence for
   sponsor deposit return; this does not grant permission to inspect prompts.
6. **Close or recover.** Apply the chosen secret/trace retention policy. Explain
   what remains and how to resume or forget it. Local forgetting is not proof of
   upstream revocation, secure erasure or returned funds.

## Required states and failures

Specify UI and retry semantics for unclaimed, awaiting recipient authorization,
issuing, delivered, installed, exhausted, revoked/expired, unavailable and
reconciliation-required states. Some are client states; negotiate the mapping
to service responses instead of assuming the current handler returns all of them.

Retries after a lost response must reuse the original coupon and delivery key.
The current service can replay the same encrypted delivery to that key. An
ambiguous upstream creation must not trigger blind new issuance. Losing the
private delivery key is not transparently recoverable: define an explicit
reconciliation/replacement policy. Keep the existing credential intact on failure.

The current service returns a generic request_failed response. Before implementing
the full UI, agree on a minimal set of privacy-preserving error/status codes that
distinguish safe retry, reauthorization and operator reconciliation without
leaking secrets, upstream errors or another recipient's state.

## Retention decision

Specify where the delivery private key and provider secret reside during use,
what can persist, who can recover it and how failure affects recovery. Session-only
credentials and retained encrypted credentials are different options. Current
incognito trace encryption alone does not define safe credential storage. Resolve
this against the optional incognito session contract without changing global
defaults. Do not promise never-persist behavior before verifying storage paths.

## Finishable slices and evidence

- **Contract slice:** approve recipient binding, offer/envelope schema, service
  admission, error mapping and credential retention. Produce an interaction sketch
  and synthetic fixture contract agreed by both repositories.
- **Client slice:** implement claim/decrypt/install/direct-use against that fixture;
  show wrong-recipient and wrong-service refusal, replay without duplicate install,
  ambiguous issuance handling, no credential overwrite, and no secret in exercised
  logs or outside-agent channels. Fixtures must be visibly synthetic.
- **Live qualification slice:** against an approved deployed service, complete one
  capped claim and useful direct-inference task, then exercise restart, exhausted
  or revoked access and explicit forgetting under a declared budget. Confirm the
  observer's accounting without exposing the credential or prompt. Mock success
  cannot qualify attestation, provider behavior or settlement.

The client slice depends on the agreed contract; live qualification additionally
depends on dsmack's authenticated peer adapter, verified issuance and protected
provider provisioning. A complete client journey need not wait for unspecified
additional reward economics, but must not claim deposit settlement before the
selected contract verifies and releases it.
