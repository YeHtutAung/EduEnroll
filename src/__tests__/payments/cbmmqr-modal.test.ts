import { describe, it, expect } from "vitest";
import { interpretCreateResponse, qrCountdown } from "@/components/payments/QRPaymentModal";

describe("interpretCreateResponse with expiresAt", () => {
  it("carries CB's expiresAt through", () => {
    expect(interpretCreateResponse({ status: "created", qr: "000201QR", orderId: "CBREF", expiresAt: "2026-10-31T04:03:00.000Z" }))
      .toEqual({ kind: "qr", qrSource: "000201QR", orderId: "CBREF", expiresAt: "2026-10-31T04:03:00.000Z" });
  });
  it("leaves other providers unchanged (no expiresAt)", () => {
    expect(interpretCreateResponse({ qr: "000201QR", orderId: "X" })).toEqual({ kind: "qr", qrSource: "000201QR", orderId: "X" });
  });
});

describe("qrCountdown", () => {
  const now = Date.parse("2026-10-31T04:00:00Z");
  it("m:ss while time remains", () => {
    expect(qrCountdown(now + 125_000, now)).toEqual({ expired: false, label: "2:05" });
  });
  it("expired at or after the expiry", () => {
    expect(qrCountdown(now, now)).toEqual({ expired: true, label: null });
  });
  it("no countdown without an expiry", () => {
    expect(qrCountdown(null, now)).toEqual({ expired: false, label: null });
  });
});
