import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  // tsconfig sets jsx:"preserve" for Next's own compiler, which the test
  // transformer cannot parse — so importing any .tsx from a test fails. This
  // plugin handles the JSX transform for tests only; the Next build is
  // untouched.
  plugins: [react()],
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    // Playwright specs live in e2e/ and import @playwright/test, which is not
    // compatible with the vitest runner — exclude them from `vitest run`.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
