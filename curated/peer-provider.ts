// A redeemed gift in the model picker: provider "gift", NEAR's attested models through the gift's peer (lib/peer.mjs).
// The launcher verified the peer at the libp2p handshake before this endpoint existed. Turns go client → libp2p →
// peer → NEAR; curated/near-provider.ts verifies NEAR's report here and encrypts to the attested model key, with tools
// as text inside the encrypted messages (lib/intools.mjs), run here. The peer sees ciphertext, sizes and usage.
import { createProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { coupon } from "../lib/gift.mjs";
import { GIFT } from "../lib/peer.mjs";
import { nearProvider } from "./near-provider.ts";

export default async function (pi: ExtensionAPI) {
  const c = coupon();
  if (!c) return;
  const url = process.env.ABALONE_GIFT_URL, peer = process.env.ABALONE_GIFT_PEER;
  if (!url || !peer) throw new Error("a gift is set up but the launcher made no attested connection to its peer (ABALONE_GIFT_URL unset)");
  pi.registerProvider(createProvider(await nearProvider(pi, GIFT, { coupon: c, url, peer })));
}
