// Live handshake against each admitted provider: §9.1 gate + SPKI pin, no API key needed.
import { createAciProvider } from "../aci/provider/dist/index.js";
import { REDPILL_ACI_PROFILE, PHALA_CLOUD_ACI_PROFILE } from "../aci/provider/dist/profiles.js";

for (const profile of [REDPILL_ACI_PROFILE, PHALA_CLOUD_ACI_PROFILE]) {
  const p = createAciProvider({
    baseURL: profile.defaultBaseURL,
    trust: {},
    models: { isTeeOnly: true },
    receipts: { verification: "response", historySize: 32 },
  });
  try {
    const id = await p.connect();
    console.log(`${profile.providerId}: verified compose=${id.composeHash} spki=${id.tlsSpkiPins.join(",")}`);
    for (const l of id.transcript.lines) console.log(`  ${l.id} ${l.status} ${l.detail}`);
  } catch (e) {
    console.log(`${profile.providerId}: BLOCKED ${e.message}`);
  } finally {
    await p.close();
  }
}
