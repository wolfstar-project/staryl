import alias from "@rollup/plugin-alias";
import { defineConfig } from "vitest/config";
import { aliasEntries } from "./build/aliases.ts";

export default defineConfig({
	// `enforce: "pre"` ensures this runs before Vite's native package.json
	// "imports" resolution, which would otherwise fail first on the `#i18n/*`
	// nested subpaths that only exist in this alias map (they're rewritten to
	// relative paths at build time by the same plugin in tsdown.config.ts).
	plugins: [{ ...alias({ entries: aliasEntries }), enforce: "pre" }],
	test: {
		environment: "node",
		setupFiles: ["./tests/setup.ts"],
		include: ["tests/**/*.test.ts"],
	},
});
