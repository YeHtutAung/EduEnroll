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
    //
    // src/__tests__/db/** needs a running local Supabase stack and must run
    // sequentially, so it has its own config (vitest.db.config.ts) and is
    // excluded here. Otherwise `npm test` would fail on any machine without
    // the stack.
    exclude: [...configDefaults.exclude, "e2e/**", "src/__tests__/db/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
