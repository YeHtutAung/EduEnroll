import { describe, expect, it } from "vitest";
import { computeOrderTotal, computePlatformFee, displayTotals } from "@/server/payments/platformFee";
import { statusTicketAmounts } from "@/lib/payments/statusTicketAmounts";

describe("public status ticket amounts", () => {
  it("keeps cart and single-class page totals aligned with the gateway quote", () => {
    const cart = statusTicketAmounts([{ subtotal: 2_000 }], null, null);
    const single = statusTicketAmounts(null, 1_000, 2);
    const feeConfig = {
      payment_mode: "mmqr",
      platform_fee_mode: "per_transaction",
      platform_fee_amount: 2_000,
    };

    // The page receives these status totals; the payment route builds the
    // same gateway amount directly from the unit price and quantity.
    const cartPageTotal = displayTotals(
      cart.feeAmount ?? 0,
      null,
      computePlatformFee(feeConfig, cart.feeAmount ?? 0, 2),
    ).total;
    const singlePageTotal = displayTotals(
      single.feeAmount ?? 0,
      null,
      computePlatformFee(feeConfig, single.feeAmount ?? 0, 2),
    ).total;
    const cartGatewayTotal = computeOrderTotal([{ fee_amount: 1_000, quantity: 2 }], feeConfig).total;
    const singleGatewayTotal = computeOrderTotal([{ fee_amount: 1_000, quantity: 2 }], feeConfig).total;

    expect(single).toEqual({ feeAmount: 2_000, unitFeeAmount: 1_000 });
    expect(cart.feeAmount).toBe(2_000);
    expect(single.feeAmount).toBe(2_000);
    expect([cartPageTotal, cartGatewayTotal, singlePageTotal, singleGatewayTotal]).toEqual([
      4_000,
      4_000,
      4_000,
      4_000,
    ]);
  });
});
