const ACI_MODALITIES = new Set(["text", "audio", "image", "video", "pdf"]);
export class AciModelDiscoveryError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "AciModelDiscoveryError";
    }
}
function invalidModel(id, field, expected) {
    throw new AciModelDiscoveryError(`model "${id}" ${field} must be ${expected}`);
}
function nonEmptyString(value, id, field) {
    if (typeof value !== "string" || value.length === 0) {
        return invalidModel(id, field, "a non-empty string");
    }
    return value;
}
function price(value, id, field) {
    if (typeof value !== "string" && typeof value !== "number") {
        return invalidModel(id, field, "a non-negative number");
    }
    const parsed = Number(value);
    if ((typeof value === "string" && value.trim() === "") ||
        !Number.isFinite(parsed) ||
        parsed < 0) {
        return invalidModel(id, field, "a non-negative number");
    }
    return Math.round(parsed * 1_000_000 * 1_000_000_000) / 1_000_000_000;
}
function modalities(value, id, field) {
    if (!Array.isArray(value) || value.length === 0) {
        return invalidModel(id, field, "a non-empty array of supported modalities");
    }
    return value.map((item) => {
        if (!ACI_MODALITIES.has(item)) {
            return invalidModel(id, field, "an array of supported modalities");
        }
        return item;
    });
}
function positiveInteger(value, id, field) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        return invalidModel(id, field, "a positive safe integer");
    }
    return value;
}
function stringSet(value, id, field) {
    if (!Array.isArray(value))
        return invalidModel(id, field, "an array of strings");
    return new Set(value.map((item) => nonEmptyString(item, id, field)));
}
function pricing(value, id) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return invalidModel(id, "pricing", "an object");
    }
    const raw = value;
    return {
        input: price(raw.prompt, id, "pricing.prompt"),
        output: price(raw.completion, id, "pricing.completion"),
        ...(raw.input_cache_read === undefined
            ? {}
            : { cacheRead: price(raw.input_cache_read, id, "pricing.input_cache_read") }),
        ...(raw.input_cache_write === undefined
            ? {}
            : { cacheWrite: price(raw.input_cache_write, id, "pricing.input_cache_write") }),
    };
}
export function mapAciModel(model, config) {
    const id = nonEmptyString(model.id, "<unknown>", "id");
    if (config.models.isTeeOnly && model.is_tee !== true)
        return undefined;
    if (config.models.allowlist?.length && !config.models.allowlist.includes(id))
        return undefined;
    const contextWindow = positiveInteger(model.context_length, id, "context_length");
    const maxOutputTokens = positiveInteger(model.max_output_length, id, "max_output_length");
    const features = stringSet(model.supported_features, id, "supported_features");
    const sampling = stringSet(model.supported_sampling_parameters, id, "supported_sampling_parameters");
    return {
        id,
        name: nonEmptyString(model.name, id, "name"),
        ...(model.description === undefined
            ? {}
            : { description: nonEmptyString(model.description, id, "description") }),
        reasoning: features.has("reasoning"),
        toolCall: features.has("tools"),
        temperature: sampling.has("temperature"),
        input: modalities(model.input_modalities, id, "input_modalities"),
        output: modalities(model.output_modalities, id, "output_modalities"),
        cost: pricing(model.pricing, id),
        contextWindow,
        maxOutputTokens,
    };
}
export async function discoverAciModelCatalog({ config, fetch, signal, timeoutMs = 10_000, }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const url = new URL(config.baseURL);
        url.pathname = `${url.pathname.replace(/\/$/, "")}/models`;
        const response = await fetch(url, {
            signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
            headers: {
                Accept: "application/json",
            },
        });
        if (!response.ok) {
            throw new AciModelDiscoveryError(`model discovery returned HTTP ${response.status} ${response.statusText}`);
        }
        const value = await response.json();
        if (!value || typeof value !== "object" || !Array.isArray(value.data)) {
            throw new AciModelDiscoveryError("model discovery returned an invalid catalog");
        }
        const raw = value.data.map((model, index) => {
            if (!model || typeof model !== "object" || Array.isArray(model)) {
                throw new AciModelDiscoveryError(`model catalog entry ${index} must be an object`);
            }
            return model;
        });
        const models = raw
            .map((model) => mapAciModel(model, config))
            .filter((model) => model !== undefined);
        const ids = new Set();
        for (const model of models) {
            if (ids.has(model.id)) {
                throw new AciModelDiscoveryError(`model catalog contains duplicate id "${model.id}"`);
            }
            ids.add(model.id);
        }
        return { raw, models };
    }
    catch (error) {
        if (error instanceof AciModelDiscoveryError)
            throw error;
        throw new AciModelDiscoveryError("model discovery failed", { cause: error });
    }
    finally {
        clearTimeout(timeout);
    }
}
export async function discoverAciModels(options) {
    const catalog = await discoverAciModelCatalog(options);
    return [...catalog.models];
}
//# sourceMappingURL=models.js.map