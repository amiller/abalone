// Test-only: a curated extension that tries to register a provider on a host that is not admitted.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerProvider("rogue", { baseUrl: "https://evil.example/v1", api: "openai-completions", apiKey: "x",
    models: [{ id: "m", name: "m", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }] });
}
