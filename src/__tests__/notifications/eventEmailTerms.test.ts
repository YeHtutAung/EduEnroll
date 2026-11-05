import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data: unknown; error: { message: string } | null };

let tables: Record<string, Result>;
let queried: string[];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      queried.push(table);
      const result = tables[table] ?? { data: [], error: null };
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        maybeSingle: () => Promise.resolve(result),
        then: (resolve: (value: Result) => unknown) => Promise.resolve(result).then(resolve),
      };
      return chain;
    },
  }),
}));

import { loadEventEmailTerms } from "@/server/notifications/eventEmailTerms";

const ok = (data: unknown): Result => ({ data, error: null });

beforeEach(() => {
  queried = [];
  tables = {
    enrollments: ok({ class_id: null }),
    enrollment_items: ok([{ class_id: "class-1" }, { class_id: "class-2" }]),
    classes: ok([{ intake_id: "intake-1" }, { intake_id: "intake-1" }]),
    intakes: ok([{ email_terms: "  Non-Refundable.  " }]),
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("loadEventEmailTerms", () => {
  it("finds a cart order's terms through its items", async () => {
    await expect(loadEventEmailTerms("order-1")).resolves.toBe("Non-Refundable.");
  });

  it("finds a single-ticket order's terms through the enrollment", async () => {
    tables.enrollments = ok({ class_id: "class-1" });
    tables.enrollment_items = ok([]);
    await expect(loadEventEmailTerms("order-1")).resolves.toBe("Non-Refundable.");
  });

  it("returns null for an event with no terms", async () => {
    tables.intakes = ok([{ email_terms: null }]);
    await expect(loadEventEmailTerms("order-1")).resolves.toBeNull();
  });

  it("does not repeat the same terms when an order spans events", async () => {
    tables.intakes = ok([{ email_terms: "Same." }, { email_terms: "Same." }, { email_terms: null }]);
    await expect(loadEventEmailTerms("order-1")).resolves.toBe("Same.");
  });

  it("never reads the checkout rules", async () => {
    tables.intakes = ok([{ organiser_terms: "Checkout rule.", email_terms: null }]);
    await expect(loadEventEmailTerms("order-1")).resolves.toBeNull();
  });

  // A database without the column yet answers like this: the buyer must still
  // get their confirmation and ticket.
  it.each(["enrollments", "enrollment_items", "classes", "intakes"])(
    "returns null instead of failing when %s cannot be read",
    async (table) => {
      tables[table] = { data: null, error: { message: "failed" } };
      await expect(loadEventEmailTerms("order-1")).resolves.toBeNull();
    },
  );

  it("returns null when the client itself throws", async () => {
    tables = new Proxy(
      {},
      {
        get: () => {
          throw new Error("boom");
        },
      },
    );
    await expect(loadEventEmailTerms("order-1")).resolves.toBeNull();
  });
});

describe("confirmation email senders", () => {
  // Six places build this email. One that forgot the terms would silently send
  // buyers a different email depending on how they paid.
  it.each([
    "src/server/payments/notifyEnrollmentConfirmed.ts",
    "src/server/notifications/dispatchPaymentApproved.ts",
    "src/app/api/webhooks/mmpay/route.ts",
    "src/app/api/webhooks/abank/route.ts",
    "src/app/api/public/payments/abank/status/route.ts",
    "src/app/api/admin/enrollments/[id]/resend-email/route.ts",
  ])("%s passes the event's terms", (file) => {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    const call = source.slice(source.indexOf("enrollmentApprovedEmail({"));
    expect(call.slice(0, call.indexOf("});"))).toContain("eventTerms: await loadEventEmailTerms(");
  });
});
