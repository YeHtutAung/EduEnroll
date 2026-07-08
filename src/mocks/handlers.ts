// src/mocks/handlers.ts
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

  // ── Enrollment PATCH ───────────────────────────────────────────────────────
  http.patch("/api/public/enrollment/:ref", ({ params }) => {
    return HttpResponse.json({ enrollment_ref: params.ref, status: "pending_payment" });
  }),
];
