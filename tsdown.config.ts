// oxlint-disable no-underscore-dangle
import type { RolldownPluginOption } from "rolldown";
import { existsSync, mkdirSync, cpSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import alias from "@rollup/plugin-alias";
import { defineConfig } from "tsdown";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveSource(base: string, subPath: string): string {
	if (subPath.endsWith(".ts")) return resolve(__dirname, base, subPath);
	const direct = resolve(__dirname, base, `${subPath}.ts`);
	if (existsSync(direct)) return direct;
	return resolve(__dirname, base, subPath, "index.ts");
}

// Plugin to copy locales from src to dist
function copyPlugin(): RolldownPluginOption {
	return {
		name: "copy-mjs-files",
		buildEnd() {
			const srcDir = resolve(__dirname, "src/locales");
			const distLocalesDir = resolve(__dirname, "dist/locales");

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
					replacement: resolve(__dirname, "src/generated/prisma/client.ts"),
				},
				{
					find: "#i18n",
					replacement: "#i18n",
					customResolver(source) {
						if (source === "#i18n")
							return resolve(__dirname, "src/lib/i18n/index.ts");
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
	dts: false,
	unbundle: true,
	sourcemap: true,
	minify: false,
	platform: "node",
	tsconfig: "src/tsconfig.json",
	treeshake: true,
	deps: { skipNodeModulesBundle: true },
});
