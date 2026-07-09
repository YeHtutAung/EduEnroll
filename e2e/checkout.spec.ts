// e2e/checkout.spec.ts
//
// Architecture:
//   Real DB (step 1 form, success page):
//     Enrollment refs seeded by seed-e2e.ts; real API calls hit the staging DB.
//   page.route() mocks (payment page — all payment modes):
//     The enrollment GET is mocked so the UI renders the correct payment mode
//     regardless of the tenant's configured payment_mode. Bank transfer tests
//     also mock the enrollment GET (walmal tenant may use a different mode).
//     Everything else (PATCH, upload, abank QR) hits the real stack.
//
// Run `npm run test:e2e:staging` (seeds then runs) or seed manually first.

import { test, expect } from "@playwright/test";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SLUG = "test-event";

function checkoutUrl(ref: string) {
  return `/enroll/${SLUG}/checkout/?ref=${ref}`;
}

function paymentUrl(ref: string) {
  return `/enroll/${SLUG}/checkout/payment/?ref=${ref}&pi=pi_test_e2e_001`;
}

function successUrl(ref: string) {
  return `/enroll/${SLUG}/checkout/success/?ref=${ref}`;
}

/** Minimal enrollment shape for page.route() mocks (payment mode variety tests). */
const BASE_ENROLLMENT = {
  status: "pending_payment",
  student_name_en: "E2E Test User",
  email: "e2e@test.com",
  total_amount: 5000,
  items: [{ level: "N3", quantity: 1, fee_amount: 5000 }],
  event_name: "E2E Test Event",
  intake_id: "intake-e2e-001",
  logo_url: null,
  brand_color: null,
  bank_accounts: [],
  payment_method: null,
  card_brand: null,
  card_last4: null,
};

/** Bank accounts seeded by seed-e2e.ts — used in bank_transfer payment page mocks. */
const SEEDED_BANK_ACCOUNTS = [
  { bank_name: "AYA", account_number: "100200300", account_holder: "E2E Test Org", qr_code_url: null },
];

// ─── Suite: Checkout step 1 — attendee details ────────────────────────────────

test.describe("Checkout — step 1 (attendee details)", () => {
  // All tests in this block use the real dev DB (E2E-BANK-001, E2E-FORM-NULL-001)

  test("shows order summary and dynamic form fields from DB", async ({ page }) => {
    await page.goto(checkoutUrl("E2E-BANK-001"));

    // Order summary loaded from real DB (use .first() — event name appears in header too)
    await expect(page.getByText("E2E Test Event").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/1 × N3/i)).toBeVisible();

    // Your Details section heading
    await expect(page.getByText("Your Details")).toBeVisible();

    // DynamicField uses placeholder not htmlFor — check by placeholder
    await expect(page.getByPlaceholder("Full Name")).toBeVisible();
    await expect(page.getByPlaceholder("you@example.com")).toBeVisible();
    await expect(page.getByPlaceholder("09xxxxxxxxx")).toBeVisible(); // optional phone field from DB

    await expect(page.getByRole("button", { name: /CONTINUE TO PAYMENT/i })).toBeVisible();
  });

  test("shows default name+email fields when intake_id is null (regression)", async ({ page }) => {
    // E2E-FORM-NULL-001 is a cart enrollment (class_id=null → intake_id=null in API).
    // Before the fix this caused a permanent spinner because form-fields fetch was skipped.
    await page.goto(checkoutUrl("E2E-FORM-NULL-001"));

    await expect(page.getByPlaceholder("Full Name")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByPlaceholder("you@example.com")).toBeVisible();

    // Button must not be stuck in disabled state
    await expect(page.getByRole("button", { name: /CONTINUE TO PAYMENT/i })).not.toBeDisabled();
  });

  test("filling form and submitting navigates to payment page", async ({ page }) => {
    // Mock the Stripe intent call — bank_transfer enrollments don't need Stripe,
    // but the current checkout page always calls it before redirect.
    await page.route("**/api/public/payments/stripe/intent", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ clientSecret: "pi_test_cs_xyz", paymentIntentId: "pi_test_e2e_001" }),
      });
    });

    await page.goto(checkoutUrl("E2E-BANK-001"));
    await expect(page.getByPlaceholder("Full Name")).toBeVisible({ timeout: 15_000 });

    // Fill real form fields from DB
    await page.getByPlaceholder("Full Name").fill("E2E Test User");
    await page.getByPlaceholder("you@example.com").fill("e2e@test.com");

    await page.getByRole("button", { name: /CONTINUE TO PAYMENT/i }).click();

    // PATCH is real — student details saved to dev DB
    // Redirect to payment page after intent mock resolves
    await page.waitForURL("**/checkout/payment*", { timeout: 15_000 });
    expect(page.url()).toContain("E2E-BANK-001");
  });

  test("shows error when ref is not found", async ({ page }) => {
    await page.goto(checkoutUrl("DOES-NOT-EXIST"));

    await expect(page.getByText("Order not found.")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Return to event page")).toBeVisible();
  });
});

