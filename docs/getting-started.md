# Start an Abalone incognito session

**Redemption is paused:** the fresh public-installed connection is failing.
Do not redeem until resolved; see the [current friend status](friend-preview.md).

The friend preview uses a gifted coupon to obtain a capped credential for remote
NEAR inference. The [entry skill](../skills/abalone-incognito/SKILL.md) guides a
setup agent through preparing the helper and handing its terminal to you.

**Use synthetic, non-sensitive material only in this preview.** The current
signed debug-staging profile allows issuer-operator access to issued keys and
explicit verified firmware exceptions. Read [security profiles](security.md).
The public friend entry and current signed bundle are still being qualified in
[issue 4](https://github.com/amiller/abalone/issues/4). Do not substitute an old
trial or invent a download URL.

## Supported system

The selected recipient profile is Linux x86_64 with compatible Node 24, bash,
curl, tar, sha256sum and an existing Linux tmpfs, running as an ordinary user
on a trusted owned host. It has no OS isolation: tools have the ordinary account's
filesystem/network access. macOS, Windows, Docker and USB/Tails recipient
profiles are unqualified. No VPN, provider account, manual API key or funded
recipient wallet is required.

The distribution includes the launcher, patched Pi, curated extensions,
verification and broker. A skill installed in stock Pi or Hermes does not add
this runtime. Bubblewrap containment is a separate profile and later milestone;
it is never selected as a fallback from a failed setup.

## Prepare and hand over

The setup agent checks the published profile and prepares the exact reviewed
installer and signed public inputs. It rehearses with synthetic material, ends
its captures and background watchers, then hands you an interactive terminal.
A same-user agent stepping aside is cooperation, not enforced exclusion.

When a current release is qualified, download and inspect its installer and
verify its published checksum before running:

```sh
sh install.sh --friend
```

Enter your coupon only at the hidden terminal prompt. Never put it in a URL,
command argument, environment value, shell history or AI message. Read the
offer before confirming. Keep the same window open during pending delivery;
its recipient keys are needed to receive the credential. A reconciliation error
requires operator help, not another redemption.

## Retention and useful work

Default session-only use needs no trace passphrase and writes no durable managed
conversation trace. To deliberately keep an encrypted trace instead:

```sh
sh install.sh --friend --keep-trace
```

Enter the trace passphrase at its hidden prompt. It protects local retained
traces, not the coupon, and does not change inference encryption or verification.
Keep it if you want to reopen the trace: lost-passphrase recovery is unqualified.
Workspace files, terminal scrollback, swap and host captures are separate from
managed trace retention.

Inside the session, ask a question or select a synthetic plain text file:
`Summarize @notes.txt`, or `@"meeting notes.txt"` for a name with spaces.
The helper reads that file locally and places its text in the encrypted model
request. Do not send its contents to the setup agent. A read/extraction failure
refuses before inference. PDF reading is unqualified in this preview.

## Check state and close

Inference runs remotely at NEAR; a local broker does not make the model local.
Use `/coupon` for session, admission and trust details. A $1 cap is not a
segregated purse, wallet transfer or verified remaining balance. The provider
or sponsor can revoke access and caps can overshoot.

Normal close drops the process's recipient keys and credential references.
It does not revoke the upstream credential or securely erase host memory.
Closed-session credential recovery is unqualified; fresh provider admission in
the same live session uses the same credential and never redeems another coupon.
An inference may already have been charged when its reply fails; do not blindly
repeat it. Closing does not authorize a transcript or summary to the setup agent.

Keep diagnostics deliberate and metadata-only by default. Never post a coupon,
credential, private prompt or raw trace to an issue. Report private concerns
through [the security policy](../SECURITY.md).
