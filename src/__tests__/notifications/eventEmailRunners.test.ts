import { readFileSync } from "fs";
import { join } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

let orderResult: { data: unknown; error: unknown } = { data: null, error: null };
const chain: Record<string, unknown> = {};
for (const m of ["select", "eq"]) chain[m] = () => chain;
chain.maybeSingle = () => Promise.resolve(orderResult);
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: () => chain }) }));

const { loadEmailRunners } = await import("@/server/notifications/eventEmailRunners");

beforeEach(() => {
  orderResult = { data: null, error: null };
});

describe("loadEmailRunners", () => {
  it("returns a cart order's runners in seat order with their tier", async () => {
    orderResult = {
      data: {
        class_id: null,
        attendees: [
          { class_id: "c5", seat_no: 1, label: "Ma Su · Kids 10", answers: {} },
          { class_id: "c10", seat_no: 1, label: "Ko Aung · M", answers: {} },
        ],
        classes: null,
        enrollment_items: [
          { class_id: "c10", classes: { level: "10KM" } },
          { class_id: "c5", classes: { level: "5KM" } },
        ],
      },
      error: null,
    };
    await expect(loadEmailRunners("e1")).resolves.toEqual([
      { tier: "10KM", label: "Ko Aung · M" },
      { tier: "5KM", label: "Ma Su · Kids 10" },
    ]);
  });

  it("uses a single order's own tier", async () => {
    orderResult = {
      data: {
        class_id: "c5",
        attendees: [{ class_id: "c5", seat_no: 1, label: "Ko Min · M", answers: {} }],
        classes: { level: "Early Bird - 5KM" },
        enrollment_items: [],
      },
      error: null,
    };
    await expect(loadEmailRunners("e1")).resolves.toEqual([{ tier: "Early Bird - 5KM", label: "Ko Min · M" }]);
  });

  it("is empty for an order without runners, a missing order, or a failed lookup — never throws", async () => {
    orderResult = { data: { class_id: "c5", attendees: [], classes: null, enrollment_items: [] }, error: null };
    await expect(loadEmailRunners("e1")).resolves.toEqual([]);
    orderResult = { data: null, error: null };
    await expect(loadEmailRunners("e1")).resolves.toEqual([]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    orderResult = { data: null, error: { message: "boom" } };
    await expect(loadEmailRunners("e1")).resolves.toEqual([]);
    spy.mockRestore();
  });
});

describe("confirmation email senders", () => {
  // Six places build this email; one that forgot the runners would send a
  // different email depending on how the buyer paid.
  it.each([
    "src/server/payments/notifyEnrollmentConfirmed.ts",
    "src/server/notifications/dispatchPaymentApproved.ts",
    "src/app/api/webhooks/mmpay/route.ts",
    "src/app/api/webhooks/abank/route.ts",
    "src/app/api/public/payments/abank/status/route.ts",
    "src/app/api/admin/enrollments/[id]/resend-email/route.ts",
  ])("%s passes the order's runners", (file) => {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    const call = source.slice(source.indexOf("enrollmentApprovedEmail({"));
    expect(call.slice(0, call.indexOf("});"))).toContain("runners: await loadEmailRunners(");
  });
});
