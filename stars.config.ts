import { defineConfig } from "@wolfstar/http-framework/config";

export default defineConfig({
	tsdown: {
		copy: [{ from: "src/locales", to: "dist" }],
	},
});
