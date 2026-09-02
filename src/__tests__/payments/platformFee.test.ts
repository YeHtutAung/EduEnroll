import { describe, it, expect } from "vitest";
import { computeOrderTotal, computePlatformFee } from "@/server/payments/platformFee";

// ─── Online platform fee ────────────────────────────────────────────────────
//
// The fee lands inside `payments.amount`, which settlement compares against
// what the provider reports:
//
//   if (Number(observedAmount) !== Number(payment.amount)) -> amount_mismatch
//
// So every value here has to be exact. A fee that is off by one kyat does not
// show up as a rounding nit — the payer is charged, the gateway reports its
// figure, ours disagrees, and the payment is refused after the money moved.

const ONLINE = { payment_mode: "mmqr" };
const items = (...pairs: [number, number][]) =>
  pairs.map(([fee_amount, quantity]) => ({ fee_amount, quantity }));

describe("no fee configured", () => {
  it("is the ticket subtotal, untouched", () => {
    const t = computeOrderTotal(items([1000, 2]), { ...ONLINE, platform_fee_mode: "none" });

    expect(t).toMatchObject({ ticketSubtotal: 2000, platformFee: 0, total: 2000 });
  });

  // Every existing tenant sits on the column defaults. None of them may see a
  // price change from this feature shipping.
  it("charges nothing on the column defaults", () => {
    const t = computeOrderTotal(items([1000, 1]), {
      ...ONLINE,
      platform_fee_mode: "none",
      platform_fee_amount: 0,
    });

    expect(t.platformFee).toBe(0);
    expect(t.total).toBe(1000);
  });
});

describe("per transaction", () => {
  const tenant = { ...ONLINE, platform_fee_mode: "per_transaction", platform_fee_amount: 500 };

  it("adds the flat fee once, whatever the ticket count", () => {
    expect(computeOrderTotal(items([1000, 1]), tenant).total).toBe(1500);
    expect(computeOrderTotal(items([1000, 5]), tenant).total).toBe(5500);
    expect(computeOrderTotal(items([1000, 2], [2000, 3]), tenant).total).toBe(8500);
  });

  it("reports the split so a receipt need not re-derive it", () => {
    const t = computeOrderTotal(items([1000, 3]), tenant);

    expect(t).toMatchObject({ ticketSubtotal: 3000, platformFee: 500, total: 3500 });
    expect(t.ticketSubtotal + t.platformFee).toBe(t.total);
  });
});

describe("per ticket", () => {
  const tenant = { ...ONLINE, platform_fee_mode: "per_ticket", platform_fee_amount: 200 };

  it("multiplies by the ticket count, not the line count", () => {
    expect(computeOrderTotal(items([1000, 1]), tenant).total).toBe(1200);
    expect(computeOrderTotal(items([1000, 4]), tenant).total).toBe(4800);
    // Two lines, five tickets: 5 x 200, not 2 x 200.
    expect(computeOrderTotal(items([1000, 2], [2000, 3]), tenant).platformFee).toBe(1000);
  });
});

describe("online gateways only", () => {
  // The fee pays for a gateway. A manual bank transfer uses none, and the
  // feature is named for exactly that distinction.
  it("charges nothing on a bank transfer tenant", () => {
    const t = computeOrderTotal(items([1000, 3]), {
      payment_mode: "bank_transfer",
      platform_fee_mode: "per_ticket",
      platform_fee_amount: 200,
    });

    expect(t.platformFee).toBe(0);
    expect(t.total).toBe(3000);
  });

  it.each(["mmqr", "stripe", "hitpay", "paypay"])("charges on %s", (mode) => {
    const t = computeOrderTotal(items([1000, 1]), {
      payment_mode: mode,
      platform_fee_mode: "per_transaction",
      platform_fee_amount: 500,
    });

    expect(t.platformFee).toBe(500);
  });
});

describe("edges that would otherwise reach the gateway", () => {
  // A fee on a zero subtotal turns a free enrolment into one that must be paid
  // for, which no organiser configuring a fee is asking for.
  it("leaves a free order free", () => {
    const t = computeOrderTotal(items([0, 2]), {
      ...ONLINE,
      platform_fee_mode: "per_ticket",
      platform_fee_amount: 200,
    });

    expect(t.platformFee).toBe(0);
    expect(t.total).toBe(0);
  });

  // The fee was charged on the first payment. Charging it again on the
  // remainder would take it twice for one order.
  it("does not charge twice on a partial-payment top-up", () => {
    const tenant = { ...ONLINE, platform_fee_mode: "per_transaction", platform_fee_amount: 500 };
    const t = computeOrderTotal(items([1000, 3]), tenant, 1500);

    expect(t.platformFee).toBe(0);
    expect(t.total).toBe(1500); // 3000 subtotal - 1500 already paid
  });

  it("refuses to let a negative or fractional setting through", () => {
    const base = { ...ONLINE, platform_fee_mode: "per_transaction" };

    expect(computePlatformFee({ ...base, platform_fee_amount: -500 }, 1000, 1)).toBe(0);
    // MMK is whole kyat and payments.amount is an integer column.
    expect(computePlatformFee({ ...base, platform_fee_amount: 500.7 }, 1000, 1)).toBe(500);
  });

  it("treats an unknown mode as no fee rather than guessing", () => {
    expect(
      computePlatformFee(
        { ...ONLINE, platform_fee_mode: "percentage_of_total", platform_fee_amount: 500 },
        1000,
        1,
      ),
    ).toBe(0);
  });

  it("handles missing settings on a tenant row read before the migration", () => {
    expect(computeOrderTotal(items([1000, 2]), ONLINE).total).toBe(2000);
  });
});
