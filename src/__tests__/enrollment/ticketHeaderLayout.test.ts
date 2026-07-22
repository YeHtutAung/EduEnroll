import { describe, it, expect } from "vitest";
import { headerRightReserve } from "@/lib/tickets/ticketLayout";

// ─── The header reserve must be measured, never guessed ─────────────────────
//
// The canvas renderer hardcoded `22 * S` for the right-hand block. At S = 6
// that reserves 132px, but the label is drawn in bold 42px Helvetica:
//
//   "Ticket 1/1"    190.7px
//   "Ticket 1/10"   214.0px
//   "Ticket 10/10"  237.4px
//
// So the event name was fitted into a budget that was ~59px too generous and
// still ran into the label — measured at 46px of overlap on the reported
// ticket. Fitting cannot rescue a layout whose budget is wrong.
//
// Widths below are the real measurements from Helvetica bold at 42px, so the
// arithmetic here is the arithmetic the renderer performs.

const WIDTHS: Record<string, number> = {
  "Ticket 1/1": 190.7,
  "Ticket 1/10": 214.0,
  "Ticket 10/10": 237.4,
  Softbank: 150,
};
const measure = (t: string) => WIDTHS[t] ?? t.length * 20;

const GAP = 4 * 6; // 4 * S
const SPONSOR_RESERVE = 42 * 6;

describe("headerRightReserve", () => {
  it("reserves the measured label width for single-digit counts", () => {
    const reserve = headerRightReserve({
      label: "Ticket 1/1",
      measure,
      gap: GAP,
      sponsorReserve: SPONSOR_RESERVE,
    });

    expect(reserve).toBeCloseTo(190.7 + GAP, 1);
    // The old fixed guess, which is what allowed the overlap.
    expect(reserve).toBeGreaterThan(22 * 6);
  });

  it("grows with multi-digit ticket counts", () => {
    const one = headerRightReserve({ label: "Ticket 1/1", measure, gap: GAP, sponsorReserve: SPONSOR_RESERVE });
    const ten = headerRightReserve({ label: "Ticket 1/10", measure, gap: GAP, sponsorReserve: SPONSOR_RESERVE });
    const hundred = headerRightReserve({ label: "Ticket 10/10", measure, gap: GAP, sponsorReserve: SPONSOR_RESERVE });

    expect(ten).toBeGreaterThan(one);
    expect(hundred).toBeGreaterThan(ten);
    expect(hundred).toBeCloseTo(237.4 + GAP, 1);
  });

  it("leaves the event name a budget that cannot overlap the label", () => {
    // The exact geometry of the reported ticket: 600px wide, padX = 96.
    const W = 600;
    const padX = 96;
    const label = "Ticket 1/1";

    const reserve = headerRightReserve({ label, measure, gap: GAP, sponsorReserve: SPONSOR_RESERVE });
    const nameBudget = W - padX * 2 - reserve;
    const nameEndsAt = padX + nameBudget;          // worst case: name fills its budget
    const labelStartsAt = W - padX - measure(label);

    expect(nameEndsAt).toBeLessThanOrEqual(labelStartsAt);

    // With the old constant it did overlap, by the ~46px that was reported.
    const oldNameEndsAt = padX + (W - padX * 2 - 22 * 6);
    expect(oldNameEndsAt - labelStartsAt).toBeGreaterThan(40);
  });

  it("uses the fixed box for a presenting sponsor with a logo", () => {
    const reserve = headerRightReserve({
      label: null,
      measure,
      gap: GAP,
      sponsorReserve: SPONSOR_RESERVE,
      sponsorName: null, // logo path: nothing to measure
    });

    expect(reserve).toBe(SPONSOR_RESERVE);
  });

  it("measures a presenting sponsor drawn as a wordmark", () => {
    // A long name without a logo is wider than the fixed box, so the box alone
    // would under-reserve exactly as the label did.
    const reserve = headerRightReserve({
      label: null,
      measure,
      gap: GAP,
      sponsorReserve: SPONSOR_RESERVE,
      sponsorName: "Softbank",
      sponsorMarkAllowance: 14 * 6,
    });

    expect(reserve).toBe(Math.max(SPONSOR_RESERVE, 150 + 14 * 6 + GAP));
    expect(reserve).toBeGreaterThan(SPONSOR_RESERVE);
  });
});
