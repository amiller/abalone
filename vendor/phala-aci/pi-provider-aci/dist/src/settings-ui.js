// Settings UI helpers for the <provider-id>-settings command. Pure formatting
// and theme adapters; the interactive SettingsList wiring lives in index.ts.
import os from "node:os";
import { relative } from "node:path";
import { getGlobalAciCloudConfigPath, getProjectAciCloudConfigPath, } from "./config.js";
import { PROVIDER_VERSION } from "./constants.js";
export const BOOLEAN_VALUES = ["true", "false"];
export function buildSettingsTheme(theme) {
    return {
        label: (text, selected) => (selected ? theme.fg("accent", text) : text),
        value: (text, selected) => selected ? theme.bold(theme.fg("accent", text)) : theme.fg("muted", text),
        description: (text) => theme.fg("dim", text),
        cursor: theme.fg("accent", "> "),
        hint: (text) => theme.fg("dim", text),
    };
}
export function homeRelative(filePath, home = os.homedir()) {
    const normalizedHome = home.replace(/[\\/]+$/, "");
    if (filePath === normalizedHome)
        return "~";
    const slashPrefix = `${normalizedHome}/`;
    if (filePath.startsWith(slashPrefix))
        return `~/${filePath.slice(slashPrefix.length)}`;
    const backslashPrefix = `${normalizedHome}\\`;
    if (filePath.startsWith(backslashPrefix))
        return `~\\${filePath.slice(backslashPrefix.length)}`;
    return filePath;
}
export function formatScopeDescription(scope, cwd, home = os.homedir(), providerId) {
    const filePath = scope === "project"
        ? getProjectAciCloudConfigPath(cwd, providerId)
        : getGlobalAciCloudConfigPath(home, providerId);
    const displayPath = scope === "home" ? homeRelative(filePath, home) : relative(cwd, filePath);
    return `Writes to the ${scope} config file: ${displayPath}`;
}
export function settingsTitle(label) {
    return `${label} settings (provider v${PROVIDER_VERSION})`;
}
export function modelRegistrationSummary(config) {
    const tee = config.models.isTeeOnly ? "TEE-only" : "all models";
    const allow = config.models.allowlist?.length
        ? `, allowlist: ${config.models.allowlist.length}`
        : "";
    return `Models: ${tee}${allow}`;
}
//# sourceMappingURL=settings-ui.js.map