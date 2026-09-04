import { describe, expect, it } from "vitest";
import { computePlatformFee } from "@/server/payments/platformFee";
import { statusTicketAmounts } from "@/lib/payments/statusTicketAmounts";

describe("public status ticket amounts", () => {
  it("keeps cart and single-class totals equal for two tickets at the same unit price", () => {
    const cart = statusTicketAmounts([{ subtotal: 2_000 }], null, null);
    const single = statusTicketAmounts(null, 1_000, 2);
    const feeConfig = {
      payment_mode: "mmqr",
      platform_fee_mode: "per_transaction",
      platform_fee_amount: 2_000,
    };

    const cartTotal = (cart.feeAmount ?? 0) + computePlatformFee(feeConfig, cart.feeAmount ?? 0, 2);
    const singleTotal =
      (single.feeAmount ?? 0) + computePlatformFee(feeConfig, single.feeAmount ?? 0, 2);

    expect(single).toEqual({ feeAmount: 2_000, unitFeeAmount: 1_000 });
    expect(cart.feeAmount).toBe(2_000);
    expect(single.feeAmount).toBe(2_000);
    expect(cartTotal).toBe(4_000);
    expect(singleTotal).toBe(cartTotal);
  });
});
