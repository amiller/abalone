import { type AciProviderConfig } from "@phala/aci-provider";
import { type ProviderProfile } from "./profile.ts";
export interface AciModelsConfig {
    /** Only register models whose /v1/models entry has is_tee === true. */
    isTeeOnly: boolean;
    /** Optional model-id allowlist. When set, only these ids are registered. */
    allowlist?: string[];
}
export interface AciCloudConfig {
    baseUrl: string;
    models: AciModelsConfig;
    trust: {
        /** RTMR3-bound compose hashes reviewed by the operator or brand. */
        acceptedComposeHashes?: string[];
        /** Attested upstream session ids accepted by the operator or brand. */
        acceptedSessionIds?: string[];
    };
}
export declare function toAciProviderConfig(config: AciCloudConfig): AciProviderConfig;
export type AciCloudConfigPatch = {
    baseUrl?: unknown;
    models?: Partial<{
        isTeeOnly: unknown;
        allowlist: unknown;
    }>;
    trust?: Partial<{
        acceptedComposeHashes: unknown;
        acceptedSessionIds: unknown;
    }>;
};
export interface LoadAciCloudConfigOptions {
    cwd: string;
    home: string;
    env?: NodeJS.ProcessEnv;
    includeProject?: boolean;
    profile?: ProviderProfile;
}
export declare const PI_CONFIG_DIR_NAME = ".pi";
export declare class ConfigError extends Error {
    readonly configPath: string;
    readonly pointer?: string;
    constructor(message: string, configPath: string, pointer?: string);
}
export declare const DEFAULT_ACI_CLOUD_CONFIG: AciCloudConfig;
export declare function getGlobalAciCloudConfigPath(home: string, providerId?: string): string;
export declare function getProjectAciCloudConfigPath(cwd: string, providerId?: string): string;
export declare function validateAciCloudConfig(raw: unknown, configPath?: string, providerProfile?: ProviderProfile): AciCloudConfig;
export declare function loadAciCloudConfig(options: LoadAciCloudConfigOptions, overrides?: AciCloudConfigPatch): AciCloudConfig;
export declare function loadProjectAciCloudConfig(cwd: string, providerProfile?: ProviderProfile): AciCloudConfig;
export declare function loadHomeAciCloudConfig(home: string, providerProfile?: ProviderProfile): AciCloudConfig;
export declare function saveProjectAciCloudConfig(cwd: string, config: AciCloudConfig, providerId?: string): void;
export declare function saveHomeAciCloudConfig(home: string, config: AciCloudConfig, providerId?: string): void;
//# sourceMappingURL=config.d.ts.map