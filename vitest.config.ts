import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@openai/codex": path.resolve(__dirname, "src/__mocks__/@openai/codex.ts"),
    },
  },
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      ".worktrees/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/tests/**",
        "src/**/interface.ts",
        "src/**/index.ts",
        "src/**/*.d.ts",
        "src/__mocks__/**",
      ],
      all: true,
      thresholds: {
        lines: 85,
        branches: 80,
        functions: 85,
      },
    },
  },
});
