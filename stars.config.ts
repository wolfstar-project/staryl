import type { Rolldown } from "tsdown";
import { existsSync, mkdirSync, cpSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import alias from "@rollup/plugin-alias";
import {
	defineConfig,
	readProjectEnvFiles,
} from "@wolfstar/http-framework/config";
import { aliasEntries } from "./scripts/aliases.ts";

// The bot keeps its environment files in src; the CLI otherwise searches the root.
const sourceEnv = readProjectEnvFiles(
	fileURLToPath(new URL("./src", import.meta.url)),
);
const port = process.env["HTTP_PORT"] ?? sourceEnv["HTTP_PORT"] ?? "3000";

function copyLocales(): Rolldown.RolldownPluginOption {
	return {
		name: "copy-locales",
		buildEnd() {
			const source = resolve(import.meta.dirname, "src/locales");
			const destination = resolve(import.meta.dirname, "dist/locales");

			if (existsSync(source)) {
				mkdirSync(destination, { recursive: true });
				cpSync(source, destination, { recursive: true });
				console.log("✓ Copied locales to dist");
			}
		},
	};
}

export default defineConfig({
	entry: "src/main.ts",
	future: { compatibilityVersion: 4 },
	build: {
		tool: "tsdown",
		outDir: "dist",
		tsconfig: "src/tsconfig.json",
	},
	imports: false,
	dev: {
		url: `http://localhost:${port}`,
		env: { NODE_ENV: "development" },
		tunnel: process.env["TUNNEL"] === "1" || process.env["TUNNEL"] === "true",
	},
	codegen: {
		i18n: {
			locales: "src/locales/en-US",
			output: "src/@types/i18next.d.ts",
		},
	},
	tsdown: {
		dts: true,
		plugins: [alias({ entries: aliasEntries }), copyLocales()],
	},
});
