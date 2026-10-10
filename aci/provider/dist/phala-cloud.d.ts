import type { AciFetch } from "@phala/aci-verifier/runtime";
import type { AccountApiKeyAuth, AccountApiKeyCredential, CompleteAccountApiKeyAuthorizationOptions } from "./account-auth.ts";
export { startPhalaCloudDeviceAuthorization, type PhalaCloudApiKey, type PhalaCloudDeviceAuthorization, type PhalaCloudDeviceAuthorizationOptions, type PhalaCloudDeviceAuthorizationPollOptions, } from "./device-auth.ts";
export declare const DEFAULT_PHALA_CLOUD_API_BASE_URL = "https://cloud-api.phala.com";
export declare function resolvePhalaCloudApiBaseURL(env?: Record<string, string | undefined>): string;
export interface PhalaCloudAccount {
    username?: string;
    workspaceName?: string;
    workspaceSlug?: string;
}
export interface PhalaCloudAccountAuthorizationOptions {
    baseURL: string;
    clientId: string;
    fetch?: AciFetch;
    signal?: AbortSignal;
    accountMetadataTimeoutMs?: number;
}
export interface CompletePhalaCloudAccountAuthorizationOptions extends CompleteAccountApiKeyAuthorizationOptions {
    includeAccountMetadata?: boolean;
}
export type PhalaCloudAccountApiKey = AccountApiKeyCredential;
export interface PhalaCloudAccountAuthorization {
    userCode: string;
    verificationURI: string;
    expiresIn: number;
    interval: number;
    complete(options?: CompletePhalaCloudAccountAuthorizationOptions): Promise<PhalaCloudAccountApiKey>;
}
export interface CreatePhalaCloudAccountAuthOptions {
    label?: string;
    baseURL: string;
    clientId: string;
    fetch?: AciFetch;
    includeAccountMetadata?: boolean;
    accountMetadataTimeoutMs?: number;
}
export interface FetchPhalaCloudAccountOptions {
    baseURL: string;
    apiKey: string;
    fetch?: AciFetch;
    signal?: AbortSignal;
}
export declare function fetchPhalaCloudAccount({ baseURL, apiKey, fetch, signal, }: FetchPhalaCloudAccountOptions): Promise<PhalaCloudAccount>;
export declare function startPhalaCloudAccountAuthorization({ baseURL, clientId, fetch, signal, accountMetadataTimeoutMs, }: PhalaCloudAccountAuthorizationOptions): Promise<PhalaCloudAccountAuthorization>;
export declare function createPhalaCloudAccountAuth({ label, baseURL, clientId, fetch, includeAccountMetadata, accountMetadataTimeoutMs, }: CreatePhalaCloudAccountAuthOptions): AccountApiKeyAuth;
//# sourceMappingURL=phala-cloud.d.ts.map