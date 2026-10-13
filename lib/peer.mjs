// A redeemed gift as a model place (agents/pi/peer-provider.ts): NEAR's attested models reached through the gift's
// peer, which the launcher verified at the libp2p handshake (lib/p2p.mjs giftClient). The client verifies NEAR's
// attestation itself (its own nonce, through the peer) and encrypts every message to the attested model key, so the
// peer relays ciphertext and meters usage: the content's place is NEAR's TEE (◈, lib/config.mjs place). What the peer
// learns: request and answer sizes, timing, the model name and token usage.
// Integrity: TLS ends at the peer, so a reply counts as NEAR's only when NEAR's gateway signature over this exact request
// and reply verifies against the gateway key the client attested (lib/near.mjs chatSignatureFails, checked in
// agents/pi/near-provider.ts); until then the reply is marked unverified and its tool lines never run. The usage the
// charge is recomputed from is covered by that signature, so a verified reply's charge does not rest on the peer.
import fs from "node:fs";
import path from "node:path";
import { STATE } from "./config.mjs";
import { fmt } from "./gift.mjs";

export const GIFT = "gift";
const LEFT = () => path.join(STATE, "gift-left.json");
// The balance the peer last reported for this computer's gift (every charge trailer carries it; redeem writes the first).
export const saveLeft = (account, remaining) => fs.writeFileSync(LEFT(), JSON.stringify({ account, remaining }), { mode: 0o600 });
export function left(c) {
  const l = fs.existsSync(LEFT()) ? JSON.parse(fs.readFileSync(LEFT(), "utf8")) : null;
  if (l?.account !== c.account) throw new Error(`no balance recorded for this computer's gift in ${LEFT()}; redeem it again (a redeemed gift is a no-op) to record it`);
  return l.remaining;
}
// The peer as the handshake verified it (lib/p2p.mjs verifyEvidence place), named as a hop.
const HOPS = { "◈ attested (Mac runner)": "Mac peer", "⌂ dev (unattested)": "unattested dev peer", "◈ attested (App Attest probe; does not cover the peer process)": "Mac peer (probe app)" };
export function placeLabel() {
  const p = process.env.ABALONE_GIFT_PLACE;
  if (!(p in HOPS)) throw new Error(`a gift is set up but the launcher made no attested connection to its peer, or its evidence (${p}) has no label`);
  return `◈ attested (NEAR TEE · via ${HOPS[p]}, which sees ciphertext and metadata)`;
}
export const giftLabel = (c) => `${placeLabel()} · gift ${fmt(left(c))} left`;
