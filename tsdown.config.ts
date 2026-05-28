// oxlint-disable no-underscore-dangle
import type { RolldownPluginOption } from "rolldown";
import { existsSync, mkdirSync, cpSync } from "node:fs";
import { resolve } from "node:path";
import alias from "@rollup/plugin-alias";
import { defineConfig } from "tsdown";

function resolveSource(base: string, subPath: string): string {
	if (subPath.endsWith(".ts"))
		return resolve(import.meta.dirname, base, subPath);
	const direct = resolve(import.meta.dirname, base, `${subPath}.ts`);
	if (existsSync(direct)) return direct;
	return resolve(import.meta.dirname, base, subPath, "index.ts");
}

// Plugin to copy locales from src to dist
function copyPlugin(): RolldownPluginOption {
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
	plugins: [
		alias({
			entries: [
				{
					find: "#lib",
					replacement: "#lib",
					customResolver(source) {
						const subPath = source.replace("#lib/", "");
						return resolveSource("src/lib", subPath);
					},
				},
				{
					find: "#generated/prisma",
					replacement: resolve(
						import.meta.dirname,
						"src/generated/prisma/client.ts",
					),
				},
				{
					find: "#i18n",
					replacement: "#i18n",
					customResolver(source) {
						if (source === "#i18n")
							return resolve(import.meta.dirname, "src/lib/i18n/index.ts");
						const subPath = source.replace("#i18n/", "");
						return resolveSource("src/lib/i18n", subPath);
					},
				},
				{
					find: "#api",
					replacement: "#api",
					customResolver(source) {
						const subPath = source.replace("#api/", "");
						return resolveSource("src/api", subPath);
					},
				},
				{
					find: "#common",
					replacement: "#common",
					customResolver(source) {
						const subPath = source.replace("#common/", "");
						return resolveSource("src/lib/common", subPath);
					},
				},
				{
					find: "#utils",
					replacement: "#utils",
					customResolver(source) {
						const subPath = source.replace("#utils/", "");
						return resolveSource("src/lib/utilities", subPath);
					},
				},
			],
		}),
		copyPlugin(),
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
