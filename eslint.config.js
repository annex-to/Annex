import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/build/**",
      "**/*.js",
      "**/*.cjs",
      "**/*.mjs",
      "!eslint.config.js",
    ],
  },

  // Base JS config
  js.configs.recommended,

  // TypeScript config for all packages
  ...tseslint.configs.recommended,

  // Global settings for all TypeScript files
  {
    files: ["packages/**/*.ts", "packages/**/*.tsx"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    rules: {
      // Relax some rules for practicality
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-empty-object-type": "off",
      "no-useless-escape": "warn",
      "prefer-const": "warn",
    },
  },

  // React-specific config for client package
  {
    files: ["packages/client/**/*.tsx", "packages/client/**/*.ts"],
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooksPlugin,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      "react/react-in-jsx-scope": "off", // Not needed with React 17+
      "react/prop-types": "off", // Using TypeScript
      "react/no-unescaped-entities": "off", // Too strict for quotes in text
      "react-hooks/exhaustive-deps": "warn", // Keep as warning, not error
    },
  }
);
