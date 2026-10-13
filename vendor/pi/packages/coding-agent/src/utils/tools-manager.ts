import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { platform } from "os";
import { join } from "path";
import { getBinDir } from "../config.ts";

// sealed-agent: fd and rg are never downloaded; the only egress is admitted providers.
const TOOLS: Record<"fd" | "rg", { name: string; binaryName: string; systemBinaryNames: string[] }> = {
	fd: { name: "fd", binaryName: "fd", systemBinaryNames: ["fd", "fdfind"] },
	rg: { name: "ripgrep", binaryName: "rg", systemBinaryNames: ["rg"] },
};

function commandExists(cmd: string): boolean {
	return spawnSync(cmd, ["--version"], { stdio: "pipe" }).error === undefined;
}

export function getToolPath(tool: "fd" | "rg"): string | null {
	const config = TOOLS[tool];
	const localPath = join(getBinDir(), config.binaryName + (platform() === "win32" ? ".exe" : ""));
	if (existsSync(localPath)) return localPath;
	return config.systemBinaryNames.find(commandExists) ?? null;
}

export interface ToolStatus {
	type: "info" | "warning";
	message: string;
}

export async function ensureTool(
	tool: "fd" | "rg",
	onStatus?: (status: ToolStatus) => void,
): Promise<string | undefined> {
	const path = getToolPath(tool);
	if (path) return path;
	onStatus?.({
		type: "warning",
		message: `${TOOLS[tool].name} not found. Install it on PATH (sealed builds do not download tools).`,
	});
	return undefined;
}
