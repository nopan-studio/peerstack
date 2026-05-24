/**
 * themeMap.ts — Per-extension default theme assignments
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { basename } from "path";
import { fileURLToPath } from "url";

const THEME_MAP: Record<string, string> = {
	"agent":     "ocean-breeze",
	"minimal":   "synthwave",
};

function extensionName(fileUrl: string): string {
	const filePath = fileUrl.startsWith("file://") ? fileURLToPath(fileUrl) : fileUrl;
	return basename(filePath).replace(/\.[^.]+$/, "");
}

export function applyExtensionTheme(fileUrl: string, ctx: ExtensionContext): boolean {
	if (!ctx.hasUI) return false;
	const name = extensionName(fileUrl);
	const primaryExt = primaryExtensionName();
	if (primaryExt && primaryExt !== name) return true;
	const themeName = THEME_MAP[name] || "synthwave";
	const result = ctx.ui.setTheme(themeName);
	if (!result.success && themeName !== "synthwave") return ctx.ui.setTheme("synthwave").success;
	return result.success;
}

function primaryExtensionName(): string | null {
	const argv = process.argv;
	for (let i = 0; i < argv.length - 1; i++) {
		if (argv[i] === "-e" || argv[i] === "--extension")
			return basename(argv[i + 1]).replace(/\.[^.]+$/, "");
	}
	return null;
}

function applyExtensionTitle(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const name = primaryExtensionName();
	if (!name) return;
	setTimeout(() => ctx.ui.setTitle(`π - ${name}`), 150);
}

export function applyExtensionDefaults(fileUrl: string, ctx: ExtensionContext): void {
	applyExtensionTheme(fileUrl, ctx);
	applyExtensionTitle(ctx);
}
