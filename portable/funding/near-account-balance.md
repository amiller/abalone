# Optional NEAR account balance

The fixed direct-NEAR provider record may add exactly
`account: {organizationId, accessToken}`. The organization is a lowercase UUID;
the token is 1–8192 ASCII token characters. Key-only records remain valid and
show unknown credit. Zai records cannot include this field. Neither a wallet
private key nor a refresh token belongs here. A fresh operator-owned account
access token must be imported through trusted enrollment; this slice performs
no login, session refresh, payment or key mutation.

UID 972 rereads this optional field only through the inherited vault lease.
The inference credential getter returns only `apiKey`. A separate fixed GET to
`https://cloud-api.near.ai/v1/organizations/{organizationId}/usage/balance` uses
Tor SOCKS hostname resolution and the existing bounded curl transport; account
tokens stay in curl configuration on stdin. The response must match the owned
organization and contain nonnegative safe integer nanoUSD values. Remaining
nanoUSD is converted with integer arithmetic to nine decimal places, then
projected through the existing authenticated credit socket to UID 971. This is
provider account information, not a per-key allowance, funding proof or spend cap.

The direct-NEAR entry owns one lease for inference and credit. Delegates cannot
release it. Stop/lease abort drains both services, balance requests, and their
transports before the sole release; failed drains withhold graceful release.
An expired access token or failed refresh yields unknown/stale credit without
stopping chat. Lock removes both services. The account is polled once on start
and every minute while the inherited lease is current. No retry, fallback or
synthetic balance is introduced.

Offline tests project file ownership, inject provider responses and service
constructors, and test actual projection/client schemas. They do not qualify
real UID/socket/systemd composition, a live account, or device enrollment.
