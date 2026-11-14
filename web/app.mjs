// Abalone web agent: a chat agent in one static page with its own wallet. Fund the wallet
// with any token through NEAR Intents; it buys its own NEAR AI account and credit, talks to an attested model with
// end-to-end encryption, and pays per call over x402 for cloud code execution. No accounts, no server of ours.
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import { AgentInterface } from "@pi-components/components/AgentInterface.js";
import { Agent } from "@earendil-works/pi-agent-core";
import { Wallet } from "ethers";
import { createChatStorage } from "./chat-storage.mjs";
import { nearDirectStream } from "./inference.mjs";
import { nearOwnAccount } from "./near-ui.mjs";
import { runCodeTool } from "./tools.mjs";
import { store } from "./wallet-store.mjs";
import { replyFailure } from "./reply-recovery.mjs";

const $ = (id) => document.getElementById(id);
const NEAR_KEYS = ["seed", "session", "key", "activation", "payment"];
const NO_MODEL = { id: "none", name: "No model yet", provider: "near-own", api: "near-direct", baseUrl: "https://cloud-api.near.ai/v1",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 8192 };
const PROMPT = "You are Abalone, a private assistant running in the user's browser. Your model runs in NEAR AI's attested TEE and " +
  "every message is encrypted in the browser to it. You can run short Python or JavaScript with the run_code tool; each " +
  "call is paid from the page's own wallet over x402, so use it when computing beats guessing.";

const cfg = await (await fetch("./config.json")).json();
const storage = createChatStorage();
let wallet = (await store("burner")) && new Wallet(await store("burner"));

const say = (text) => { $("status").textContent = text; };
function render() {
  $("wallet").textContent = wallet?.address || "Your wallet is created when you open Pay once.";
  $("wallet-tools").hidden = !wallet;
  const m = agent.state.model;
  $("model").textContent = m.id === "none" ? "No model yet: pay this page once (above) and it sets up its own NEAR AI account."
    : `${m.name} via NEAR AI · encrypted to the attested model · paid from this page's own account`;
}
async function ensureWallet() {
  if (!await store("burner")) await store("burner", Wallet.createRandom().privateKey);
  wallet = new Wallet(await store("burner"));
  render();
  return wallet;
}
async function evidence(e) {
  $("verified").hidden = false;
  $("evidence").textContent = JSON.stringify(e, null, 2);
}

const agent = new Agent({
  initialState: { systemPrompt: PROMPT, messages: [], thinkingLevel: "off", model: await storage.settings.get("model") || NO_MODEL,
    tools: [runCodeTool({ wallet: ensureWallet, cfg, paid: (p) => { spend.code += Number(p.amount); spend.calls++; showSpend(); say(`Paid ${Number(p.amount) / 1e6} USDC for run_code` +
      (p.settlement?.transaction ? ` (tx ${p.settlement.transaction})` : "")); } })] },
  toolExecution: "sequential",
  getApiKey: (provider) => storage.providerKeys.get(provider),
  streamFn: nearDirectStream({ apiKey: () => storage.providerKeys.get("near-own"), evidence, status: say,
    error: (e) => say(e.message), systemPrompt: ({ runtime }) => PROMPT + "\n\n" + runtime, startedAt: new Date().toString() }),
});
const chat = new AgentInterface();
chat.enableAttachments = false;
chat.enableModelSelector = false;
chat.enableThinkingSelector = false;
chat.onApiKeyRequired = async () => true;
chat.onBeforeSend = async () => {
  say("");
  if (agent.state.model.id === "none") throw new Error("Pay this page once first (above); chat starts when its NEAR AI account is ready.");
};
chat.session = agent;
agent.subscribe((event) => {
  // Pi's message list observes array references; the agent appends in place.
  if (event.type === "message_end" || event.type === "agent_end") { agent.state.messages = [...agent.state.messages]; chat.requestUpdate(); }
  if (event.type === "message_end" && event.message.role === "assistant") {
    say(event.message.failure?.message ?? "");
    if (!event.message.failure) chargedReply().catch((e) => say(e.message));
  }
  // Core 1.4 becomes idle only after its listeners return, so re-render once it has, or the composer stays busy.
  if (event.type === "agent_end") setTimeout(() => chat.requestUpdate());
});
$("chat-host").append(chat);

// What this session spends from the page's own accounts: NEAR AI credit per model call, read back from NEAR AI's
// ledger (nano-USD), and USDC per run_code call over x402.
const spend = { start: undefined, last: undefined, reply: undefined, left: undefined, code: 0, calls: 0 };
const dollars = (nano) => "$" + (nano / 1e9).toFixed(5);
function showSpend() {
  if (spend.left === undefined) return;
  $("spend").textContent = "NEAR AI credit: " + (spend.reply === undefined ? "" : `last model call ${dollars(spend.reply)} · `) +
    `this session ${dollars(spend.last - spend.start)} · ${dollars(spend.left)} left` +
    (spend.calls ? ` | run_code: ${spend.calls} call${spend.calls > 1 ? "s" : ""}, $${(spend.code / 1e6).toFixed(2)} USDC` : "");
}
async function readCredit() {
  const c = await near.credit();
  spend.start ??= c.total_spent; spend.last ??= c.total_spent; spend.left = c.remaining;
  return c;
}
// NEAR AI records usage a few seconds after a reply, so wait for its total to move.
async function chargedReply() {
  const before = spend.last;
  for (let i = 0; i < 12; i++) {
    const c = await readCredit();
    if (c.total_spent !== before) { spend.reply = c.total_spent - before; spend.last = c.total_spent; break; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  showSpend();
}
const near = nearOwnAccount({ $, cfg, ensureWallet, needsModel: () => agent.state.model.id === "none", use: async (model, key) => {
  await storage.providerKeys.set("near-own", key);
  await storage.settings.set("model", model);
  agent.state.model = model;
  render();
} });
const action = (id, fn) => { $(id).onclick = () => fn().catch((e) => say(replyFailure(e).message)); };
action("copy-address", () => navigator.clipboard.writeText(wallet.address));
// Moves this wallet and its NEAR AI account to another origin: a local checkout, an IPFS gateway, another browser.
action("export-wallet", async () => {
  const near = {};
  for (const k of NEAR_KEYS) near[k] = await store("near." + k);
  $("wallet-transfer").hidden = false;
  $("wallet-transfer").value = JSON.stringify({ burner: await store("burner"), near });
});
action("import-wallet", async () => {
  if ($("wallet-transfer").hidden || !$("wallet-transfer").value.trim()) {
    $("wallet-transfer").hidden = false;
    $("wallet-transfer").value = "";
    $("wallet-transfer").placeholder = "Paste an exported wallet, then press Import again. This replaces the wallet in this browser.";
    return;
  }
  const v = JSON.parse($("wallet-transfer").value);
  new Wallet(v.burner);
  await store("burner", v.burner);
  for (const k of NEAR_KEYS) await store("near." + k, v.near?.[k] ?? null);
  await storage.settings.delete("model");
  location.reload();
});
render();
if (agent.state.model.id !== "none") readCredit().then(showSpend, (e) => say(e.message));
// A new visitor starts at the payment; a returning one resumes a pending payment.
if (agent.state.model.id === "none" || await store("near.funding")) $("near-account").open = true;
