export interface AciProviderProfile {
    providerId: string;
    label: string;
    defaultBaseURL: string;
    apiKeyEnv: string;
    envPrefix: string;
    logPrefix: string;
    acceptedComposeHashes?: readonly string[];
    acceptedSessionIds?: readonly string[];
}
export declare const DEFAULT_ACI_PROVIDER_PROFILE: AciProviderProfile;
export declare function resolveAciProviderProfile(patch?: Partial<AciProviderProfile>): AciProviderProfile;
//# sourceMappingURL=profile.d.ts.map