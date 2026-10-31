import { describe, it, expect } from "vitest";
import { normaliseMmqrProvider } from "@/lib/mmqrProvider";
import { paymentApiBase } from "@/components/payments/QRPaymentModal";

describe("cbmmqr never falls through to MMPay", () => {
  it("normaliseMmqrProvider keeps every known provider", () => {
    for (const p of ["abank", "mmpay", "kbzpay", "cbmmqr"] as const) {
      expect(normaliseMmqrProvider(p, "mmpay")).toBe(p);
    }
  });

  it("only unknown values take the caller's fallback", () => {
    expect(normaliseMmqrProvider("cb", "mmpay")).toBe("mmpay");
    expect(normaliseMmqrProvider(null, "abank")).toBe("abank");
  });

  it("the modal posts cbmmqr to the CB route", () => {
    expect(paymentApiBase("cbmmqr")).toBe("/api/public/payments/cbmmqr");
    expect(paymentApiBase("kbzpay")).toBe("/api/public/payments/kbzpay");
    expect(paymentApiBase("abank")).toBe("/api/public/payments/abank");
    expect(paymentApiBase("paypay")).toBe("/api/public/payments/paypay");
    expect(paymentApiBase("mmpay")).toBe("/api/public/payments/mmpay");
  });
});
