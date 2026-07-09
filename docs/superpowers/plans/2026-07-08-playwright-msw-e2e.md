# Playwright + MSW E2E Tests — Checkout Flow

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set up Playwright with MSW browser service-worker mocking and write E2E tests covering the four payment modes (bank_transfer, mmqr, paypay, stripe) plus the success page variants.

**Architecture:** MSW runs as a browser service worker that intercepts `fetch()` calls to `/api/*` before they reach the Next.js server. A `MSWProvider` client component starts the worker only when `NEXT_PUBLIC_MSW_ENABLED=true`. Playwright launches Next.js on port 3006 with that env var set, so production and the normal dev server (port 3005) are never affected.

**Tech Stack:** `@playwright/test`, `msw@2`, `cross-env`. Handlers defined in `src/mocks/handlers.ts` (reusable from Vitest tests in the future). Tests live in `e2e/`.

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/mocks/fixtures/enrollment.ts` | Typed response payloads for each payment mode (canonical location) |
| Create | `src/mocks/handlers.ts` | MSW `http.*` handler definitions — imports from `src/mocks/fixtures/` |
| Create | `src/mocks/browser.ts` | `setupWorker(handlers)` export used by MSWProvider |
| Create | `src/components/MSWProvider.tsx` | Client component that starts the browser worker when env var set |
| Modify | `src/app/layout.tsx` | Wrap body children with `<MSWProvider>` |
| Create | `playwright.config.ts` | Playwright config — port 3006, mobile viewport, webServer |
| Modify | `package.json` | Add `cross-env`, `test:e2e`, `test:e2e:ui`, `dev:e2e` scripts |
| Create | `e2e/fixtures/enrollment.ts` | Re-exports from `src/mocks/fixtures/enrollment.ts` (convenience alias) |
| Create | `e2e/checkout.spec.ts` | E2E test suite (8 tests) |
| Run | `npx msw init public/` | Generates `public/mockServiceWorker.js` (commit this file) |

---

## Task 1: Install dependencies and generate the MSW service worker

**Files:**
- Modify: `package.json`
- Generate: `public/mockServiceWorker.js` (via msw init)

- [ ] **Step 1: Install packages**

```bash
npm install --save-dev @playwright/test msw cross-env
```

Expected: packages appear in `devDependencies`.

- [ ] **Step 2: Install Playwright browsers**

```bash
npx playwright install chromium
```

Expected: Chromium browser downloaded.

- [ ] **Step 3: Generate MSW service worker**

```bash
npx msw init public/ --save
```

Expected: `public/mockServiceWorker.js` created. The `--save` flag adds `"msw": { "workerDirectory": "public" }` to `package.json`.

- [ ] **Step 4: Verify files exist**

```bash
ls public/mockServiceWorker.js
```

Expected: file present.

- [ ] **Step 5: Commit**

```bash
git add public/mockServiceWorker.js package.json package-lock.json
git commit -m "chore: install playwright, msw, generate service worker"
```

---

## Task 2: MSW handlers and browser setup

**Files:**
- Create: `src/mocks/fixtures/enrollment.ts` (canonical fixtures — inside `src/` so Next.js/tsc can resolve them)
- Create: `e2e/fixtures/enrollment.ts` (thin re-export for convenience in test files)
- Create: `src/mocks/handlers.ts`
- Create: `src/mocks/browser.ts`

- [ ] **Step 0: Create `src/mocks/fixtures/enrollment.ts`**

Note: fixtures live inside `src/` so they are within TypeScript's `rootDir` and can be imported by both `src/mocks/handlers.ts` and `e2e/checkout.spec.ts`. The `BankAccount` interface is declared before `BASE` to avoid forward-reference confusion.

```ts
// src/mocks/fixtures/enrollment.ts

export interface BankAccount {
  bank_name: string;
  account_number: string;
  account_holder: string;
  qr_code_url: string | null;
}

const BASE = {
  status: "pending_payment",
  student_name_en: "E2E Test User",
  email: "e2e@test.com",
  total_amount: 5000,
  items: [{ level: "N3", quantity: 1, fee_amount: 5000 }],
  event_name: "E2E Test Event",
  intake_id: "intake-e2e-001",
  logo_url: null,
  brand_color: null,
  mmqr_provider: null,
  bank_accounts: [] as BankAccount[],
  payment_method: null,
  card_brand: null,
  card_last4: null,
};

const AYA_BANK: BankAccount = {
  bank_name: "AYA Bank",
  account_number: "123456789",
  account_holder: "Nihon Moment Co.",
  qr_code_url: null,
};

