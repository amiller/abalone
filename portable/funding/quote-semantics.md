# Native funding quote semantic prototype

`validateNativeFundingQuote(rawJson, policy, clock)` is a pure offline check for
an issued, exact-output native ZEC-to-LTC quote. It calls the production pinned
[0.1.26 signature helper](quote-signature.PROVENANCE.md). It has no signer
override, network access, wallet access or payment operation.

The caller supplies trusted `policy.expectedRequest`, the exact request sent;
`receiverBinding` contains independently established `recipientLtc` and
`refundZec`. Equality checks do not prove ownership. Establish and durably
preserve those wallet bindings before requesting or displaying a deposit.
The policy also supplies canonical decimal strings `maxTotalInputZatoshis`,
`maxZecSenderFeeZatoshis`, `maxRefundFeeZatoshis`, and
`maxWithdrawFeeLitoshis`. The input cap includes the reserved sender fee.
Withdrawal fees are bounded separately; they are not subtracted again from the
provider's stated output. Both optional provider fee fields must be present for
this bounded-fee route; absence produces `unknown-fees`, never an assumed zero.
A route that omits fees needs a separately reviewed cost policy before support.
Fees need not be smaller than the input or net output; explicit policy caps apply.
Required `minimumOutLitoshis` is a positive trusted receipt floor no larger than
the fixed requested output. `amountOut` must equal that fixed request, while
`minAmountOut` must meet the independent floor and not exceed `amountOut`.
USD valuation strings are shape-checked, never used
as an authorization amount.

Supported requests explicitly select `dry: false`, `swapType: EXACT_OUTPUT`,
`originAsset: nep141:zec.omft.near`, `destinationAsset: nep141:ltc.omft.near`,
`depositType` and `refundType: ORIGIN_CHAIN`, and
`recipientType: DESTINATION_CHAIN`. Amounts are canonical integer base units
(up to 18 digits); slippage is an integer from 0 through 100 basis points.
The request echo must match every expected field. Additional request fields
are refused except empty `appFees`. Unknown quote fields and nonempty fees
are refused rather than assigned guessed semantics.

The supported address subset is mainnet transparent Zcash t1/t3 and mainnet
Litecoin P2PKH L addresses, verified with Base58Check checksum, decoded length
and version bytes. Unified, shielded and other address formats are reported as
unsupported; the module does not declare those formats invalid. No memo is
supported. Checksums establish encoding, not key possession or payment safety.

`clock` contains trusted `nowMs` and `requestStartedAtMs`. Clock rollback and
requests older than two minutes are refused. The provider timestamp allows
30 seconds of skew. Returned deadline may shorten the requested deadline;
it cannot extend it. Deadline must leave the estimated post-confirmation swap
duration plus trusted `depositConfirmationBudgetMs` and `safetyMarginMs`.
The confirmation budget must be a positive safe integer up to one day; the
transport/safety margin must be a safe integer from two minutes through one day.
The caller must choose budgets appropriate to the route; two minutes alone
is not a Zcash confirmation guarantee. Finite estimates from zero to 3600
seconds, including fractions, are accepted and rounded up to milliseconds.
These bounds express application policy, not a provider completion guarantee.

Optional `timeWhenInactive` is only cold-address UX metadata: processing may
slow after it. It has no enforced ordering against the fund-loss deadline.
The result's `coldAddress` is a boolean or `unknown` when absent. A valid cold
timestamp does not itself cause refusal.

A `matches-policy` result includes a hash of the exact raw response, the deposit
instruction, `transportProvenance: not-evaluated`, and `creditProof: false`.
It is not payment authorization. The caller must separately establish the
fixed provider origin and authenticated TLS transport, preserve the response
and intent durably, and enforce any approval policy before display or payment.
This module does not authenticate execution status, transaction confirmation,
PPQ invoices or account credit. The correlation ID is not a signed credit proof.

The field choices follow the reviewed SDK 0.1.26 DTO and signature projection and
[documented quote API](https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote).
This deliberately strict subset has not been tested against a genuine issued
provider quote; optional extra response fields may require an explicit reviewed
schema expansion. No live quote, account, key or payment was created.

Run `node --test portable/funding/quote-semantics.test.mjs`. Public tests prove
that a synthetically well-shaped quote still fails the actual pinned signature
check and exercise refusal boundaries. Positive semantic assertions use a
private copied module with a synthetic signature stub; they do not demonstrate
a production-positive quote or replace the separate real cryptographic tests.
