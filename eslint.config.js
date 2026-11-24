import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

/* CLAUDE.md rule 3: AI is called only through apps/api/src/providers/ai/client.ts.
   The Bedrock SDK is imported only there; worker jobs call the same client. */
// Exact package names (a bare "ai" pattern would also match our own providers/ai folder).
const otherAiPackages = ["openai", "ai", "langchain", "cohere-ai", "ollama", "@google/generative-ai", "@google/genai"];
const otherAiScopes = ["@anthropic-ai/*", "@ai-sdk/*", "@langchain/*", "@mistralai/*"];
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
      ".claude/worktrees/**",
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
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "no-restricted-imports": [
        "error",
        {
          paths: otherAiPackages.map((name) => ({ name, message: aiMessage })),
          patterns: [{ group: [...otherAiScopes, ...bedrockSdk], message: aiMessage }],
        },
      ],
    },
  },
  {
    files: ["apps/api/src/providers/ai/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: otherAiPackages.map((name) => ({ name, message: aiMessage })),
          patterns: [{ group: otherAiScopes, message: aiMessage }],
        },
      ],
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
