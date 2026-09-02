import { describe, it, expect } from "vitest";
import {
  computeOrderTotal,
  computePlatformFee,
  displayTotals,
  reconcileLineItems,
  selectOrderPayment,
} from "@/server/payments/platformFee";

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

// ─── Review of PR #245, finding 1 ───────────────────────────────────────────
//
// The confirmation screen recomputed the fee from the tenant's CURRENT
// settings and returned it as the amount the customer "was charged". An admin
// editing the fee afterwards changed what a completed order reported, so the
// receipt disagreed with the money. payments.amount is immutable; the settings
// are not.
describe("what a completed order reports", () => {
  it("uses the amount actually charged, not the current setting", () => {
    // Order was charged 1,200. Fee has since been raised to 900.
    const shown = displayTotals(1000, 1200, 900);

    expect(shown.total).toBe(1200);
    expect(shown.platformFee).toBe(200);
  });

  it("is unaffected by the setting being removed after payment", () => {
    expect(displayTotals(1000, 1200, 0)).toEqual({ platformFee: 200, total: 1200 });
  });

  // Before payment there is nothing charged to report, so the current setting
  // is the right answer — it is what the buyer would pay.
  it("quotes the current setting when nothing has been charged yet", () => {
    expect(displayTotals(1000, null, 500)).toEqual({ platformFee: 500, total: 1500 });
  });

  // ── Review of PR #245, finding 3 ─────────────────────────────────────────
  //
  // A partial order's top-up row holds the REMAINDER, and `request_remaining`
  // never moves the original row's status to 'verified' — so the only row that
  // looks verified can be the top-up. Reporting its amount told a customer
  // their 1,000 order cost 600.
  //
  // The rule that removes the whole class of bug: an order total can never be
  // less than the tickets it contains.
  it("never reports a remainder as the order total", () => {
    // 1,000 of tickets, top-up row of 600. The reported figure was 600.
    const shown = displayTotals(1000, 600, 0);

    expect(shown.total).toBe(1000);
    expect(shown.total).toBeGreaterThanOrEqual(1000);
  });

  it("falls back to the configured fee when only a remainder is known", () => {
    expect(displayTotals(1000, 600, 500)).toEqual({ platformFee: 500, total: 1500 });
  });

  it("never reports a negative fee", () => {
    expect(displayTotals(3000, 1500, 0).platformFee).toBe(0);
  });

  // The property, rather than the examples: whatever row is found, the total
  // never falls below the tickets on the order.
  it.each([null, 0, 600, 999, 1000, 1200, 5000])(
    "reports at least the ticket subtotal (charged %s)",
    (charged) => {
      expect(displayTotals(1000, charged, 0).total).toBeGreaterThanOrEqual(1000);
    },
  );
});

// ─── Review of PR #245, finding 2 ───────────────────────────────────────────
//
// MMPay and Stripe are sent line items alongside a total and reject the order
// when they disagree. The lines describe the whole order, so a partial payment
// reducing the amount to a remainder leaves them mismatched. This predates the
// platform fee, which merely added another line to a broken payload.
describe("gateway line items", () => {
  const items = [
    { name: "GA", amount: 1000, quantity: 2 },
    { name: "Online platform fee", amount: 500, quantity: 1 },
  ];

  it("leaves the lines alone when they already sum to the total", () => {
    expect(reconcileLineItems(items, 2500)).toEqual(items);
  });

  it("collapses to one balance line when a partial payment shrinks the total", () => {
    // 2,500 order, 1,000 already received: the lines still describe 2,500.
    expect(reconcileLineItems(items, 1500)).toEqual([
      { name: "Remaining balance", amount: 1500, quantity: 1 },
    ]);
  });

  // The property the gateway actually enforces.
  it.each([2500, 1500, 1, 0])("always sums to the total (%i)", (total) => {
    const out = reconcileLineItems(items, total);
    expect(out.reduce((n, i) => n + i.amount * i.quantity, 0)).toBe(total);
  });
});

// ─── Review of PR #245, finding 4 ───────────────────────────────────────────
//
// Choosing the largest amount across ALL rows treated an unpaid attempt as
// money charged. A payment row exists from the moment an order is created, so
// a customer who abandons an attempt — or an admin who reduces the fee before
// payment — leaves a larger, never-paid row behind. Reporting it contradicted
// the very rule the code above states: once money has moved, the payment row
// is the truth. A row where money has NOT moved is not that truth.
describe("which payment row speaks for the order", () => {
  const verified = (amount: number) => ({ status: "verified", amount });
  const unpaid = (amount: number) => ({ status: "awaiting_payment", amount });

  it("ignores a larger unpaid attempt", () => {
    // Abandoned at the old 500 fee, then paid after the fee was removed.
    expect(selectOrderPayment([unpaid(1500), verified(1000)])).toEqual(verified(1000));
  });

  it.each(["awaiting_payment", "pending", "failed", "expired"])(
    "does not treat a %s row as money charged",
    (status) => {
      expect(selectOrderPayment([{ status, amount: 9999 }])).toBeNull();
    },
  );

  it("returns null when nothing has settled, so the caller quotes the current fee", () => {
    expect(selectOrderPayment([unpaid(1500)])).toBeNull();
    expect(selectOrderPayment([])).toBeNull();
    expect(selectOrderPayment(null)).toBeNull();
  });

  // The order-level row, not whichever the relation happened to return first.
  it("picks the largest settled row, whatever the order", () => {
    const rows = [verified(600), verified(1500)];
    expect(selectOrderPayment(rows)).toEqual(verified(1500));
    expect(selectOrderPayment([...rows].reverse())).toEqual(verified(1500));
  });

  // The two guards composed: an unpaid inflated row is ignored, and the
  // remaining top-up is below the subtotal, so the configured fee is used.
  it("composes with displayTotals on a partial order", () => {
    const rows = [unpaid(1500), verified(600)];
    const charged = selectOrderPayment(rows)?.amount ?? null;

    expect(displayTotals(1000, charged, 0).total).toBe(1000);
  });
});
