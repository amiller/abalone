// SYNTHETIC FIXTURE ONLY (see issuer-hook.mjs): the testing client with the fixture's synthetic quote verifier, whose
// verified synthetic identity is reported under the production evidence status. All offer, claim and delivery checks run.
import { couponAttestedClientForTesting } from "../../lib/coupon-attested.mjs";
export * from "../../lib/coupon-attested.mjs";
const quote = async (hex) => JSON.parse(Buffer.from(hex, "hex").toString());
export async function couponAttestedClient(peerAddr, options, transport) {
  const client = await couponAttestedClientForTesting(peerAddr, { ...options, syntheticQuoteVerifier: quote }, transport);
  return Object.freeze(Object.create(client, { identity: { get: () => client.identity && { ...client.identity, evidenceStatus: "verified-intel-tdx-identity" } } }));
}
