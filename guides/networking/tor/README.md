Status: todo

# Tor

Abalone does not hide your IP address
([getting started](../../../docs/getting-started.md#supported-system)). A
contributor writing this guide should answer:

- What does each observer see with and without Tor: the coupon issuer, the
  inference provider, the provider's attestation services, your network operator?
- Which steps of a session work over Tor today, and which fail? (NVIDIA's
  attestation service refuses Tor exits, which blocks the NEAR route; see issue
  [#15](https://github.com/amiller/abalone/issues/15).)
- How do you route a single program through Tor on Linux, and how do you check
  that nothing bypasses it?
- When is Tails the better choice than Tor on an ordinary system?
- What does Tor not hide: timing, usage volume, the payment that funded the credit?
