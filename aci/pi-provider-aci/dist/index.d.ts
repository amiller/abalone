/**
 * Private AI Gateway (ACI) provider extension
 *
 * Wires an attested private-ai-gateway into pi as an OpenAI-compatible provider
 * with an instance-scoped, verified ACI transport. This is the
 * vendor-neutral core; branded distributions (pi-provider-redpill,
 * pi-provider-phala-cloud) call createProvider() with their own profile.
 *
 * Usage:
 *   pi install npm:@phala/pi-provider-aci
 *   # Set ACI_API_KEY (+ ACI_BASE_URL) then /model aci/<model-id>
 *
 * Source layout:
 *   src/config.ts        — layered config (default/home/project/env/runtime)
 *   src/project-trust.ts — project-scope config trust gate
 *   src/models.ts        — strict /v1/models mapping into Pi models
 *   src/settings-ui.ts   — SettingsList helpers for the settings command
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type AccountApiKeyAuth, type AciProviderProfile } from "@phala/aci-provider";
import { type AciCloudConfigPatch } from "./src/config.ts";
import { PROVIDER_VERSION } from "./src/constants.ts";
export interface CreatePiAciProviderOptions {
    profile?: Partial<AciProviderProfile>;
    accountAuth?: AccountApiKeyAuth;
    config?: AciCloudConfigPatch;
    footerKey?: string;
}
/**
 * Create a Pi extension from a shared brand profile and optional account auth.
 * The neutral default profile ("aci") is used when no profile is supplied.
 */
export declare function createProvider({ profile: profileOverride, accountAuth, config: overrides, footerKey, }?: CreatePiAciProviderOptions): ExtensionFactory;
declare const _default: ExtensionFactory;
export default _default;
export declare const PROVIDER_ID: string;
export { PROVIDER_VERSION };
export { resolveProfile as getProviderProfile } from "./src/profile.ts";
export { loadAciCloudConfig } from "./src/config.ts";
export { discoverAciModels, mapAciModelToPi, mapAciServerModel } from "./src/models.ts";
export { createAciProvider } from "@phala/aci-provider";
//# sourceMappingURL=index.d.ts.map