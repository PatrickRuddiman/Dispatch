import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/tests/**",
        "src/**/interface.ts",
        "src/**/index.ts",
      ],
      thresholds: {
        lines: 80,
      },
    },
  },
});
