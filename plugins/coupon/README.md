# Optional coupon acquisition

Have a gift link or paper wallet? This separate entry inspects, redeems or recovers
private inference access without opening an agent or changing Pi settings:

```sh
node plugins/coupon/acquire.mjs --trial /path/to/trial.json
```

Paste the gift privately and read the displayed terms before accepting. A public
bundle matching the gift is still required; use the
[existing redemption procedure](../../docs/abalone-coupon-redeem.md) to obtain it.
This is a source-preview tool, not a new one-download release.

For an interrupted claim, use the saved ID printed by the tool:

```sh
node plugins/coupon/acquire.mjs --recover CREDIT_ID
node plugins/coupon/acquire.mjs --status
```

The tool calls the existing reviewed credit manager directly. It retains the same
original claim keys, locking, expiry checks and recovery records under
`~/.abalone/credit/` or `$ABALONE_DIR/credit/`. It currently needs Linux and flock.
It does not export credentials. Existing NEAR coupon access opens in the included
Dsmack client; a Chutes private-inference integration cannot use that credential.

The launcher remains available during migration. This entry establishes a
separate acquisition workflow; moving all coupon dependencies into an independently
distributed plugin remains [tracked work](https://github.com/amiller/abalone/issues/22).
