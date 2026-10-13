import { discoverAciModelCatalog, mapAciModel, } from "@phala/aci-provider";
import { toAciProviderConfig } from "./config.js";
function piInput(model) {
    const input = model.input.filter((modality) => modality === "text" || modality === "image");
    if (input.length === 0) {
        throw new Error(`Pi does not support the input modalities declared by model "${model.id}"`);
    }
    return input;
}
function piCost(model) {
    return {
        input: model.cost.input,
        output: model.cost.output,
        cacheRead: model.cost.cacheRead ?? model.cost.input,
        cacheWrite: model.cost.cacheWrite ?? model.cost.input,
    };
}
export function mapAciModelToPi(model) {
    return {
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        input: piInput(model),
        cost: piCost(model),
        contextWindow: model.contextWindow,
        maxTokens: model.maxOutputTokens,
        compat: {
            thinkingFormat: "openrouter",
            maxTokensField: "max_tokens",
            supportsStore: true,
            supportsDeveloperRole: true,
            supportsStrictMode: false,
            supportsUsageInStreaming: true,
            supportsLongCacheRetention: false,
        },
    };
}
export function mapAciServerModel(model, config) {
    const mapped = mapAciModel(model, toAciProviderConfig(config));
    return mapped ? mapAciModelToPi(mapped) : null;
}
export async function discoverAciModels(config, options = {}) {
    const catalog = await discoverAciModelCatalog({
        config: toAciProviderConfig({ ...config, baseUrl: options.baseUrl ?? config.baseUrl }),
        fetch: options.fetch ?? globalThis.fetch,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    return {
        raw: [...catalog.raw],
        models: catalog.models.map(mapAciModelToPi),
    };
}
//# sourceMappingURL=models.js.map