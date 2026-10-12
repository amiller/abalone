Status: draft

# Private inference

Start with what an ordinary hosted model sees. You open an account, add a card,
and send prompts over TLS to the provider's API. The provider decrypts each
request on its own servers. Its operators, its logging pipeline, anyone who
compels it to hand over records, and anyone who breaches it can read your
prompts and answers, and the account ties all of it to your name and card.

TEE private inference removes the first part. The model runs inside a trusted
execution environment, and the client checks a signed attestation report before
it sends anything: which code is running, on which hardware, with which GPU
evidence. The request is encrypted to a key held inside that environment. The
provider's operators handle ciphertext. Abalone checks provider and model
attestation before the first prompt byte and refuses a provider that fails it
([security profiles](../../docs/security.md#current-gift-trial)). The current
NEAR route is an exception for synthetic material: it accepts cryptographically
verified `OutOfDate` firmware with a warning before any effect, and strong
private guarantees are unqualified under that exception.

Attestation does not hide the rest. Look at it from the provider's side: it
still sees when you connect, from which IP address, how much you use, and which
account or credit paid for it. EFF calls this [metadata](https://ssd.eff.org/module/why-metadata-matters),
and it is often enough to identify a person. Two choices control most of it:

- **How the credit was paid for.** A card or KYC exchange account links your
  identity to the credit. See [acquiring private inference](../acquiring-private-inference/README.md).
- **Which network you connect from.** Abalone does not hide your IP address
  ([getting started](../../docs/getting-started.md#supported-system)). Tor does;
  [Tails](https://tails.net/about/index.en.html) runs everything through it.
  EFF's [Tor guide](https://ssd.eff.org/module/how-to-use-tor) explains what
  that protects. See [networking: Tor](../networking/tor/README.md).

Which of these you need depends on who you are protecting against. EFF's
[security plan](https://ssd.eff.org/module/your-security-plan) walks through
that question. Answer it before choosing a funding route: an anonymous payment
does little if you then connect from your home address, and Tor does little if
the credit was bought with your card.

Further reading on attestation for private inference:
[Bednár](https://juraj.bednar.io/en/blog-en/2026/08/11/hardware-attestation-for-private-ai-inference/),
[Confer](https://confer.to/blog/2026/01/private-inference/).
