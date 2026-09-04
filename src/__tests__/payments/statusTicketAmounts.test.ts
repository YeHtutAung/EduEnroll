import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { computeOrderTotal, computePlatformFee, displayTotals } from "@/server/payments/platformFee";
import { statusTicketAmounts, ticketSubtotal } from "@/lib/payments/statusTicketAmounts";

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
    const cartPageTicketSubtotal = ticketSubtotal({
      items: [{ subtotal: 2_000 }],
      fee_amount: cart.feeAmount,
      quantity: 2,
    });
    const singlePageTicketSubtotal = ticketSubtotal({
      items: null,
      fee_amount: single.feeAmount,
      quantity: 2,
    });
    const cartPageTotal = displayTotals(
      cartPageTicketSubtotal,
      null,
      computePlatformFee(feeConfig, cartPageTicketSubtotal, 2),
    ).total;
    const singlePageTotal = displayTotals(
      singlePageTicketSubtotal,
      null,
      computePlatformFee(feeConfig, singlePageTicketSubtotal, 2),
    ).total;
    const cartEnrollmentItems = [{ fee_amount: 1_000, quantity: 2 }];
    const singleClass = { fee_amount: 1_000 };
    const singleEnrollment = { class_id: "class-1", quantity: 2 };
    const cartGateway = computeOrderTotal(cartEnrollmentItems, feeConfig);
    const singleGateway = computeOrderTotal(
      [{ fee_amount: singleClass.fee_amount, quantity: singleEnrollment.quantity }],
      feeConfig,
    );

    expect(single).toEqual({ feeAmount: 2_000, unitFeeAmount: 1_000 });
    expect(cart.feeAmount).toBe(2_000);
    expect(single.feeAmount).toBe(2_000);
    expect([
      cartPageTicketSubtotal,
      cartGateway.ticketSubtotal,
      singlePageTicketSubtotal,
      singleGateway.ticketSubtotal,
    ]).toEqual([2_000, 2_000, 2_000, 2_000]);
    expect([cartPageTotal, cartGateway.total, singlePageTotal, singleGateway.total]).toEqual([
      4_000,
      4_000,
      4_000,
      4_000,
    ]);
  });

  it("keeps the payment page ticket subtotal delegated to the shared calculation", () => {
    const page = readFileSync(
      path.resolve(process.cwd(), "src/app/(public)/enroll/payment/[ref]/page.tsx"),
      "utf8",
    );

    expect(
      page,
      "Payment page ticket subtotal must call ticketSubtotal without multiplying by quantity.",
    ).toMatch(/const totalFee = ticketSubtotal\(\{[\s\S]*?quantity: qty,[\s\S]*?\}\);/);
  });
});
