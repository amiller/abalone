// Agent tools the page pays for itself over x402, from its own wallet. run_code: Agent402's code runner,
// a fresh cloud sandbox per call (Python or JavaScript, 30 s, no network).
import { x402Fetch } from "./x402.mjs";

export function runCodeTool({ wallet, cfg, payees = new Map(), paid = () => {} }) {
  return {
    name: "run_code", label: "run_code",
    description: `Run a Python or JavaScript snippet in a fresh cloud sandbox and return stdout, stderr and the result. Each call costs up to $${cfg.x402.capUnits / 1e6} USDC, paid from this page's wallet. 30 s limit; no network or files persist.`,
    parameters: { type: "object", additionalProperties: false, required: ["language", "code"], properties: {
      language: { type: "string", enum: ["python", "javascript"] }, code: { type: "string", maxLength: 10000 } } },
    execute: async (_id, args, signal) => {
      const { response, paid: receipt } = await x402Fetch(cfg.x402.codeRun, { method: "POST", signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify({ language: args.language, code: args.code }) },
      { wallet: await wallet(), cap: cfg.x402.capUnits, payees });
      const text = await response.text();
      if (!response.ok) throw new Error(`run_code: HTTP ${response.status} ${text.slice(0, 500)}`);
      if (receipt) paid(receipt);
      const note = receipt ? `\n\n[paid ${Number(receipt.amount) / 1e6} USDC to ${receipt.payTo}${receipt.settlement?.transaction ? ", tx " + receipt.settlement.transaction : ""}]` : "";
      return { content: [{ type: "text", text: text + note }], details: { payment: receipt } };
    },
  };
}
