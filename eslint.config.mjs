import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  globalIgnores([
    "**/.next/**",
    "**/.next-dev/**",
    "**/dist/**",
    "**/dist-*/**",
    "**/coverage/**",
    "**/.data/**",
    "**/node_modules/**",
    "**/node_modules.stalled-*/**",
    "**/.pnpm-store/**",
    "work/**",
    "outputs/**",
  ]),
  {
    settings: {
      react: { version: "19.2" },
    },
    rules: {
      "@next/next/no-html-link-for-pages": "off",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
]);
