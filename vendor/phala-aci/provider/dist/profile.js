export const DEFAULT_ACI_PROVIDER_PROFILE = {
    providerId: "aci",
    label: "Private AI Gateway",
    defaultBaseURL: "",
    apiKeyEnv: "ACI_API_KEY",
    envPrefix: "ACI",
    logPrefix: "[aci]",
};
export function resolveAciProviderProfile(patch = {}) {
    return {
        ...DEFAULT_ACI_PROVIDER_PROFILE,
        ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
    };
}
//# sourceMappingURL=profile.js.map