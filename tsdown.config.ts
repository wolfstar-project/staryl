import { existsSync, mkdirSync, cpSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import type { RolldownPluginOption } from "rolldown";
import alias from "@rollup/plugin-alias";

function resolveSource(base: string, subPath: string): string {
  if (subPath.endsWith(".ts")) return resolve(__dirname, base, subPath);
  return resolve(__dirname, base, `${subPath}.ts`);
}

// Plugin to copy .mjs files from src to dist
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
  entry: "./src/**/*.ts",
  format: "esm",
  plugins: [
    alias({
      entries: [
        {
          find: "#lib",
          replacement: "#lib",
          customResolver(source) {
            if (source === "#lib/types")
              return resolve("src/lib/types/index.ts");
            if (source === "#lib/utils/common")
              return resolve("src/lib/common/promises.ts");
            if (source === "#lib/utils/twitch")
              return resolve("src/lib/utilities/twitch.ts");
            if (source === "#lib/utils/util")
              return resolve("src/lib/utilities/util.ts");
            // Handle other #lib/* imports
            const subPath = source.replace("#lib/", "");
            return resolveSource("src/lib", subPath);
          },
        },
        {
          find: "#i18n",
          replacement: "#i18n",
          customResolver(source) {
            if (source === "#i18n/languageKeys")
              return resolve("src/lib/i18n/languageKeys/keys/All.ts");
            if (source === "#i18n") return resolve("src/lib/i18n/index.ts");
            const subPath = source.replace("#i18n/", "");
            return resolveSource("src/lib/i18n", subPath);
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
          find: "#api",
          replacement: "#api",
          customResolver(source) {
            const subPath = source.replace("#api/", "");
            return resolveSource("src/api", subPath);
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
  deps: { neverBundle: ["#generated/prisma"], skipNodeModulesBundle: true },
});
