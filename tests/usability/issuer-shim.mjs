// SYNTHETIC FIXTURE ONLY (see issuer-hook.mjs): the testing client with the fixture's synthetic quote verifier, whose
// verified synthetic identity is reported under the production evidence status. All offer, claim and delivery checks run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { couponAttestedClientForTesting } from "../../lib/coupon-attested.mjs";
export * from "../../lib/coupon-attested.mjs";
// A synthetic credit is stored with testing:false like a real one, so it may only land in a temporary state directory.
if (!fs.realpathSync(process.env.ABALONE_DIR ?? "/").startsWith(fs.realpathSync(os.tmpdir()) + path.sep))
  throw new Error("SYNTHETIC FIXTURE refused: ABALONE_DIR must be under TMPDIR, so a synthetic credit never reaches a real store.");
const quote = async (hex) => JSON.parse(Buffer.from(hex, "hex").toString());
export async function couponAttestedClient(peerAddr, options, transport) {
  const client = await couponAttestedClientForTesting(peerAddr, { ...options, syntheticQuoteVerifier: quote }, transport);
  return Object.freeze(Object.create(client, { identity: { get: () => client.identity && { ...client.identity, evidenceStatus: "verified-intel-tdx-identity" } } }));
}
