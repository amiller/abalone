import { type AciProviderProfile } from "@phala/aci-provider";
export interface ProviderProfile extends AciProviderProfile {
    /** Footer/status bar key. */
    footerKey: string;
}
export declare const DEFAULT_PROFILE: ProviderProfile;
/** Resolve a (possibly partial) profile over the neutral defaults. */
export declare function resolveProfile(patch: Partial<ProviderProfile> | undefined): ProviderProfile;
//# sourceMappingURL=profile.d.ts.map