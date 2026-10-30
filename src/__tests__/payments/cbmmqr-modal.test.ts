import { describe, it, expect } from "vitest";
import { interpretCreateResponse, qrCountdown, localExpiryMs } from "@/components/payments/QRPaymentModal";

describe("interpretCreateResponse with expiresAt", () => {
  it("carries CB's expiresAt through", () => {
    expect(interpretCreateResponse({ status: "created", qr: "000201QR", orderId: "CBREF", expiresAt: "2026-10-31T04:03:00.000Z" }))
      .toEqual({ kind: "qr", qrSource: "000201QR", orderId: "CBREF", expiresAt: "2026-10-31T04:03:00.000Z" });
  });
  it("carries CB's serverNow through", () => {
    expect(interpretCreateResponse({ status: "created", qr: "Q", orderId: "R", expiresAt: "2026-10-31T04:03:00.000Z", serverNow: "2026-10-31T04:00:00.000Z" }))
      .toEqual({ kind: "qr", qrSource: "Q", orderId: "R", expiresAt: "2026-10-31T04:03:00.000Z", serverNow: "2026-10-31T04:00:00.000Z" });
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

describe("localExpiryMs", () => {
  const exp = "2026-10-31T04:03:00.000Z";
  it("applies the server/phone clock offset: the QR has exactly expiresAt - serverNow left", () => {
    const phoneNow = Date.parse("2026-10-31T09:00:00Z"); // phone clock hours off
    expect(localExpiryMs(exp, "2026-10-31T04:00:00.000Z", phoneNow)).toBe(phoneNow + 180_000);
  });
  it("null when expiresAt is missing or unparsable", () => {
    expect(localExpiryMs(undefined, "2026-10-31T04:00:00.000Z", 0)).toBeNull();
    expect(localExpiryMs("not a date", "2026-10-31T04:00:00.000Z", 0)).toBeNull();
  });
  it("the raw expiry when serverNow is missing or unparsable", () => {
    expect(localExpiryMs(exp, undefined, 123)).toBe(Date.parse(exp));
    expect(localExpiryMs(exp, "garbage", 123)).toBe(Date.parse(exp));
  });
});
