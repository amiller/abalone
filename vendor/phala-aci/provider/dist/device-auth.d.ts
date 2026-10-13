import type { AciFetch } from "@phala/aci-verifier/runtime";
export interface PhalaCloudDeviceAuthorizationOptions {
    baseURL: string;
    clientId: string;
    fetch?: AciFetch;
    signal?: AbortSignal;
}
export interface PhalaCloudDeviceAuthorizationPollOptions {
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
}
export interface PhalaCloudApiKey {
    accessToken: string;
    expiresIn?: number;
    keyId?: number;
}
export interface PhalaCloudDeviceAuthorization {
    userCode: string;
    verificationURI: string;
    expiresIn: number;
    interval: number;
    poll(options?: PhalaCloudDeviceAuthorizationPollOptions): Promise<PhalaCloudApiKey>;
}
export declare function phalaCloudEndpoint(baseURL: string, path: string): URL;
export declare function startPhalaCloudDeviceAuthorization({ baseURL, clientId, fetch, signal, }: PhalaCloudDeviceAuthorizationOptions): Promise<PhalaCloudDeviceAuthorization>;
//# sourceMappingURL=device-auth.d.ts.map