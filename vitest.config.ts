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
    // Nested git worktrees live under .claude/worktrees/** and .worktrees/**
    // and carry their own copy of src/__tests__. Those copies are stale by
    // definition, and because "@" resolves to the ROOT src they run old
    // assertions against current source — a duplicate suite that fails for
    // reasons no one is working on. Never collect them.
    exclude: [
      ...configDefaults.exclude,
      "e2e/**",
      "src/__tests__/db/**",
      ".claude/**",
      ".worktrees/**",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
