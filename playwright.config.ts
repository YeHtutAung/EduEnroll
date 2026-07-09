import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["html", { open: "never" }]],

  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3006",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    viewport: { width: 390, height: 844 },
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } },
    },
  ],

  // Skip local dev server when running against an external base URL (e.g. staging)
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : {
    // No MSW — E2E tests hit the real dev DB via NEXT_PUBLIC_DEV_TENANT
    command: "cross-env NEXT_PUBLIC_DEV_TENANT=e2e-test next dev -p 3006",
    url: "http://localhost:3006",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
