import { describe, it, expect } from "vitest";
import { interpretCreateResponse } from "@/components/payments/QRPaymentModal";

// ─── QRPaymentModal creation-response decision (R10) ────────────────────────
//
// This project has no jsdom or testing-library, and its component tests use
// renderToStaticMarkup, which cannot run effects — so the decision the modal
// makes about a creation response is extracted and tested here as a pure
// function instead.
//
// SCOPE LIMIT, stated rather than implied: these tests pin the CLASSIFICATION.
// They do not execute the component, so they do not themselves prove that
// `startPolling` is skipped. What makes that true is the early `return` in
// both call sites after an already_paid result — verified by reading the
// component, not by this file.

describe("already_paid (spec §5.1a)", () => {
  // The failure this prevents: a 200 carrying no qr and no orderId used to set
  // both to undefined, skip QR rendering, set state to "qr" anyway — an empty
  // QR panel — and then poll /status?ref=undefined every 5s for 10 minutes
  // before declaring the code expired. A student who had already paid saw a
  // blank code followed by an expiry error.
  it("is recognised before anything reads data.qr", () => {
    expect(interpretCreateResponse({ status: "already_paid" })).toEqual({ kind: "already_paid" });
  });

  it("is recognised even if a qr field is somehow also present", () => {
    expect(
      interpretCreateResponse({ status: "already_paid", qr: "STRAY", orderId: "KBZ_x" }),
    ).toEqual({ kind: "already_paid" });
  });
});

describe("created", () => {
  it("returns the QR source and order id", () => {
    expect(
      interpretCreateResponse({ status: "created", qr: "0002010102QR", orderId: "KBZ_x" }),
    ).toEqual({ kind: "qr", qrSource: "0002010102QR", orderId: "KBZ_x" });
  });

  // ABank, MMPay and PayPay never send `status`. Their responses must keep
  // working exactly as before — this is the regression guard for the three
  // live providers.
  it("handles a legacy response with no status field (ABank / MMPay)", () => {
    expect(interpretCreateResponse({ qr: "EMVCO", orderId: "AB-123" })).toEqual({
      kind: "qr",
      qrSource: "EMVCO",
      orderId: "AB-123",
    });
  });

  it("handles PayPay, which sends url instead of qr", () => {
    expect(interpretCreateResponse({ url: "https://paypay/x", orderId: "PP-1" })).toEqual({
      kind: "qr",
      qrSource: "https://paypay/x",
      orderId: "PP-1",
    });
  });

  it("prefers qr over url when both are present", () => {
    expect(
      interpretCreateResponse({ qr: "EMVCO", url: "https://x", orderId: "o" }),
    ).toMatchObject({ qrSource: "EMVCO" });
  });
});

describe("unusable responses", () => {
  // Returning null routes the modal to its error state rather than to a blank
  // QR panel and a poll against an undefined reference.
  it.each([
    ["no qr and no url", { orderId: "KBZ_x" }],
    ["a qr but no orderId", { qr: "EMVCO" }],
    ["an empty object", {}],
  ])("returns null for %s", (_label, data) => {
    expect(interpretCreateResponse(data)).toBeNull();
  });

  it("never returns a qr result without both a source and an order id", () => {
    for (const data of [{ qr: "x" }, { orderId: "y" }, {}, { url: "" }]) {
      const result = interpretCreateResponse(data);
      if (result?.kind === "qr") {
        expect(result.qrSource).toBeTruthy();
        expect(result.orderId).toBeTruthy();
      }
    }
  });
});
