// SYNTHETIC FIXTURE ONLY. Stands in for lib/near.mjs#verifyNearModel inside a spawned bin/abalone.mjs
// (loaded by synthetic-near-hook.mjs): no report request, no network, no TDX, GPU or NEAR verdict.
// encrypt/decrypt are the real implementations, so the adapter's end-to-end encryption still runs.
import crypto from "node:crypto";
import fs from "node:fs";
import { encrypt, decrypt } from "../../../lib/near.mjs";
export { encrypt, decrypt, OUT_OF_DATE_TRIAL_POLICY } from "../../../lib/near.mjs";

export async function verifyNearModel() {
  const key = crypto.createECDH("secp256k1"); key.generateKeys();
  // The shape couponNearAdmissionAdvisories requires; fixture constants, not observations.
  const profile = { gateway_tcb_status: "UpToDate", gateway_tcb_advisory_ids: [], model_tcb_statuses: ["UpToDate"], model_tcb_advisory_ids: [[]], gpu: "GPU: NVIDIA verdict (signature checked)" };
  return { signingPublicKey: key.getPublicKey("hex"), profile, transport: { close: async () => {}, fetch: async (url, options) => {
    const body = JSON.parse(options.body), headers = new Headers(options.headers);
    const user = body.messages.filter((m) => m.role === "user").map((m) => decrypt(m.content, key)).join("\n");
    const marker = /SYNTHETIC-CLI-[0-9A-F]{12}/.exec(user)?.[0] ?? null;
    // Facts only, never the credential or the conversation text.
    fs.appendFileSync(process.env.ABALONE_SYNTHETIC_NEAR_LOG, JSON.stringify({ url: String(url), model: body.model, maxTokens: body.max_tokens, chatTemplateKwargs: body.chat_template_kwargs, marker,
      pdfText: user.includes("Notice of Lease Renewal Offer"), plaintextInBody: options.body.includes("Lease Renewal"),
      credentialSha256: crypto.createHash("sha256").update(headers.get("authorization").replace(/^Bearer /, "")).digest("hex") }) + "\n", { mode: 0o600 });
    const answer = encrypt(`SYNTHETIC FIXTURE ANSWER for ${marker}`, headers.get("x-client-pub-key"));
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n`,
      { headers: { "content-type": "text/event-stream" } });
  } } };
}
