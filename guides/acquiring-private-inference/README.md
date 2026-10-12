Status: draft

# Acquiring private inference

A session needs model access that a verified provider accepts. How you pay for
that access decides what the payment links to you. Each route below says what
you need, what an observer can connect, and whether it works with Abalone today.

The `abalone` session uses access delivered by a coupon. A key bought
directly from a provider can be saved, but only the developer session
`abalone sandbox` uses it so far (see [Configure your own key](#configure-your-own-key)
and issue [#21](https://github.com/amiller/abalone/issues/21)).

| Route | Works with Abalone today | What is linked |
| --- | --- | --- |
| [Abalone coupon](#abalone-coupon) | Yes, preview releases; synthetic material only | The sponsor knows who they gave the code to; the issuer sees the code at redemption; your IP address |
| [Provider key bought directly](#configure-your-own-key) (card or crypto top-up) | `abalone sandbox` only | The provider account, and the card or paying wallet's history |
| Zcash payment for a coupon | No. Not released | Not yet described; needs current verification before it is published |

Routes that do not qualify: services that pay for inference privately but then
forward plaintext to an ordinary API, or that do not verify a TEE, give you
payment privacy and no inference privacy.

Rules that apply to every route:

- Wallet seeds, spending keys and payment QR codes never go to a coding agent.
  Pay from your own wallet, outside the agent's view.
- A gift code goes to the redeem command on standard input, never in a command
  argument, URL query, environment variable or public log ([redeem](../../docs/abalone-coupon-redeem.md#inspect-redeem-and-save-access)).
- A fresh wallet funded from an exchange account is not anonymous. Neither is a
  transparent deposit followed by a matching withdrawal.
- Connect from Tor if the network address matters (see
  [private inference](../private-inference/README.md)).

## Abalone coupon

Someone who already has access gives you a coupon, usually as a gift link. You
redeem it with an issuer on the Dsmack network, which delivers a model credential
encrypted to keys generated on your computer. Follow
[Redeem a coupon](../../docs/abalone-coupon-redeem.md).

**You need:** Linux x86_64, Node 24 and the listed system tools. No VPN,
provider account, manual API key or funded wallet
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

## Configure your own key

Buy access from a provider listed in [providers.json](../../providers.json)
(`admitted`), then save its API key:

```sh
abalone key add nearai                  # paste the key at the hidden prompt
abalone key add chutes --label work --input-file /abs/chutes-key.txt   # or a 0600 file
abalone key list                        # provider, label, added, last used; never the key
abalone key forget chutes --label work
```

The key is never a command argument. Abalone checks it with one authenticated
call that carries no prompt, then saves it as a 0600 file in its credit store.
`abalone sandbox --model <provider>/<model>` gives the session that provider's
most recently added key and verifies the provider's attestation before any
prompt is sent, as for any admitted provider. The plain `abalone` session does not use
configured keys yet.

**What is linked:** the provider account and how you paid for it; the provider
sees every request's size and timing and your IP address unless you use Tor.

**Limits:** there is no local spending cap; the provider's limit applies. Abalone
does not verify the provider's attestation when you add the key, only in the
session.
