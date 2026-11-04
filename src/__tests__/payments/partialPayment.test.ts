import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { summarisePartialPayment } from "@/server/payments/partialPayment";

// ─── Partial payments ───────────────────────────────────────────────────────
//
// `request_remaining` records received_amount on one row, and a top-up gets a
// row of its own holding only the remainder. So the latest row says nothing
// about what was received: after an abandoned top-up its received_amount is
// null, and reading only that row charged the buyer the whole order again.

const row = (amount: number, received_amount: number | null) => ({ amount, received_amount });

describe("summarisePartialPayment", () => {
  it("reports nothing received when no row records an amount", () => {
    expect(summarisePartialPayment([row(1000, null)])).toEqual({ received: 0, orderTotal: null, orderFee: null, remaining: null });
    expect(summarisePartialPayment([])).toEqual({ received: 0, orderTotal: null, orderFee: null, remaining: null });
  });

  it("reads the row that recorded the partial payment", () => {
    expect(summarisePartialPayment([row(1000, 600)])).toMatchObject({ received: 600, orderTotal: 1000, remaining: 400 });
  });

  it("still knows what was received after an abandoned top-up", () => {
    const rows = [row(1000, 600), row(400, null), row(400, null)];
    expect(summarisePartialPayment(rows)).toMatchObject({ received: 600, orderTotal: 1000, remaining: 400 });
  });

  it("adds amounts recorded on separate rows", () => {
    // A top-up row reused by a receipt upload, where staff recorded 150 of its 400.
    expect(summarisePartialPayment([row(1000, 600), row(400, 150)])).toMatchObject({
      received: 750,
      orderTotal: 1000,
      remaining: 250,
    });
  });

  it("reports the fee from the row holding the order total", () => {
    const rows = [{ ...row(1030, 600), platform_fee: 30 }, { ...row(430, null), platform_fee: 0 }];
    expect(summarisePartialPayment(rows)).toMatchObject({ orderTotal: 1030, orderFee: 30, remaining: 430 });
  });

  it("does not treat a recorded zero as the order total's row", () => {
    expect(summarisePartialPayment([row(1000, 0)])).toEqual({ received: 0, orderTotal: null, orderFee: null, remaining: null });
  });
});

// Each route computes its own charge, so one left on the old read would keep
// the bug. Reading the source is the only check that covers all of them at once.
describe("gateway routes", () => {
  it.each(["abank", "cbmmqr", "hitpay", "kbzpay", "mmpay", "paypay", "stripe"])(
    "%s reads the whole payment history",
    (route) => {
      const source = readFileSync(join(process.cwd(), `src/app/api/public/payments/${route}/route.ts`), "utf8");
      expect(source).toContain("loadPartialPayment(supabase, enrollment.id)");
      expect(source).not.toContain('.select("received_amount")');
    },
  );
});
