import type { Api, Model } from "@earendil-works/pi-ai";
import { type AciModel, type AciServerModel } from "@phala/aci-provider";
import { type AciCloudConfig } from "./config.ts";
export type AciPiModel = Omit<Model<"openai-completions">, "api" | "provider" | "baseUrl">;
export declare function mapAciModelToPi(model: AciModel): AciPiModel;
export declare function mapAciServerModel(model: AciServerModel, config: AciCloudConfig): AciPiModel | null;
export interface DiscoverAciModelsOptions {
    timeoutMs?: number;
    baseUrl?: string;
    fetch?: typeof globalThis.fetch;
    signal?: AbortSignal;
}
export interface DiscoverAciModelsResult {
    models: AciPiModel[];
    raw: AciServerModel[];
}
export declare function discoverAciModels(config: AciCloudConfig, options?: DiscoverAciModelsOptions): Promise<DiscoverAciModelsResult>;
export type { AciServerModel };
export type AnyModel = Model<Api>;
//# sourceMappingURL=models.d.ts.map