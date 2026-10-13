// Layered configuration for the ACI provider.
//
// Layers, lowest to highest precedence:
//   default  -> home (~/.pi/providers/<id>/config.json)
//            -> project (cwd/.pi/providers/<id>/config.json, gated by
//              project trust)
//            -> env (<PREFIX>_* variables, or brand aliases)
//            -> runtime (programmatic override via createProvider({ config }))
//
// Validation runs after merge so a malformed layer never produces a
// partially-applied config.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, } from "node:fs";
import { dirname, join } from "node:path";
import { aciProviderConfigInputFromEnv, AciProviderConfigError, resolveAciProviderConfig, } from "@phala/aci-provider";
import { DEFAULT_PROFILE } from "./profile.js";
export function toAciProviderConfig(config) {
    return {
        baseURL: config.baseUrl,
        models: config.models,
        trust: config.trust,
        receipts: { verification: "response", historySize: 32 },
    };
}
export const PI_CONFIG_DIR_NAME = ".pi";
export class ConfigError extends Error {
    configPath;
    pointer;
    constructor(message, configPath, pointer) {
        super(pointer ? `${configPath}${pointer}: ${message}` : `${configPath}: ${message}`);
        this.name = "ConfigError";
        this.configPath = configPath;
        this.pointer = pointer;
    }
}
export const DEFAULT_ACI_CLOUD_CONFIG = {
    baseUrl: DEFAULT_PROFILE.defaultBaseURL,
    models: {
        isTeeOnly: true,
    },
    trust: {},
};
function defaultAciCloudConfig(providerProfile) {
    return {
        ...DEFAULT_ACI_CLOUD_CONFIG,
        baseUrl: providerProfile.defaultBaseURL,
        trust: {
            ...(providerProfile.acceptedComposeHashes === undefined
                ? {}
                : { acceptedComposeHashes: [...providerProfile.acceptedComposeHashes] }),
            ...(providerProfile.acceptedSessionIds === undefined
                ? {}
                : { acceptedSessionIds: [...providerProfile.acceptedSessionIds] }),
        },
    };
}
export function getGlobalAciCloudConfigPath(home, providerId = DEFAULT_PROFILE.providerId) {
    return join(home, PI_CONFIG_DIR_NAME, "providers", providerId, "config.json");
}
export function getProjectAciCloudConfigPath(cwd, providerId = DEFAULT_PROFILE.providerId) {
    return join(cwd, PI_CONFIG_DIR_NAME, "providers", providerId, "config.json");
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function mergeConfigPatch(base, patch) {
    const result = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined)
            continue;
        const current = result[key];
        if (isRecord(current) && isRecord(value)) {
            result[key] = mergeConfigPatch(current, value);
        }
        else {
            result[key] = value;
        }
    }
    return result;
}
function readConfigFile(path) {
    if (!existsSync(path))
        return {};
    let contents;
    try {
        contents = readFileSync(path, "utf8");
    }
    catch (error) {
        throw new ConfigError(`failed to read config: ${error instanceof Error ? error.message : String(error)}`, path);
    }
    try {
        const parsed = JSON.parse(contents);
        if (isRecord(parsed))
            return parsed;
        throw new ConfigError("config file must be a JSON object", path);
    }
    catch (error) {
        if (error instanceof ConfigError)
            throw error;
        throw new ConfigError(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`, path);
    }
}
function envConfigPatch(env, providerProfile) {
    const input = aciProviderConfigInputFromEnv(providerProfile, env);
    return {
        ...(input.baseURL !== undefined ? { baseUrl: input.baseURL } : {}),
        ...(input.models ? { models: input.models } : {}),
        ...(input.trust ? { trust: input.trust } : {}),
    };
}
function fail(configPath, pointer, message) {
    throw new ConfigError(message, configPath, pointer);
}
function requireRecord(raw, configPath, pointer) {
    if (isRecord(raw))
        return raw;
    return fail(configPath, pointer, `expected an object, got ${Array.isArray(raw) ? "array" : typeof raw}`);
}
export function validateAciCloudConfig(raw, configPath = "<aci-config>", providerProfile = DEFAULT_PROFILE) {
    const config = requireRecord(raw, configPath, "");
    const models = requireRecord(config.models, configPath, "/models");
    const trust = requireRecord(config.trust, configPath, "/trust");
    for (const [record, field, pointer] of [
        [config, "baseUrl", "/baseUrl"],
        [models, "isTeeOnly", "/models/isTeeOnly"],
    ]) {
        if (!(field in record))
            fail(configPath, pointer, "required field is missing");
    }
    try {
        const resolved = resolveAciProviderConfig(providerProfile, {
            baseURL: config.baseUrl,
            models: {
                isTeeOnly: models.isTeeOnly,
                allowlist: models.allowlist,
            },
            trust: {
                acceptedComposeHashes: trust.acceptedComposeHashes,
                acceptedSessionIds: trust.acceptedSessionIds,
            },
            receipts: { verification: "response", historySize: 32 },
        }, {});
        return {
            baseUrl: resolved.baseURL,
            models: {
                isTeeOnly: resolved.models.isTeeOnly,
                ...(resolved.models.allowlist ? { allowlist: [...resolved.models.allowlist] } : {}),
            },
            trust: {
                ...(resolved.trust.acceptedComposeHashes
                    ? { acceptedComposeHashes: [...resolved.trust.acceptedComposeHashes] }
                    : {}),
                ...(resolved.trust.acceptedSessionIds
                    ? { acceptedSessionIds: [...resolved.trust.acceptedSessionIds] }
                    : {}),
            },
        };
    }
    catch (error) {
        if (!(error instanceof AciProviderConfigError))
            throw error;
        const pointer = error.pointer === "/baseURL" ? "/baseUrl" : error.pointer;
        const detail = error.message.slice(error.pointer.length + 2);
        return fail(configPath, pointer, detail);
    }
}
function loadLayers(options, overrides) {
    const providerProfile = options.profile ?? DEFAULT_PROFILE;
    const layers = [
        readConfigFile(getGlobalAciCloudConfigPath(options.home, providerProfile.providerId)),
    ];
    if (options.includeProject !== false) {
        layers.push(readConfigFile(getProjectAciCloudConfigPath(options.cwd, providerProfile.providerId)));
    }
    layers.push(envConfigPatch(options.env ?? process.env, providerProfile));
    if (overrides) {
        layers.push(overrides);
    }
    return layers;
}
export function loadAciCloudConfig(options, overrides) {
    const providerProfile = options.profile ?? DEFAULT_PROFILE;
    let merged = defaultAciCloudConfig(providerProfile);
    for (const layer of loadLayers(options, overrides)) {
        merged = mergeConfigPatch(merged, layer);
    }
    return validateAciCloudConfig(merged, "<aci-config>", providerProfile);
}
export function loadProjectAciCloudConfig(cwd, providerProfile = DEFAULT_PROFILE) {
    return validateAciCloudConfig(mergeConfigPatch(defaultAciCloudConfig(providerProfile), readConfigFile(getProjectAciCloudConfigPath(cwd, providerProfile.providerId))), "<aci-config>", providerProfile);
}
export function loadHomeAciCloudConfig(home, providerProfile = DEFAULT_PROFILE) {
    return validateAciCloudConfig(mergeConfigPatch(defaultAciCloudConfig(providerProfile), readConfigFile(getGlobalAciCloudConfigPath(home, providerProfile.providerId))), "<aci-config>", providerProfile);
}
export function saveProjectAciCloudConfig(cwd, config, providerId = DEFAULT_PROFILE.providerId) {
    saveAciCloudConfigFile(getProjectAciCloudConfigPath(cwd, providerId), config);
}
export function saveHomeAciCloudConfig(home, config, providerId = DEFAULT_PROFILE.providerId) {
    saveAciCloudConfigFile(getGlobalAciCloudConfigPath(home, providerId), config);
}
function saveAciCloudConfigFile(path, config) {
    mkdirSync(dirname(path), { recursive: true });
    // Atomic write: temp file + rename in the same directory, so a crash or
    // ENOSPC mid-write cannot leave a torn JSON that silently resets settings
    // to defaults on the next read (previously plain writeFileSync).
    const tempPath = `${path}.tmp`;
    try {
        writeFileSync(tempPath, `${JSON.stringify(validateAciCloudConfig(config, path), null, 2)}\n`, "utf8");
        renameSync(tempPath, path);
    }
    catch (error) {
        try {
            unlinkSync(tempPath);
        }
        catch {
            // Cleanup is best-effort; the original file (if any) is left untouched.
        }
        throw new ConfigError(`failed to write config: ${error instanceof Error ? error.message : String(error)}`, path);
    }
}
//# sourceMappingURL=config.js.map