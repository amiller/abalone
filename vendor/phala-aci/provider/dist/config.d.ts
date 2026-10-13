import type { AciProviderProfile } from "./profile.ts";
export type AciReceiptVerification = "on-demand" | "response";
export interface AciProviderConfig {
    baseURL: string;
    models: {
        isTeeOnly: boolean;
        allowlist?: readonly string[];
    };
    trust: {
        acceptedComposeHashes?: readonly string[];
        acceptedSessionIds?: readonly string[];
    };
    receipts: {
        verification: AciReceiptVerification;
        historySize: number;
    };
}
export interface AciProviderConfigInput {
    baseURL?: unknown;
    models?: {
        isTeeOnly?: unknown;
        allowlist?: unknown;
    };
    trust?: {
        acceptedComposeHashes?: unknown;
        acceptedSessionIds?: unknown;
    };
    receipts?: {
        verification?: unknown;
        historySize?: unknown;
    };
}
export declare class AciProviderConfigError extends Error {
    readonly pointer: string;
    constructor(message: string, pointer: string);
}
/** Read the canonical ACI environment variables for any host adapter. */
export declare function aciProviderConfigInputFromEnv(profile: AciProviderProfile, env?: Record<string, string | undefined>): AciProviderConfigInput;
export declare function resolveAciProviderConfig(profile: AciProviderProfile, input?: AciProviderConfigInput, env?: Record<string, string | undefined>): AciProviderConfig;
//# sourceMappingURL=config.d.ts.map