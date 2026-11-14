// A NEAR AI Cloud model from GET /v1/models, called directly with this page's own account key.
export function nearOwnModel(m) {
  return { id: m.id, name: m.name, provider: "near-own", api: "near-direct", baseUrl: "https://cloud-api.near.ai/v1",
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.context_length, maxTokens: 8192 };
}
