import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

// ─── Every payment route must price an order the same way ───────────────────
//
// The order total used to be worked out independently in eight routes, each
// summing fee_amount * quantity by hand. That was survivable while the total
// was just the ticket subtotal. With a platform fee it is not: settlement
// compares the provider's figure against the amount stored on the payment row,
//
//   if (Number(observedAmount) !== Number(payment.amount)) -> amount_mismatch
//
// so a route that prices an order differently sends the gateway one figure and
// records another. The payer is charged and then refused. Money taken, no
// ticket.
//
// This scans the routes rather than testing one of them, because the failure
// mode is a NEW route being added that quietly sums the items itself.

const ROUTES_DIR = join(process.cwd(), "src/app/api/public/payments");

/** Every route.ts under the payments API. */
function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

/** Routes that actually price an order — status and callback routes do not. */
const pricingRoutes = routeFiles(ROUTES_DIR).filter((f) => {
  const src = readFileSync(f, "utf8");
  return src.includes("fee_amount") && src.includes("quantity");
});

const rel = (f: string) => f.replace(process.cwd(), "").replace(/\\/g, "/");

describe("payment route inventory", () => {
  // Guards the matcher: if it stopped finding routes, everything below would
  // pass vacuously.
  it("finds the routes that price an order", () => {
    expect(pricingRoutes.length).toBeGreaterThanOrEqual(8);
  });
});

describe.each(pricingRoutes.map((f) => [rel(f), f] as const))("%s", (_label, file) => {
  const src = readFileSync(file, "utf8");

  it("prices through the shared calculator", () => {
    // Status routes quote payment.amount rather than pricing anything, which
    // is stricter than recomputing: it is the figure actually charged.
    if (file.includes("status")) {
      expect(src, `${rel(file)} re-sums line items instead of quoting payment.amount`)
        .toContain("payment.amount");
      return;
    }

    expect(
      src.includes("resolveOrderTotal") || src.includes("computeOrderTotal"),
      `${rel(file)} prices an order without the shared calculator, so it can ` +
        `disagree with what settlement expects`,
    ).toBe(true);
  });

  // A route that records the amount but not its split does not fail loudly. It
  // writes platform_fee 0 against a fee-bearing amount, and the confirmation
  // screen then reports the whole charge as tickets — understating the fee
  // rather than erroring. Nothing at runtime catches that, so it is caught here.
  it("records the fee alongside the amount it is part of", () => {
    if (file.includes("status")) return;

    const writesRow =
      src.includes('.from("payments")') ||
      src.includes("claim_kbzpay_order_slot") ||
      src.includes("complete_kbzpay_supersede") ||
      src.includes("finalizeStripeAttempt");
    if (!writesRow) return;

    // Matches the fee being PASSED — an object property or a shorthand — not
    // merely destructured out of the calculator, which every route does and
    // which an earlier version of this check accepted, making it vacuous.
    const passesFee = src
      .split("\n")
      .some((line) => /^(platform_fee|p_platform_fee|platformFee)\s*[:,]/.test(line.trim()));

    expect(
      passesFee,
      `${rel(file)} creates a payment row without recording platform_fee, so ` +
        `the charged amount cannot be broken down into tickets and fee`,
    ).toBe(true);
  });
});
