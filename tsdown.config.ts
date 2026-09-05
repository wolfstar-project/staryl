// oxlint-disable no-underscore-dangle
import type { Rolldown } from "tsdown";
import { existsSync, mkdirSync, cpSync } from "node:fs";
import { resolve } from "node:path";
import alias from "@rollup/plugin-alias";
import { defineConfig } from "tsdown";
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

export default defineConfig({
	entry: ["src/**/*.ts"],
	format: "esm",
	plugins: [alias({ entries: aliasEntries }), copyPlugin()],
	dts: true,
	unbundle: true,
	sourcemap: true,
	minify: false,
	platform: "node",
	tsconfig: "src/tsconfig.json",
	treeshake: true,
	deps: { skipNodeModulesBundle: true },
});
