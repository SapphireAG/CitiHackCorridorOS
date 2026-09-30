import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    files: ["**/*.ts"],
    ignores: ["**/node_modules/**", "**/dist/**", "**/out/**"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { sourceType: "module" },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      // CLAUDE.md §12: money must never pass through JS floating point. This is a blunt,
      // whole-file ban (not type-aware) — it does not distinguish "Number() on a money field"
      // from "Number() on an already-bigint-computed bps ratio" (see packages/routes/src/**
      // and packages/core/src/fx.ts, which use the latter and are annotated accordingly).
      // A precise type-aware version of this rule is a known gap — see README.
      "no-restricted-globals": ["warn", { name: "parseFloat", message: "Do not use parseFloat on money — use packages/core money.ts/fx.ts (bigint + decimal.js) instead." }],
    },
  },
];
