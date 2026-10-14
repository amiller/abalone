import { assertNearTextToolReply } from "./near-tool-boundary.mjs";
import { decrypt, peerStatus } from "./near.mjs";

const FIELDS = ["content", "reasoning_content", "reasoning"];

// The node appends ": abalone-charge {charge, remaining}" after NEAR's stream. We recompute the charge from
// NEAR's usage and our own price list, and stop the turn if they differ.
// ": abalone-status <text>" from the peer (e.g. "confirming credit" while its next spending window reaches the chain's
// safe head) is shown until the answer starts.
// onNear gets NEAR's own bytes (without the peer's status and charge lines) before [DONE] is released.
// thinkOff: with enable_thinking=false GLM still writes a short thought, then "</think>", into the content (measured on
// NEAR). That prefix is passed on as reasoning, so the answer starts after the marker; with no marker, the buffered
// text is the answer and is sent as content at the end.
export function decryptSse(body, ecdh, price, onCharge, onStatus, onNear, thinkOff = false) {
  const raw = [];
  let pending = "", usage = null, pre = "", split = !thinkOff;
  const dec = new TextDecoder(), enc = new TextEncoder();
  let held = false, charged = false;
  const line = (l) => {
    if (l.endsWith("\r")) l = l.slice(0, -1);
    // SSE permits data: with zero or more spaces. Normalize before inspecting
    // JSON so alternative framing cannot bypass native-tool refusal.
    if (l.startsWith("data:")) l = "data: " + l.slice(5).trimStart();
    // The node's charge line follows NEAR's [DONE]; hold [DONE] back so the client reads (and checks) the charge first.
    if ((price || !split) && l === "data: [DONE]") { held = true; return ""; }
    if (price && l.startsWith(": abalone-charge ")) {
      const c = JSON.parse(l.slice(17));
      if (!usage) throw new Error(`Stopped. NEAR reported no usage for that answer, so its charge (${c.charge} µ$, the most it could have cost) cannot be checked here and nothing more will be sent.`);
      const expect = Math.ceil(usage.prompt_tokens * price.input + usage.completion_tokens * price.output);
      if (c.charge !== expect) throw new Error(`Stopped. The charge for that answer didn't match what was used, so nothing more will be sent.\ndetails: node charged ${c.charge} µ$, usage ${JSON.stringify(usage)} prices to ${expect} µ$`);
      onCharge(c);
      charged = true;
      return l;
    }
    if (l.startsWith(": abalone-status ")) { onStatus?.(peerStatus(l)); return ""; }
    if (!l.startsWith("data: ") || l === "data: [DONE]" || l === "data: ") return l;
    onStatus?.(null);
    const d = JSON.parse(l.slice(6));
    assertNearTextToolReply(d);
    usage = d.usage ?? usage;
    for (const c of d.choices ?? []) for (const f of FIELDS) if (typeof c.delta?.[f] === "string" && c.delta[f]) c.delta[f] = decrypt(c.delta[f], ecdh);
    for (const c of d.choices ?? []) {
      if (split || typeof c.delta?.content !== "string" || !c.delta.content) continue;
      const start = pre.length; pre += c.delta.content;
      const i = pre.indexOf("</think>");
      if (i < 0) { c.delta.reasoning_content = c.delta.content; delete c.delta.content; continue; }
      c.delta.reasoning_content = pre.slice(start, Math.max(start, i));
      c.delta.content = pre.slice(i + "</think>".length);
      split = true;
    }
    return "data: " + JSON.stringify(d);
  };
  return body.pipeThrough(new TransformStream({
    transform(chunk, ctl) {
      if (onNear) raw.push(Buffer.from(chunk));
      pending += dec.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const l of lines) ctl.enqueue(enc.encode(line(l) + "\n"));
    },
    async flush(ctl) {
      if (pending) ctl.enqueue(enc.encode(line(pending)));
      if (!split && pre) ctl.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: pre } }] })}\n\n`));
      if (price && !charged) throw new Error("Stopped. The gift node sent no charge for that answer, so nothing more will be sent.");
      if (onNear) {
        let b = Buffer.concat(raw);
        while (b.subarray(0, 17).toString() === ": abalone-status ") b = b.subarray(b.indexOf("\n\n") + 2);
        await onNear(b.subarray(0, b.lastIndexOf(": abalone-charge ")));
      }
      if (held) ctl.enqueue(enc.encode("data: [DONE]\n\n"));
    },
  }));
}