export const BANK_TRANSFER_ENROLLMENT = {
  ...BASE,
  enrollment_ref: "E2E-BANK-001",
  payment_mode: "bank_transfer",
  bank_accounts: [AYA_BANK],
};

export const MMQR_ENROLLMENT = {
  ...BASE,
  enrollment_ref: "E2E-MMQR-001",
  payment_mode: "mmqr",
  mmqr_provider: "abank",
};

export const PAYPAY_ENROLLMENT = {
  ...BASE,
  enrollment_ref: "E2E-PAYPAY-001",
  payment_mode: "paypay",
};

export const STRIPE_ENROLLMENT = {
  ...BASE,
  enrollment_ref: "E2E-STRIPE-001",
  payment_mode: "stripe",
  stripe_client_secret: "pi_test_e2e_secret_xyz",
};

export const SUBMITTED_ENROLLMENT = {
  ...BASE,
  enrollment_ref: "E2E-SUBMITTED-001",
  status: "payment_submitted",
  payment_mode: "bank_transfer",
  payment_method: "bank_transfer",
  bank_accounts: [AYA_BANK],
};

export const VERIFIED_ENROLLMENT = {
  ...BASE,
  enrollment_ref: "E2E-VERIFIED-001",
  status: "pending_payment",
  payment_mode: "stripe",
  payment_method: "stripe",
  card_brand: "visa",
  card_last4: "4242",
};

export const FORM_FIELDS = [
  {
    id: "f1",
    field_key: "name_en",
    field_label: "Full Name",
    field_type: "text",
    is_required: true,
    options: null,
    sort_order: 1,
    is_default: true,
  },
  {
    id: "f2",
    field_key: "email",
    field_label: "Email",
    field_type: "email",
    is_required: true,
    options: null,
    sort_order: 2,
    is_default: true,
  },
];
```

- [ ] **Step 0b: Create `e2e/fixtures/enrollment.ts`** (thin re-export)

```ts
// e2e/fixtures/enrollment.ts
// Re-exports from src/mocks/fixtures so E2E specs can use a local-feeling path.
export * from "@/mocks/fixtures/enrollment";
```

- [ ] **Step 1: Create `src/mocks/handlers.ts`**

```ts
// src/mocks/handlers.ts
// MSW request handlers — intercepted in the browser during E2E tests.
// Keyed by enrollment_ref so a single handler serves all payment modes.

import { http, HttpResponse } from "msw";
import {
  BANK_TRANSFER_ENROLLMENT,
  MMQR_ENROLLMENT,
  PAYPAY_ENROLLMENT,
  STRIPE_ENROLLMENT,
  SUBMITTED_ENROLLMENT,
  VERIFIED_ENROLLMENT,
  FORM_FIELDS,
} from "./fixtures/enrollment";

export const handlers = [
  // ── Enrollment summary ─────────────────────────────────────────────────────
  http.get("/api/public/enrollment/:ref", ({ params }) => {
    const ref = params.ref as string;
    const map: Record<string, unknown> = {
      "E2E-BANK-001":      BANK_TRANSFER_ENROLLMENT,
      "E2E-MMQR-001":      MMQR_ENROLLMENT,
      "E2E-PAYPAY-001":    PAYPAY_ENROLLMENT,
      "E2E-STRIPE-001":    STRIPE_ENROLLMENT,
      "E2E-SUBMITTED-001": SUBMITTED_ENROLLMENT,
      "E2E-VERIFIED-001":  VERIFIED_ENROLLMENT,
    };
    const payload = map[ref];
    if (!payload) return new HttpResponse(null, { status: 404 });
    return HttpResponse.json(payload);
  }),

  // ── Form fields ────────────────────────────────────────────────────────────
  http.get("/api/public/form-fields", () => {
    return HttpResponse.json(FORM_FIELDS);
  }),

  // ── Bank transfer upload ───────────────────────────────────────────────────
  http.post("/api/public/payments/upload", () => {
    return HttpResponse.json(
      { payment_id: "pay-e2e-001", status: "pending" },
      { status: 201 },
    );
  }),

  // ── Stripe PaymentIntent create ────────────────────────────────────────────
  http.post("/api/public/payments/stripe/intent", () => {
    return HttpResponse.json({
      clientSecret: "pi_test_e2e_secret_xyz",
      paymentIntentId: "pi_test_e2e_001",
    });
  }),

  // ── Enrollment PATCH (save attendee details) ───────────────────────────────
  http.patch("/api/public/enrollment/:ref", ({ params }) => {
    return HttpResponse.json({ enrollment_ref: params.ref, status: "pending_payment" });
  }),
];
```

- [ ] **Step 2: Create `src/mocks/browser.ts`**

```ts
// src/mocks/browser.ts
import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";

