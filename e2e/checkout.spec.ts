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
    await expect(page.getByText("5,000").first()).toBeVisible();

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
    await page.waitForURL(`**/checkout/success*`, { timeout: 10_000 });
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
