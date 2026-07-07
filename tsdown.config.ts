// oxlint-disable no-underscore-dangle
import type { Rolldown } from "tsdown";
import { existsSync, mkdirSync, cpSync } from "node:fs";
import { resolve } from "node:path";
import alias from "@rollup/plugin-alias";
import { defineConfig } from "tsdown";
import { startTunnel } from "untun";
import { aliasEntries } from "./scripts/aliases.ts";

// Plugin to copy locales from src to dist
function copyPlugin(): Rolldown.RolldownPluginOption {
	return {
		name: "copy-mjs-files",
		buildEnd() {
			const srcDir = resolve(import.meta.dirname, "src/locales");
			const distLocalesDir = resolve(import.meta.dirname, "dist/locales");

			if (existsSync(srcDir)) {
				mkdirSync(distLocalesDir, { recursive: true });
				cpSync(srcDir, distLocalesDir, { recursive: true });
				console.log("✓ Copied locales to dist");
			}
		},
	};
}

const isTunnelEnabled =
	process.argv.includes("--tunnel") ||
	process.env["TUNNEL"] === "1" ||
	process.env["TUNNEL"] === "true";

function parsePort(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		console.error(
			`[dev-tunnel] Invalid HTTP_PORT "${value}", falling back to ${String(fallback)}`,
		);
		return fallback;
	}
	return parsed;
}

function startDevTunnel(): Rolldown.RolldownPluginOption {
	let started = false;
	return {
		name: "dev-tunnel",
		async buildEnd() {
			if (!isTunnelEnabled || started) return;
			const port = parsePort(process.env["HTTP_PORT"], 3000);
			try {
				const tunnel = await startTunnel({
					port,
					acceptCloudflareNotice: true,
				});
				if (!tunnel) {
					console.error("[dev-tunnel] Failed to start tunnel");
					return;
				}
				const url = await tunnel.getURL();
				if (!url) {
					console.error("[dev-tunnel] Tunnel started but URL was not assigned");
					return;
				}
				console.log(`✓ Tunnel ready at ${url}`);
				started = true;
			} catch (error) {
				console.error("[dev-tunnel] Tunnel startup failed:", error);
			}
		},
	};
}

export default defineConfig({
	entry: ["src/**/*.ts"],
	format: "esm",
	plugins: [
		alias({ entries: aliasEntries }),
		copyPlugin(),
		...(isTunnelEnabled ? [startDevTunnel()] : []),
	],
	dts: true,
	unbundle: true,
	sourcemap: true,
	minify: false,
	platform: "node",
	tsconfig: "src/tsconfig.json",
	treeshake: true,
	deps: { skipNodeModulesBundle: true },
});
