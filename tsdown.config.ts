import { existsSync, mkdirSync, cpSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// oxlint-disable-next-line import/first
import type { RolldownPluginOption } from "rolldown";

// Plugin to copy .mjs files from src to dist
function copyPlugin(): RolldownPluginOption {
  return {
    name: "copy-mjs-files",
    buildEnd() {
      const srcDir = resolve(__dirname, "src/locales");
      const destLocalesDir = resolve(__dirname, "dist/locales");

      if (existsSync(srcDir)) {
        mkdirSync(destLocalesDir, { recursive: true });
        cpSync(srcDir, destLocalesDir, { recursive: true });
        console.log("✓ Copied locales to dist");
      }
    },
  };
}

export default defineConfig({
  entry: "./src/**/*.ts",
  format: "esm",
  plugins: [copyPlugin()],
  dts: true,
  unbundle: true,
  sourcemap: true,
  minify: false,
  platform: "node",
  tsconfig: "src/tsconfig.json",
  treeshake: true,
  skipNodeModulesBundle: true,
});
