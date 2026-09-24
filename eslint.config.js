import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.wrangler/**",
      "**/.pnpm-store/**",
      // scratch HOME used when the machine's real $HOME is not writable
      "**/.sandbox-home/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "apps/worker/worker-configuration.d.ts",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.worker, ...globals.node },
    },
    rules: {
      // Underscore-prefixed parameters are intentional (for example the
      // scheduled handler), never an oversight.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "all" },
      ],
      // Loose equality is a recurring source of security bugs in id/revision
      // comparisons; `== null` stays allowed as the nullish check.
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
      // Any code that logs must be reviewed for secrets rather than banned
      // wholesale; the review rule lives in SECURITY.md.
      "no-console": "off",
    },
  },

  {
    files: ["apps/web/**/*.{ts,tsx}"],
    ...reactHooks.configs.flat.recommended,
  },
  {
    files: ["apps/web/**/*.tsx"],
    ...reactRefresh.configs.recommended,
  },

  {
    files: ["scripts/**/*.mjs", "**/*.config.{js,ts,mjs}"],
    languageOptions: { globals: { ...globals.node } },
  },
);
