import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/services/crypto.ts", "src/services/secrets.ts", "src/routers/secrets.ts"],
    },
    setupFiles: ["./src/__tests__/setup.ts"],
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