export const worker = setupWorker(...handlers);
```

- [ ] **Step 3: Confirm TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/mocks/
git commit -m "feat(e2e): add MSW handlers and browser worker setup"
```

---

## Task 3: MSWProvider and layout wiring

**Files:**
- Create: `src/components/MSWProvider.tsx`
- Modify: `src/app/layout.tsx:72-87`

The MSWProvider renders `null` until MSW is ready, ensuring no API requests escape before handlers are installed.

- [ ] **Step 1: Create `src/components/MSWProvider.tsx`**

```tsx
// src/components/MSWProvider.tsx
"use client";

import { useEffect, useState } from "react";

export function MSWProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(
    process.env.NEXT_PUBLIC_MSW_ENABLED !== "true",
  );

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_MSW_ENABLED !== "true") return;
    import("@/mocks/browser")
      .then(({ worker }) =>
        worker.start({
          onUnhandledRequest: "bypass",
          serviceWorker: { url: "/mockServiceWorker.js" },
        }),
      )
      .then(() => setReady(true));
  }, []);

  if (!ready) return null;
  return <>{children}</>;
}
```

`ready` starts as `true` in production (skips the `null` flash), and starts as `false` only when `NEXT_PUBLIC_MSW_ENABLED=true`.

- [ ] **Step 2: Modify `src/app/layout.tsx` — wrap body children**

Find this block (lines 79-86):
```tsx
      <body
        className={`${notoSans.variable} ${notoSansMyanmar.variable} ${jetBrainsMono.variable} font-sans antialiased`}
      >
        {children}
        <Analytics />
      </body>
```

Replace with:
```tsx
      <body
        className={`${notoSans.variable} ${notoSansMyanmar.variable} ${jetBrainsMono.variable} font-sans antialiased`}
      >
        <MSWProvider>{children}</MSWProvider>
        <Analytics />
      </body>
```

Also add the import at the top of `layout.tsx`:
```tsx
import { MSWProvider } from "@/components/MSWProvider";
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Verify dev server still works (no MSW)**

```bash
# In a separate terminal
npm run dev
# Open http://localhost:3005 — app loads normally, no MSW active
```

Expected: normal app, no service worker registered.

- [ ] **Step 5: Commit**

```bash
git add src/components/MSWProvider.tsx src/app/layout.tsx
git commit -m "feat(e2e): add MSWProvider, wire into root layout"
```

---

## Task 5: Playwright config and npm scripts

**Files:**
- Create: `playwright.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Create `playwright.config.ts`**

```ts
// playwright.config.ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["html", { open: "never" }]],

  use: {
    baseURL: "http://localhost:3006",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // Mobile-first — mirrors the checkout UI target device
    viewport: { width: 390, height: 844 },
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } },
    },
  ],

  webServer: {
    command: "cross-env NEXT_PUBLIC_MSW_ENABLED=true next dev -p 3006",
    url: "http://localhost:3006",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
```

Note: port 3006 avoids conflict with the regular dev server on 3005.

- [ ] **Step 2: Add scripts to `package.json`**

In the `"scripts"` block, add:
```json
"test:e2e":    "playwright test",
"test:e2e:ui": "playwright test --ui",
"dev:e2e":     "cross-env NEXT_PUBLIC_MSW_ENABLED=true next dev -p 3006"
```

- [ ] **Step 3: Add Playwright output dirs to `.gitignore`**

Add to `.gitignore`:
```
/playwright-report/
/test-results/
```

- [ ] **Step 4: Commit**

```bash
git add playwright.config.ts package.json .gitignore
git commit -m "feat(e2e): add playwright config and npm scripts"
```

---

## Task 6: Write E2E tests

**Files:**
- Create: `e2e/checkout.spec.ts`

Eight tests across two `describe` blocks. Each navigates directly to the relevant page URL (bypassing the full multi-step flow for speed). Note: the `?pi=` query param in `paymentUrl()` is present for API parity but is not used to set `clientSecret` — the client secret comes from the MSW-mocked enrollment API response (`stripe_client_secret` field).

- [ ] **Step 1: Create `e2e/checkout.spec.ts`**

