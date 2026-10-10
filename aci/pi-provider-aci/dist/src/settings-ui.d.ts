import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SettingsListTheme } from "@earendil-works/pi-tui";
import { type AciCloudConfig } from "./config.ts";
export type AciConfigScope = "project" | "home";
export declare const BOOLEAN_VALUES: readonly ["true", "false"];
export declare function buildSettingsTheme(theme: Theme): SettingsListTheme;
export declare function homeRelative(filePath: string, home?: string): string;
export declare function formatScopeDescription(scope: AciConfigScope, cwd: string, home?: string, providerId?: string): string;
export declare function settingsTitle(label: string): string;
export declare function modelRegistrationSummary(config: AciCloudConfig): string;
//# sourceMappingURL=settings-ui.d.ts.map