// ─── Suite: Checkout payment page ────────────────────────────────────────────

test.describe("Checkout — payment page", () => {
  test("bank_transfer: shows bank account and amount from real DB", async ({ page }) => {
    // Mock enrollment GET — ensures bank_transfer mode regardless of tenant's payment_mode setting
    await page.route("**/api/public/enrollment/E2E-BANK-001", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...BASE_ENROLLMENT,
          enrollment_ref: "E2E-BANK-001",
          payment_mode: "bank_transfer",
          bank_accounts: SEEDED_BANK_ACCOUNTS,
        }),
      }),
    );

    await page.goto(paymentUrl("E2E-BANK-001"));

    await expect(page.getByText("Total due")).toBeVisible({ timeout: 15_000 });

    // Bank account details from SEEDED_BANK_ACCOUNTS (seeded by seed-e2e.ts)
    await expect(page.getByText("AYA")).toBeVisible();
    await expect(page.getByText("100200300")).toBeVisible();

    await expect(page.getByText("Transfer exactly")).toBeVisible();
    await expect(page.getByText("5,000").first()).toBeVisible();
    await expect(page.getByText("Upload payment screenshot")).toBeVisible();

    // Submit disabled until file selected
    await expect(page.getByRole("button", { name: /SUBMIT PAYMENT PROOF/i })).toBeDisabled();
  });

  test("bank_transfer: upload file + submit redirects to success page", async ({ page }) => {
    // Mock enrollment GET — ensures bank_transfer mode regardless of tenant's payment_mode setting
    await page.route("**/api/public/enrollment/E2E-BANK-001", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...BASE_ENROLLMENT,
          enrollment_ref: "E2E-BANK-001",
          payment_mode: "bank_transfer",
          bank_accounts: SEEDED_BANK_ACCOUNTS,
        }),
      }),
    );

    // Mock the upload POST — avoids polluting storage with test files
    await page.route("**/api/public/payments/upload", async (route) => {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ payment_id: "pay-e2e-001", status: "pending" }),
      });
    });

    await page.goto(paymentUrl("E2E-BANK-001"));
    await expect(page.getByText("Total due")).toBeVisible({ timeout: 15_000 });

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "proof.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    });

    await expect(page.getByText("1 file selected")).toBeVisible();
    await expect(page.getByRole("button", { name: /SUBMIT PAYMENT PROOF/i })).toBeEnabled();

    await page.getByRole("button", { name: /SUBMIT PAYMENT PROOF/i }).click();
    await page.waitForURL("**/checkout/success*", { timeout: 15_000 });
    expect(page.url()).toContain("E2E-BANK-001");
  });

  // ── Payment mode UI tests (enrollment API mocked, UI behavior is real) ──────

  test("mmqr: shows Pay via MMQR button", async ({ page }) => {
    await page.route("**/api/public/enrollment/E2E-MMQR-001", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...BASE_ENROLLMENT, enrollment_ref: "E2E-MMQR-001", payment_mode: "mmqr", mmqr_provider: "abank" }),
      }),
    );

    await page.goto(paymentUrl("E2E-MMQR-001"));
    await expect(page.getByText("Total due")).toBeVisible({ timeout: 15_000 });

    await expect(page.getByRole("button", { name: /Pay via MMQR/i })).toBeVisible();
    await expect(page.getByText("Account No.")).not.toBeVisible();
  });

  test("mmqr: clicking Pay via MMQR opens QR modal", async ({ page }) => {
    await page.route("**/api/public/enrollment/E2E-MMQR-001", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...BASE_ENROLLMENT, enrollment_ref: "E2E-MMQR-001", payment_mode: "mmqr", mmqr_provider: "abank" }),
      }),
    );
    await page.route("**/api/public/payments/abank", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ qr: "00020101021226370014A000000677010111", orderId: "abank-e2e-001" }),
      }),
    );

    await page.goto(paymentUrl("E2E-MMQR-001"));
    await expect(page.getByRole("button", { name: /Pay via MMQR/i })).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /Pay via MMQR/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByText(/Generating QR code/i).or(page.getByText(/Pay with MMQR/i)),
    ).toBeVisible();
  });

  test("paypay: shows Pay via PayPay button", async ({ page }) => {
    await page.route("**/api/public/enrollment/E2E-PAYPAY-001", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...BASE_ENROLLMENT, enrollment_ref: "E2E-PAYPAY-001", payment_mode: "paypay" }),
      }),
    );

    await page.goto(paymentUrl("E2E-PAYPAY-001"));
    await expect(page.getByText("Total due")).toBeVisible({ timeout: 15_000 });

    await expect(page.getByRole("button", { name: /Pay via PayPay/i })).toBeVisible();
  });

  test("stripe: shows CARD and PAYNOW tabs", async ({ page }) => {
    // Stub Stripe.js CDN to prevent client-side exception from fake client secret
    await page.route(/js\.stripe\.com/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: `window.Stripe = function() {
          return {
            elements: function() {
              return {
                create: function() { return { mount: function() {}, on: function() {}, unmount: function() {}, destroy: function() {}, update: function() {} }; },
                update: function() {},
                fetchUpdates: async function() { return { error: null }; },
                getElement: function() { return null; },
                submit: async function() { return { error: null }; },
              };
            },
            confirmPayment: async function() { return { error: null }; },
            retrievePaymentIntent: async function() { return { paymentIntent: { status: "requires_payment_method" } }; },
          };
        };`,
      }),
    );

    await page.route("**/api/public/enrollment/E2E-STRIPE-001", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...BASE_ENROLLMENT, enrollment_ref: "E2E-STRIPE-001", payment_mode: "stripe", stripe_client_secret: "pi_test_e2e_secret_xyz" }),
      }),
    );

    await page.goto(paymentUrl("E2E-STRIPE-001"));
    await expect(page.getByText("Total due")).toBeVisible({ timeout: 15_000 });

    await expect(page.getByRole("button", { name: "CARD" })).toBeVisible();
    await expect(page.getByRole("button", { name: "PAYNOW" })).toBeVisible();
  });
});

// ─── Suite: Checkout success page ────────────────────────────────────────────

test.describe("Checkout — success page", () => {
  test("payment_submitted: shows 'Payment proof submitted' and Bank Transfer label", async ({ page }) => {
    await page.goto(successUrl("E2E-SUBMITTED-001"));

    await expect(page.getByText("Payment proof submitted")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("We'll verify and send your e-ticket shortly")).toBeVisible();
    await expect(page.getByText("Bank Transfer")).toBeVisible();
  });

  test("verified: shows 'Payment successful' and Stripe card details", async ({ page }) => {
    await page.goto(successUrl("E2E-VERIFIED-001"));

    await expect(page.getByText("Payment successful")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("E-tickets sent to your email")).toBeVisible();
    await expect(page.getByText(/Visa.*4242/i)).toBeVisible();
  });
});
