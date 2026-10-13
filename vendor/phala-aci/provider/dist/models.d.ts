import type { AciProviderConfig } from "./config.ts";
import type { AciFetch } from "@phala/aci-verifier/runtime";
export type AciModality = "text" | "audio" | "image" | "video" | "pdf";
export interface AciModel {
    id: string;
    name: string;
    description?: string;
    reasoning: boolean;
    toolCall: boolean;
    temperature: boolean;
    input: readonly AciModality[];
    output: readonly AciModality[];
    cost: {
        input: number;
        output: number;
        cacheRead?: number;
        cacheWrite?: number;
    };
    contextWindow: number;
    maxOutputTokens: number;
}
export interface AciServerModel {
    id?: unknown;
    name?: unknown;
    is_tee?: unknown;
    context_length?: unknown;
    max_output_length?: unknown;
    pricing?: unknown;
    input_modalities?: unknown;
    output_modalities?: unknown;
    supported_features?: unknown;
    supported_parameters?: unknown;
    supported_sampling_parameters?: unknown;
    description?: unknown;
}
export declare class AciModelDiscoveryError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
export declare function mapAciModel(model: AciServerModel, config: AciProviderConfig): AciModel | undefined;
export interface DiscoverAciModelsOptions {
    config: AciProviderConfig;
    fetch: AciFetch;
    signal?: AbortSignal;
    timeoutMs?: number;
}
export interface AciModelCatalog {
    raw: readonly AciServerModel[];
    models: readonly AciModel[];
}
export declare function discoverAciModelCatalog({ config, fetch, signal, timeoutMs, }: DiscoverAciModelsOptions): Promise<AciModelCatalog>;
export declare function discoverAciModels(options: DiscoverAciModelsOptions): Promise<AciModel[]>;
//# sourceMappingURL=models.d.ts.map