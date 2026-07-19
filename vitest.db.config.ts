import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

// ─── Database integration tests ─────────────────────────────────────────────
// Separate from vitest.config.ts so `npm test` does not fail on machines with
// no local Supabase stack, and so these can never run in parallel.
//
// Run with: npm run test:db  (requires the local stack — see setup.ts)

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    globals: true,
    include: ["src/__tests__/db/**/*.test.ts"],
    setupFiles: ["./src/__tests__/db/setup.ts"],

    // Sequential, single process. check_expired_enrollments() is GLOBAL:
    // it sweeps every eligible enrollment across every tenant, so two tests
    // running at once would consume each other's fixtures. Per-test cleanup
    // cannot isolate that — only serialisation can.
    // Vitest 4 removed test.poolOptions — these are top-level now. Using the
    // old shape fails silently: the config is accepted, the warning is easy to
    // miss, and the tests run in parallel anyway.
    fileParallelism: false,
    pool: "forks",
    maxWorkers: 1,
    sequence: { concurrent: false },

    // Fixtures touch several tables through PostgREST; the default 5s is tight.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
