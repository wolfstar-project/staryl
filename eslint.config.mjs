// @ts-check
import antfu from "@antfu/eslint-config";
import packageJson from "eslint-plugin-package-json";

export default
antfu(
  {
    formatters: true,
    pnpm: true,
    stylistic: {
      indent: 2,
      quotes: "double",
      semi: true,
      jsx: true,
    },
  },
  {
    ignores: [".vscode/**"],
  },
).append({
  files: ["README.md"],
  rules: {
    "format/prettier": ["error", {
      endOfLine: "lf",
      quoteProps: "as-needed",
      singleQuote: true,
      trailingComma: "none",
      parser: "markdown",
      tabWidth: 2,
      useTabs: false,
      printWidth: 80,
      proseWrap: "always",
    }],
  },
}).append({ ...packageJson.configs.recommended, files: ["package.json"], name: "antfu/json/package", rules: {
  "jsonc/sort-keys": "off",
  "jsonc/indent": "off",
} }).append({
  files: ["pnpm-workspace.yaml"],
  name: "antfu/yaml/pnpm-workspace",
  rules: {
    "yaml/sort-keys": [
      "error",
      {
        order: [
          "packages",
          "overrides",
          "patchedDependencies",
          "hoistPattern",
          "catalog",
          "catalogs",

          "allowedDeprecatedVersions",
          "allowNonAppliedPatches",
          "configDependencies",
          "ignoredBuiltDependencies",
          "ignoredOptionalDependencies",
          "neverBuiltDependencies",
          "onlyBuiltDependencies",
          "onlyBuiltDependenciesFile",
          "packageExtensions",
          "peerDependencyRules",
          "supportedArchitectures",
        ],
        pathPattern: "^$",
      },
      {
        order: { type: "asc" },
        pathPattern: ".*",
      },
    ],
  },
}).overrideRules({
  "ts/method-signature-style": "off",
  "ts/no-use-before-define": "off",
  "ts/ban-types": "off",
  "ts/no-empty-object-type": "off",
  "ts/no-explicit-any": "off",
  "vue/comma-dangle": "off",
  "vue/eqeqeq": "off",
  "vue/no-unused-refs": "off",
  "antfu/top-level-function": "off",
  "node/prefer-global/process": "off",
  "eqeqeq": "off",
  "style/no-tabs": "off",
  "no-console": "off",
  "no-debugger": "off",
  "no-async-promise-executor": "off",
  "style/arrow-parens": "off",
});
