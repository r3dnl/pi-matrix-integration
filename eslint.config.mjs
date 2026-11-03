// Minimal agreed baseline (story 7): typescript-eslint recommended +
// no-unused-vars + no-floating-promises. No formatter — style stays a
// review matter; the gate blocks on errors only.
//
// Two documented scope choices:
// - `no-undef` is off repo-wide: the TypeScript compiler already resolves
//   every identifier in .ts files, and the Node .mjs scripts run against
//   globals this config does not enumerate. Double-reporting either one is
//   noise; this is typescript-eslint's own guidance for typed projects.
// - test/** runs with the stylistic rules relaxed: test fixtures
//   intentionally carry unused destructure targets and expression
//   assertions. src/ and index.ts are linted at full strictness.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/", "src/qr2025/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { rules: { "no-undef": "off" } },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    files: ["test/**"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-require-imports": "off",
      "no-control-regex": "off",
      "no-useless-assignment": "off",
      "no-empty": "off",
    },
  },
);
