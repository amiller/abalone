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
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { createProvider as createPiProvider, } from "@earendil-works/pi-ai";
import { SettingsList, truncateToWidth } from "@earendil-works/pi-tui";
import { createAciProvider, formatAciInspection, inspectAciProvider, } from "@phala/aci-provider";
import os from "node:os";
import { isDeepStrictEqual } from "node:util";
import { loadHomeAciCloudConfig, loadAciCloudConfig, loadProjectAciCloudConfig, saveHomeAciCloudConfig, saveProjectAciCloudConfig, toAciProviderConfig, } from "./src/config.js";
import { createApiKeyAuth } from "./src/auth.js";
import { PROVIDER_VERSION } from "./src/constants.js";
import { DEFAULT_PROFILE, resolveProfile } from "./src/profile.js";
import { mapAciModelToPi } from "./src/models.js";
import { isAciProjectConfigApproved } from "./src/project-trust.js";
import { closeAciProvider, ensureAciConnection, } from "./src/connection.js";
import { buildSettingsTheme, formatScopeDescription, modelRegistrationSummary, settingsTitle, } from "./src/settings-ui.js";
function providerFetch(state) {
    return async (input, init) => {
        await ensureAciConnection(state, () => createAciProvider(toAciProviderConfig(state.config)));
        if (state.provider)
            return state.provider.fetch(input, init);
        throw new Error(`${state.profile.logPrefix} inference blocked because no verified ACI connection is available: ${state.connectionError ?? "verification has not completed"}`);
    };
}
async function refreshAciModels(state, signal) {
    await ensureAciConnection(state, () => createAciProvider(toAciProviderConfig(state.config)));
    if (!state.provider) {
        throw new Error(`${state.profile.logPrefix} model discovery blocked because no verified ACI connection is available: ${state.connectionError ?? "verification has not completed"}`);
    }
    return state.provider.discoverModels({ signal });
}
function toPiModels(state, models) {
    return models.map((model) => ({
        ...mapAciModelToPi(model),
        api: "openai-completions",
        provider: state.profile.providerId,
        baseUrl: state.config.baseUrl,
    }));
}
function nativeAciProvider(state) {
    const streams = openAICompletionsApi();
    const fetch = providerFetch(state);
    return createPiProvider({
        id: state.profile.providerId,
        name: state.profile.label,
        baseUrl: state.config.baseUrl,
        auth: { apiKey: createApiKeyAuth(state.profile, state.accountAuth) },
        models: state.models,
        async fetchModels({ signal }) {
            return toPiModels(state, await refreshAciModels(state, signal));
        },
        api: {
            stream: (model, context, options) => streams.stream(model, context, { ...options, fetch }),
            streamSimple: (model, context, options) => streams.streamSimple(model, context, { ...options, fetch }),
        },
    });
}
function registerAciProvider(pi, state) {
    pi.registerProvider(nativeAciProvider(state));
}
function applyEffectiveConfig(pi, state, cwd, projectTrusted) {
    const config = loadAciCloudConfig({
        cwd,
        home: os.homedir(),
        includeProject: projectTrusted,
        profile: state.profile,
    }, state.overrides);
    if (isDeepStrictEqual(config, state.config))
        return;
    state.config = config;
    registerAciProvider(pi, state);
}
function updateFooter(ctx, state) {
    try {
        ctx.ui.setStatus(state.profile.footerKey, connectionSuffix(state));
    }
    catch {
        // The session may have been replaced/reloaded between an async update and
        // this render; the captured ctx is stale. Nothing to render to.
    }
}
/** Short footer suffix describing the verified transport state. */
function connectionSuffix(state) {
    if (state.provider?.status().phase === "verified")
        return " | aci-verified";
    if (state.connectionError)
        return " | ACI BLOCKED";
    return " | aci: pending";
}
async function openSettingsMenu(pi, ctx, state) {
    const projectTrusted = isAciProjectConfigApproved(ctx);
    const homeDraft = loadHomeAciCloudConfig(os.homedir(), state.profile);
    const drafts = {
        project: projectTrusted ? loadProjectAciCloudConfig(ctx.cwd, state.profile) : homeDraft,
        home: homeDraft,
    };
    let scope = projectTrusted ? "project" : "home";
    let dirty = false;
    await ctx.ui.custom((tui, theme, _keybindings, done) => {
        const settingsTheme = buildSettingsTheme(theme);
        let list;
        const refreshValues = () => {
            list.updateValue("scope", scope);
            list.updateValue("isTeeOnly", drafts[scope].models.isTeeOnly ? "true" : "false");
        };
        const save = () => {
            if (scope === "project" && !projectTrusted) {
                ctx.ui.notify("Project config cannot be saved until the project is trusted.", "warning");
                return;
            }
            try {
                if (scope === "project") {
                    saveProjectAciCloudConfig(ctx.cwd, drafts[scope], state.profile.providerId);
                }
                else {
                    saveHomeAciCloudConfig(os.homedir(), drafts[scope], state.profile.providerId);
                }
                applyEffectiveConfig(pi, state, ctx.cwd, scope === "project" ? true : projectTrusted);
                dirty = true;
            }
            catch (error) {
                ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
            }
        };
        const onChange = (id, newValue) => {
            if (id === "scope") {
                scope = newValue;
                refreshValues();
                return;
            }
            if (id === "isTeeOnly") {
                drafts[scope].models.isTeeOnly = newValue === "true";
                list.updateValue(id, newValue);
                save();
                return;
            }
        };
        const scopeItem = {
            id: "scope",
            label: "Config scope",
            description: projectTrusted
                ? formatScopeDescription(scope, ctx.cwd, os.homedir(), state.profile.providerId)
                : "Project config disabled until the project is trusted; editing home config only",
            currentValue: scope,
            values: projectTrusted ? ["project", "home"] : ["home"],
        };
        const items = [
            scopeItem,
            {
                id: "isTeeOnly",
                label: "TEE-only models",
                description: "Only register models served confidentially (is_tee === true)",
                currentValue: drafts[scope].models.isTeeOnly ? "true" : "false",
                values: ["true", "false"],
            },
        ];
        list = new SettingsList(items, items.length, settingsTheme, onChange, () => done(), {
            enableSearch: true,
        });
        return {
            items,
            onChange,
            render(width) {
                return [
                    truncateToWidth(theme.fg("accent", theme.bold(settingsTitle(state.profile.label))), width),
                    "",
                    truncateToWidth(modelRegistrationSummary(drafts[scope]), width),
                    "",
                    ...list.render(width),
                ];
            },
            handleInput(data) {
                list.handleInput?.(data);
                tui.requestRender();
            },
            invalidate() {
                list.invalidate();
            },
        };
    });
    if (dirty)
        await ctx.reload();
}
async function runInspectionCommand(ctx, state, request) {
    try {
        await ensureAciConnection(state, () => createAciProvider(toAciProviderConfig(state.config)));
        if (!state.provider) {
            throw new Error(state.connectionError ?? "no verified connection is available");
        }
        const result = await inspectAciProvider(state.provider, request);
        ctx.ui.notify(formatAciInspection(result, { providerLabel: state.profile.label }), "info");
    }
    catch (error) {
        ctx.ui.notify(`ACI inspection failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
}
/**
 * Create a Pi extension from a shared brand profile and optional account auth.
 * The neutral default profile ("aci") is used when no profile is supplied.
 */
export function createProvider({ profile: profileOverride, accountAuth, config: overrides, footerKey, } = {}) {
    const providerProfile = resolveProfile({ ...profileOverride, footerKey });
    return async (pi) => {
        const cwd = process.cwd();
        const config = loadAciCloudConfig({ cwd, home: os.homedir(), includeProject: false, profile: providerProfile }, overrides);
        const state = {
            profile: providerProfile,
            config,
            accountAuth,
            models: [],
            provider: undefined,
            providerConfigKey: undefined,
            connectionSetup: undefined,
            connectionError: undefined,
            renderConnectionStatus: undefined,
            overrides,
        };
        // Handshake at load: §9.1 gate and SPKI pin before any model or prompt exists.
        // A provider that fails the gate is refused: none of its models are registered, the error is
        // shown, and the other admitted providers keep working. Requests are never retried elsewhere.
        try {
            await ensureAciConnection(state, () => createAciProvider(toAciProviderConfig(state.config)));
            state.models = toPiModels(state, await state.provider.discoverModels());
        }
        catch (e) {
            const error = `✗ refused: provider ${providerProfile.providerId}: ${e instanceof Error ? e.message : String(e)}`;
            console.error(error);
            pi.on("session_start", async (_event, ctx) => {
                pi.appendEntry("aci-refused", { provider: providerProfile.providerId, error });
                ctx.ui.notify(error, "error");
            });
            return;
        }
        registerAciProvider(pi, state);
        pi.on("session_start", async (_event, ctx) => {
            const identity = state.provider.status().identity;
            pi.appendEntry("aci-attestation", {
                provider: providerProfile.providerId,
                origin: identity.origin,
                verifiedAt: identity.verifiedAt,
                composeHash: identity.composeHash,
                composePinned: Boolean(state.config.trust.acceptedComposeHashes?.length),
                workloadKeysetDigest: identity.workloadKeysetDigest,
                tlsSpkiPins: identity.tlsSpkiPins,
                checks: identity.transcript.lines,
                report: identity.report,
            });
            state.renderConnectionStatus = () => updateFooter(ctx, state);
            state.renderConnectionStatus?.();
            const projectTrusted = isAciProjectConfigApproved(ctx);
            applyEffectiveConfig(pi, state, ctx.cwd, projectTrusted);
            try {
                await ctx.modelRegistry.refresh({
                    providers: [state.profile.providerId],
                });
            }
            finally {
                state.renderConnectionStatus?.();
            }
        });
        pi.on("session_shutdown", async () => {
            state.renderConnectionStatus = undefined;
            await state.connectionSetup?.promise;
            await closeAciProvider(state);
        });
        const settingsCommand = `${state.profile.providerId}-settings`;
        const attestationCommand = `${state.profile.providerId}-attestation`;
        const receiptsCommand = `${state.profile.providerId}-receipts`;
        const receiptCommand = `${state.profile.providerId}-receipt`;
        const sessionCommand = `${state.profile.providerId}-session`;
        pi.registerCommand(settingsCommand, {
            description: `Configure ${state.profile.label} model discovery`,
            handler: async (_args, ctx) => {
                if (ctx.mode !== "tui") {
                    ctx.ui.notify(`${settingsCommand} requires TUI mode`, "error");
                    return;
                }
                try {
                    await openSettingsMenu(pi, ctx, state);
                }
                catch (error) {
                    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
                }
            },
        });
        pi.registerCommand(attestationCommand, {
            description: "Show the cached/current attestation report status",
            handler: async (_args, ctx) => {
                await runInspectionCommand(ctx, state, { action: "attestation" });
            },
        });
        pi.registerCommand(receiptsCommand, {
            description: "List signed ACI receipts retained by this process",
            handler: async (_args, ctx) => {
                await runInspectionCommand(ctx, state, { action: "receipts" });
            },
        });
        pi.registerCommand(receiptCommand, {
            description: "Verify the latest (or a given) signed ACI receipt",
            handler: async (args, ctx) => {
                const id = args?.trim();
                await runInspectionCommand(ctx, state, {
                    action: "receipt",
                    ...(id ? { id } : {}),
                });
            },
        });
        pi.registerCommand(sessionCommand, {
            description: "Show an attested session document (audit trail)",
            handler: async (args, ctx) => {
                const id = args?.trim();
                if (!id) {
                    ctx.ui.notify(`Usage: /${sessionCommand} <session-id>`, "error");
                    return;
                }
                await runInspectionCommand(ctx, state, { action: "session", id });
            },
        });
    };
}
export default createProvider();
export const PROVIDER_ID = DEFAULT_PROFILE.providerId;
export { PROVIDER_VERSION };
export { resolveProfile as getProviderProfile } from "./src/profile.js";
export { loadAciCloudConfig } from "./src/config.js";
export { discoverAciModels, mapAciModelToPi, mapAciServerModel } from "./src/models.js";
export { createAciProvider } from "@phala/aci-provider";
//# sourceMappingURL=index.js.map