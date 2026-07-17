import { describe, it, expect } from "vitest";
import { verifyEnquiry } from "@/lib/abank";
import type { EnquiryData } from "@/lib/abank";

// The ABank callback is a public, unauthenticated GET whose query params are
// attacker-controlled: /api/public/payments/abank returns the orderId to the
// student when the QR is created, so anyone can replay the callback URL with
// status=SUCCESS. Only the enquiry response — fetched server-to-server from
// ABank — may decide whether a payment succeeded. These tests pin that.

const expected = { orderId: "AB-ABC123-999", amountMmk: 50000 };

function enquiry(over: Partial<EnquiryData> = {}): EnquiryData {
  return { paymentTxnStatus: 200, orderId: expected.orderId, amount: 50000, ...over };
}

describe("verifyEnquiry — success", () => {
  it("confirms when ABank reports success for the right order and amount", () => {
    expect(verifyEnquiry(enquiry(), expected)).toEqual({
      outcome: "success",
      transactionId: undefined,
      institutionName: undefined,
    });
  });

  it("passes through the provider's transaction details", () => {
    const result = verifyEnquiry(
      enquiry({ transactionId: "TXN-1", institutionName: "ABank" }),
      expected,
    );
    expect(result).toMatchObject({
      outcome: "success",
      transactionId: "TXN-1",
      institutionName: "ABank",
    });
  });

  // ABank's response type marks amount optional. Absent is not a mismatch —
  // the enquiry is server-to-server and not attacker-controlled, so status
  // alone is authoritative when no amount is returned.
  it("confirms when ABank omits the amount", () => {
    expect(verifyEnquiry(enquiry({ amount: undefined }), expected)).toMatchObject({
      outcome: "success",
    });
  });

  it("confirms when ABank omits the order id", () => {
    expect(verifyEnquiry(enquiry({ orderId: undefined }), expected)).toMatchObject({
      outcome: "success",
    });
  });
});

describe("verifyEnquiry — refuses to confirm", () => {
  it("rejects a short payment", () => {
    expect(verifyEnquiry(enquiry({ amount: 1 }), expected)).toEqual({
      outcome: "failed",
      reason: "amount-mismatch",
    });
  });

  it("rejects an overpayment rather than silently accepting it", () => {
    expect(verifyEnquiry(enquiry({ amount: 999999 }), expected)).toEqual({
      outcome: "failed",
      reason: "amount-mismatch",
    });
  });

  it("rejects a mismatched order id", () => {
    expect(verifyEnquiry(enquiry({ orderId: "AB-SOMEONE-ELSE" }), expected)).toEqual({
      outcome: "failed",
      reason: "order-id-mismatch",
    });
  });

  it("marks a provider-reported failure as failed", () => {
    expect(verifyEnquiry(enquiry({ paymentTxnStatus: 500 }), expected)).toEqual({
      outcome: "failed",
      reason: "provider-failed",
    });
  });

  // Non-destructive: leave the payment alone and let the status poller or the
  // auto-cancel timer settle it, rather than rejecting a real payment.
  it("treats pending as pending", () => {
    expect(verifyEnquiry(enquiry({ paymentTxnStatus: 100 }), expected)).toEqual({
      outcome: "pending",
    });
  });

  it("treats refunded and not-found as pending, not success", () => {
    expect(verifyEnquiry(enquiry({ paymentTxnStatus: 400 }), expected)).toEqual({
      outcome: "pending",
    });
    expect(verifyEnquiry(enquiry({ paymentTxnStatus: 403 }), expected)).toEqual({
      outcome: "pending",
    });
  });

  it("never confirms an unrecognised status", () => {
    const rogue = { paymentTxnStatus: 201 } as unknown as EnquiryData;
    expect(verifyEnquiry(rogue, expected)).toEqual({ outcome: "pending" });
  });
});

describe("verifyEnquiry — the reported bypass", () => {
  // The exploit: a student enrolls, receives their own orderId in the QR
  // response, never pays, and opens
  //   /api/webhooks/abank?orderId=<theirs>&status=SUCCESS
  // The old handler took `status` from the query string. verifyEnquiry only
  // ever reads ABank's own answer, so a forged callback cannot reach "success"
  // unless ABank itself reports the payment settled.
  it("cannot be satisfied by a caller-supplied status", () => {
    // ABank says pending; the attacker's query string is irrelevant here
    // because it is never an input to this function.
    expect(verifyEnquiry(enquiry({ paymentTxnStatus: 100 }), expected)).toEqual({
      outcome: "pending",
    });
  });

  it("checks the order id against the payment we looked up, not the callback", () => {
    // Attacker replays someone else's settled order against their own payment.
    const victimsSettledOrder = enquiry({ orderId: "AB-VICTIM-111", amount: 50000 });
    expect(verifyEnquiry(victimsSettledOrder, expected)).toEqual({
      outcome: "failed",
      reason: "order-id-mismatch",
    });
  });
});
