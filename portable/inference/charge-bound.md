# Trusted inference charge ceiling

`deriveTrustedChargeBound({request, policy, nowMs})` reserves the full trusted
`maxBillableInputTokens` ceiling at `pricePerInputToken`, plus the maximum billed
output at `pricePerOutputToken`. It does not estimate token counts from JSON
bytes or subtract requested output from the input ceiling. Provider-added chat
formatting, system text and tool templates must all fit the admitted input
ceiling. A model's advertised context size alone does not prove that billing
contract: the provider must enforce it over all billed input.

Policy is root-owned broker configuration, never caller data or automatically
trusted model metadata. No production policy is shipped. Required fields:

- Exact `endpoint`, `externalModel`, `sealedModel`: the PPQ private chat endpoint,
  `private/gpt-oss-120b`, and `gpt-oss-120b` respectively.
- `validFromMs`, `validUntilMs`: trusted tariff validity interval; trusted `nowMs`
  must fall inside it. A rollback-safe clock remains the broker's responsibility.
- `evidenceId`: reference to independently reviewed billing/limit evidence.
  Its syntax is checked; this module does not authenticate the evidence.
- `billing: input-output-tokens-only`: the admitted contract excludes additional
  request, tool, reasoning or other charges outside the two token categories.
- `ledgerUnit` and positive integer-string prices per token in that unit.
  Use conservatively rounded-up prices if the ledger cannot represent exact
  rates; settlement must use the same admitted units and pricing contract.
- Positive integer `maxBillableInputTokens`, `maxRequestedOutputTokens`, and an
  explicit `reasoningEfforts` list including `default` if requests omit it.
- `outputBound: request-max-includes-all-billed-reasoning` only with evidence
  that `max_tokens` caps every billed output token, including hidden reasoning.
  Alternatively `provider-total-output-ceiling` requires positive integer
  `maxBillableOutputTokens` and reserves that whole ceiling regardless of the
  requested output cap. Unknown reasoning limits must refuse before POST.

The validated request supplies the external model ID, mandatory `max_tokens`,
and optional `reasoning_effort`. Existing broker body validation still applies;
this arithmetic module is not a complete request validator. The result contains
`bound`, input/output token ceilings, normalized prices, ledger unit and evidence
ID. Errors use `code: charge-bound-refused`; no legacy byte-count fallback.

Integrate by checking this policy before attestation/reservation/paid POST,
reserving the returned bound durably, and enforcing authorized remaining budget.
Snapshot the admitted policy for the request so mid-flight tariff changes cannot
change settlement. Provider usage exceeding a ceiling is a discrepancy, not
permission to charge beyond the reservation; fail closed on further requests.
A reservation is an enforceable local permission ceiling only to the extent
that the admitted provider billing contract is true. It cannot prevent a remote
provider from violating its contract.

Historical metadata recorded a 131072 context and pricing for this route, but
provided no private-model supported-parameter or all-billed-reasoning guarantee.
The cached private-mode 0.7.0 proxy maps IDs and forwards requests; it does not
establish those ceilings. Therefore current evidence is insufficient to install
a production policy. Tests use synthetic policy facts through the public API,
without any production bypass. They prove refusal and arithmetic, not pricing
truth, current provider behavior or live readiness.

Run `node --test portable/inference/charge-bound.test.mjs`.
