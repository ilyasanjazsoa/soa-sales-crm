import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

/* CLAUDE.md rule 3: AI is called only through apps/api/src/providers/ai/client.ts.
   ARCHITECTURE.md §3: only apps/api/src/providers/ai/ and apps/worker may import the Bedrock SDK. */
const otherAiSdks = [
  "@anthropic-ai/*",
  "openai",
  "@google/generative-ai",
  "@google/genai",
  "ai",
  "@ai-sdk/*",
  "langchain",
  "@langchain/*",
  "cohere-ai",
  "@mistralai/*",
  "ollama",
];
const bedrockSdk = ["@aws-sdk/client-bedrock*"];
const aiMessage = "AI is called only through apps/api/src/providers/ai/client.ts (CLAUDE.md rule 3).";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "playwright-report/**",
      "test-results/**",
      "reference/**",
      "packages/db/migrations/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: [...otherAiSdks, ...bedrockSdk], message: aiMessage }] },
      ],
    },
  },
  {
    files: ["apps/api/src/providers/ai/**", "apps/worker/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: otherAiSdks, message: aiMessage }] }],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { ...tseslint.configs.disableTypeChecked.languageOptions, globals: globals.node },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  prettier,
);
