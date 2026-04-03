import { defineConfig } from "tsdown";

export default defineConfig({
  entry: "./src/**/*.ts",
  format: "esm",
  tsconfig: "./src/tsconfig.json",
});
