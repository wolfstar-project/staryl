import { fileURLToPath } from "node:url";
import {
	defineConfig,
	readProjectEnvFiles,
} from "@wolfstar/http-framework/config";

// The bot keeps its environment files in src; the CLI otherwise searches the root.
const sourceEnv = readProjectEnvFiles(
	fileURLToPath(new URL("./src", import.meta.url)),
);
const port = process.env["HTTP_PORT"] ?? sourceEnv["HTTP_PORT"] ?? "3000";

export default defineConfig({
	entry: "src/main.ts",
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
});
