import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// ─── Every gateway call must carry a request budget ─────────────────────────
//
// The KBZPay routes run inside a serverless function capped at 10s, which
// cannot be raised on this plan. A per-call timeout alone cannot bound a
// request: the creation route makes up to four sequential calls, and the
// status and webhook routes run settlement AFTER their call — the write path
// that marks the payment verified, decrements seats and issues the ticket.
//
// A call that ignores time already spent can leave under a second for that,
// and being interrupted mid-settlement is far worse than failing before the
// call. So every call site shares a deadline anchored at request start.
//
// Review of PR #242 caught that only the creation route had one. This scans
// the sources instead of testing one route, because the next call site added
// would otherwise repeat the omission silently.

const CALL_SITES = [
  "src/app/api/public/payments/kbzpay/route.ts",
  "src/app/api/public/payments/kbzpay/status/route.ts",
  "src/app/api/webhooks/kbzmmqr/route.ts",
  "src/server/payments/resolveKbzpayOrder.ts",
];

/** `precreate(`, `queryOrder(`, `closeOrder(` invocations with their arguments. */
function gatewayCalls(source: string): string[] {
  const calls: string[] = [];

  for (const fn of ["precreate", "queryOrder", "closeOrder"]) {
    // `await fn(` — skips imports and type positions.
    const pattern = new RegExp(`await\\s+${fn}\\s*\\(`, "g");
    for (const match of source.matchAll(pattern)) {
      const from = match.index ?? 0;
      // Take enough text to cover a multi-line argument list.
      calls.push(source.slice(from, from + 400));
    }
  }

  return calls;
}

describe("gateway call sites", () => {
  // Guards the matcher: if it stopped finding calls, everything below would
  // pass vacuously.
  it("finds the calls it is meant to check", () => {
    const total = CALL_SITES.reduce(
      (n, f) => n + gatewayCalls(readFileSync(join(process.cwd(), f), "utf8")).length,
      0,
    );
    expect(total).toBeGreaterThanOrEqual(6);
  });
});

describe.each(CALL_SITES)("%s", (file) => {
  const source = readFileSync(join(process.cwd(), file), "utf8");

  it("passes a budget to every gateway call", () => {
    for (const call of gatewayCalls(source)) {
      expect(call, `a gateway call in ${file} has no budget`).toMatch(/budget/);
    }
  });
});

describe.each(CALL_SITES.filter((f) => f.includes("/api/")))("%s", (file) => {
  const source = readFileSync(join(process.cwd(), file), "utf8");

  // Without this the platform picks the default, and the value the code is
  // reasoning about is invisible next to the calls it bounds.
  it("declares its own maxDuration", () => {
    expect(source).toMatch(/export const maxDuration = \d+/);
  });

  // The budget must be smaller than the function cap, or it reserves nothing
  // for the database work and the response that follow the gateway call.
  it("reserves part of the function budget for work after the call", () => {
    const cap = Number(source.match(/export const maxDuration = (\d+)/)?.[1]);
    const budgetMs = Number(source.match(/const GATEWAY_BUDGET_MS = ([\d_]+)/)?.[1].replace(/_/g, ""));

    expect(cap).toBeGreaterThan(0);
    expect(budgetMs).toBeGreaterThan(0);
    expect(budgetMs).toBeLessThan(cap * 1000);
  });
});
