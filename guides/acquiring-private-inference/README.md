Status: draft

# Acquiring private inference

A session needs model access that a verified provider accepts. How you pay for
that access decides what the payment links to you. Each route below says what
you need, what an observer can connect, and whether it works with Abalone today.

Abalone currently uses access delivered by a coupon. Importing a key bought
directly from a provider is not supported in this release
([getting started](../../docs/getting-started.md#access-paths)), so routes that
end in a provider key are listed for when it is (issue
[#21](https://github.com/amiller/abalone/issues/21)).

| Route | Works with Abalone today | What is linked |
| --- | --- | --- |
| [Abalone coupon](#abalone-coupon) | Yes, preview releases; synthetic material only | The sponsor knows who they gave the code to; the issuer sees the code at redemption; your IP address |
| Provider key bought directly (card or crypto top-up) | No. Needs provider-key import | The provider account, and the card or paying wallet's history |
| Zcash payment for a coupon | No. Not released | Not yet described; needs current verification before it is published |

Routes that do not qualify: services that pay for inference privately but then
forward plaintext to an ordinary API, or that do not verify a TEE, give you
payment privacy and no inference privacy.

Rules that apply to every route:

- Wallet seeds, spending keys and payment QR codes never go to a coding agent.
  Pay from your own wallet, outside the agent's view.
- Gift codes go through stdin or a private file, never a command line, URL or
  prompt ([redeem](../../docs/abalone-coupon-redeem.md#inspect-redeem-and-save-access)).
- A fresh wallet funded from an exchange account is not anonymous. Neither is a
  transparent deposit followed by a matching withdrawal.
- Connect from Tor if the network address matters (see
  [private inference](../private-inference/README.md)).

## Abalone coupon

Someone who already has access gives you a coupon, usually as a gift link. You
redeem it with an issuer on the Dsmack network, which delivers a model credential
encrypted to keys generated on your computer. Follow
[Redeem a coupon](../../docs/abalone-coupon-redeem.md).

**You need:** Linux x86_64, Node 24 and the listed system tools. No account,
card, VPN or wallet
([conditions](../../docs/abalone-coupon-redeem.md#conditions-before-you-start)).

**What is linked:**

- The sponsor knows whom they sent the code to. The current claim sends the code
  to the issuer, so the issuer can connect your redemption to that gift.
- The coupon operator can read and revoke the credential it issues
  ([security profiles](../../docs/security.md#current-gift-trial)).
- The issuer and the provider see your IP address unless you use Tor.

**Limits:** the current NEAR route accepts verified out-of-date firmware warnings,
so use synthetic, non-sensitive material. Each release has a claim deadline;
check it in [Redeem a coupon](../../docs/abalone-coupon-redeem.md). On Tails, the
NEAR route currently fails: NVIDIA's attestation service refuses Tor exits
(issue [#15](https://github.com/amiller/abalone/issues/15)).