```ts
// e2e/checkout.spec.ts
import { test, expect } from "@playwright/test";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SLUG = "test-event";

function paymentUrl(ref: string) {
  return `/enroll/${SLUG}/checkout/payment/?ref=${ref}&pi=pi_test_e2e_001`;
}

function successUrl(ref: string) {
  return `/enroll/${SLUG}/checkout/success/?ref=${ref}`;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

test.describe("Checkout — payment page", () => {
  test("bank_transfer: shows bank account details and amount", async ({ page }) => {
    await page.goto(paymentUrl("E2E-BANK-001"));

    // Page loads (no spinner)
    await expect(page.getByText("Total due")).toBeVisible({ timeout: 10_000 });

    // Bank account row
    await expect(page.getByText("AYA Bank")).toBeVisible();
    await expect(page.getByText("123456789")).toBeVisible();
    await expect(page.getByText("Nihon Moment Co.")).toBeVisible();

    // Transfer amount callout
    await expect(page.getByText("Transfer exactly")).toBeVisible();
    await expect(page.getByText("5,000")).toBeVisible();

    // Upload UI
    await expect(page.getByText("Upload payment screenshot")).toBeVisible();

    // Submit button starts disabled (no file selected)
    await expect(page.getByRole("button", { name: /SUBMIT PAYMENT PROOF/i })).toBeDisabled();
  });

  test("bank_transfer: upload file and submit redirects to success page", async ({ page }) => {
    await page.goto(paymentUrl("E2E-BANK-001"));
    await expect(page.getByText("Total due")).toBeVisible({ timeout: 10_000 });

    // Attach a file to the hidden input
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "proof.png",
      mimeType: "image/png",
      // 1×1 transparent PNG
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    });

    await expect(page.getByText("1 file selected")).toBeVisible();
    await expect(page.getByRole("button", { name: /SUBMIT PAYMENT PROOF/i })).toBeEnabled();

    // Submit — MSW returns 201, page redirects to success
    await page.getByRole("button", { name: /SUBMIT PAYMENT PROOF/i }).click();
    await page.waitForURL(`**/checkout/success/**`, { timeout: 10_000 });
    expect(page.url()).toContain("E2E-BANK-001");
  });

  test("mmqr: shows Pay via MMQR button", async ({ page }) => {
    await page.goto(paymentUrl("E2E-MMQR-001"));
    await expect(page.getByText("Total due")).toBeVisible({ timeout: 10_000 });

    await expect(page.getByRole("button", { name: /Pay via MMQR/i })).toBeVisible();
    // Should NOT show bank account details
    await expect(page.getByText("Account No.")).not.toBeVisible();
  });

  test("mmqr: clicking Pay via MMQR opens QR modal", async ({ page }) => {
    // QRPaymentModal calls POST /api/public/payments/abank — add a route override
    await page.route("/api/public/payments/abank", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ qr: "00020101021226370014A000000677010111", orderId: "abank-e2e-001" }),
      });
    });

    await page.goto(paymentUrl("E2E-MMQR-001"));
    await expect(page.getByRole("button", { name: /Pay via MMQR/i })).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: /Pay via MMQR/i }).click();

    // Modal appears
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/Generating QR code/i).or(page.getByText(/Pay with MMQR/i))).toBeVisible();
  });

  test("paypay: shows Pay via PayPay button", async ({ page }) => {
    await page.goto(paymentUrl("E2E-PAYPAY-001"));
    await expect(page.getByText("Total due")).toBeVisible({ timeout: 10_000 });

    await expect(page.getByRole("button", { name: /Pay via PayPay/i })).toBeVisible();
  });

  test("stripe: shows CARD and PAYNOW tabs", async ({ page }) => {
    // Stripe JS will fail to load in test — suppress console errors
    page.on("console", () => {});

    await page.goto(paymentUrl("E2E-STRIPE-001"));
    await expect(page.getByText("Total due")).toBeVisible({ timeout: 15_000 });

    await expect(page.getByRole("button", { name: "CARD" })).toBeVisible();
    await expect(page.getByRole("button", { name: "PAYNOW" })).toBeVisible();
  });
});

test.describe("Checkout — success page", () => {
  test("payment_submitted: shows 'Payment proof submitted' heading", async ({ page }) => {
    await page.goto(successUrl("E2E-SUBMITTED-001"));

    await expect(page.getByText("Payment proof submitted")).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText("We'll verify and send your e-ticket shortly"),
    ).toBeVisible();
    await expect(page.getByText("Bank Transfer")).toBeVisible();
  });

  test("verified: shows 'Payment successful' heading and card details", async ({ page }) => {
    await page.goto(successUrl("E2E-VERIFIED-001"));

    await expect(page.getByText("Payment successful")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("E-tickets sent to your email")).toBeVisible();
    // Use a broad pattern to avoid Unicode bullet-character mismatches
    await expect(page.getByText(/Visa.*4242/i)).toBeVisible();
  });
});
```

- [ ] **Step 2: Run E2E tests for the first time (expect failures — server not started yet)**

```bash
npm run test:e2e 2>&1 | head -30
```

Expected: Playwright starts the Next.js server on port 3006. Tests may fail initially if MSW isn't injecting yet — diagnose from the output.

- [ ] **Step 3: Fix any failures**

Common issues to check:
- **MSW not activating**: Open `http://localhost:3006/enroll/test-event/checkout/payment/?ref=E2E-BANK-001` manually and check DevTools → Application → Service Workers. If not registered, check the MSWProvider console.
- **Stripe tab not rendering**: Stripe JS needs a real publishable key. Add `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_fake` to `.env.local` if missing.
- **Timeout on "Total due"**: Increase timeout or check the network tab for failed API calls.

- [ ] **Step 4: Run full suite and verify all pass**

```bash
npm run test:e2e
```

Expected output:
```
Running 8 tests using 1 worker
  ✓ bank_transfer: shows bank account details and amount
  ✓ bank_transfer: upload file and submit redirects to success page
  ✓ mmqr: shows Pay via MMQR button
  ✓ mmqr: clicking Pay via MMQR opens QR modal
  ✓ paypay: shows Pay via PayPay button
  ✓ stripe: shows CARD and PAYNOW tabs
  ✓ payment_submitted: shows 'Payment proof submitted' heading
  ✓ verified: shows 'Payment successful' heading and card details
8 passed
```

- [ ] **Step 5: Commit**

```bash
git add e2e/checkout.spec.ts
git commit -m "feat(e2e): checkout E2E tests — bank_transfer, mmqr, paypay, stripe, success"
```

---

## Task 7: Final wiring — unit tests use same fixtures

The fixtures in `e2e/fixtures/enrollment.ts` can replace the inline payloads in the Vitest unit tests too, but this is optional. Skip unless the team wants unified fixtures.

- [ ] **Step 1 (optional): Import E2E fixtures into enrollment-ref unit test**

In `src/__tests__/api/public/enrollment-ref.test.ts`, the inline payloads for the 200-case tests can be replaced with imports from `e2e/fixtures/enrollment.ts`. The shape is compatible.

- [ ] **Step 2: Run all tests together**

```bash
npm test && npm run test:e2e
```

Expected: all unit tests pass, all E2E tests pass.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "chore(e2e): verify unit + E2E test suites all green"
```

---

## Quick Reference

| Command | Purpose |
|---------|---------|
| `npm run test:e2e` | Run all E2E tests headless |
| `npm run test:e2e:ui` | Open Playwright UI (interactive) |
| `npm run dev:e2e` | Start Next.js on port 3006 with MSW enabled (manual testing) |
| `npm test` | Run Vitest unit tests |
| `npx playwright show-report` | Open last test HTML report |

## Gotchas

- **Port 3006 only**: Playwright uses port 3006 to avoid conflicting with the dev server on 3005. Never run `npm run dev` and `npm run test:e2e` at the same time unless you set `reuseExistingServer: false`.
- **`public/mockServiceWorker.js` must be committed**: MSW requires this file to be served from the same origin. It's stable and safe to commit. **If all tests timeout on "Total due", check that this file exists and is being served at `http://localhost:3006/mockServiceWorker.js`.** A missing file means MSWProvider's `worker.start()` never resolves, leaving the page rendering `null` forever.
- **Stripe Elements won't load in tests**: The Stripe iframe requires a real publishable key and network access. The stripe test only verifies the tab UI renders — it does not submit a payment.
- **MSWProvider null-flash**: When `NEXT_PUBLIC_MSW_ENABLED=true`, the page renders `null` until the service worker activates (~100ms). This is expected in tests and never affects production (where `ready` starts `true`). All test assertions use `{ timeout: 10_000 }` which is ample.
- **`onUnhandledRequest: "bypass"`**: Any API call not matched by a handler passes through to the real Next.js server. This means auth/middleware calls work normally.
- **`cross-env` is needed even on Cygwin**: Playwright spawns `webServer.command` via `cmd.exe` (the Windows system shell), not Cygwin bash. `cross-env` handles the `SET` vs `export` difference. Do not replace it with a bare `export` prefix.
