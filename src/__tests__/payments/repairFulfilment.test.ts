import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Repairing an interrupted settlement ────────────────────────────────────
//
// Recording a payment, issuing tickets and sending the confirmation share one
// 10-second request. If it is cut off after the payment is written, the order is
// paid with no ticket and no email, and nothing else notices. Seen on staging
// with a slow database: both the callback and the status poll timed out there.

type Row = Record<string, unknown>;

const NOW = "2026-11-03T00:00:00.000Z";
const RECENT = "2026-11-02T15:20:51.636Z";

let enrollments: Row[];
let payments: Row[];
let tickets: Row[];
let claimError: { message: string } | null;

const mockIssueTickets = vi.fn();
vi.mock("@/server/tickets/issueTickets", () => ({
  issueTicketsForEnrollment: (...a: unknown[]) => mockIssueTickets(...a),
}));

const mockNotify = vi.fn();
vi.mock("@/server/payments/notifyEnrollmentConfirmed", () => ({
  notifyEnrollmentConfirmed: (...a: unknown[]) => mockNotify(...a),
}));

// Holds just enough state to prove the claim: the conditional update is applied
// the way the database would apply it, so a second claim really does find nothing.
function chainFor(table: string) {
  let filters: [string, unknown][] = [];
  let inFilter: [string, unknown[]] | null = null;
  let orFilter: string | null = null;
  let update: Row | null = null;
  let head = false;

  const rows = () => {
    const source = table === "enrollments" ? enrollments : table === "payments" ? payments : tickets;
    return source.filter((row) => {
      for (const [col, val] of filters) {
        if (col.includes(".")) continue;
        if (val === null ? row[col] != null : row[col] !== val) return false;
      }
      if (inFilter && !inFilter[1].includes(row[inFilter[0]])) return false;
      if (orFilter) {
        const before = /status_notified_at\.lt\."([^"]+)"/.exec(orFilter)![1];
        const stamp = row.status_notified_at as string | null;
        if (stamp !== null && !(stamp < before)) return false;
      }
      return true;
    });
  };

  const finish = async () => {
    if (update) {
      if (claimError) return { data: null, error: claimError };
      const matched = rows();
      matched.forEach((row) => Object.assign(row, update));
      return { data: matched, error: null };
    }
    const matched = rows();
    if (head) return { data: null, count: matched.length, error: null };
    return { data: matched, error: null };
  };

  const chain: Record<string, unknown> = {
    select: (_cols: string, opts?: { head?: boolean }) => { head = !!opts?.head; return chain; },
    update: (payload: Row) => { update = payload; return chain; },
    eq: (col: string, val: unknown) => { filters = [...filters, [col, val]]; return chain; },
    is: (col: string, val: unknown) => { filters = [...filters, [col, val]]; return chain; },
    in: (col: string, vals: unknown[]) => { inFilter = [col, vals]; return chain; },
    or: (expr: string) => { orFilter = expr; return chain; },
    not: () => chain,
    gte: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => {
      const { data, error } = await finish();
      return { data: (data as Row[] | null)?.[0] ?? null, error };
    },
    then: (resolve: (v: unknown) => unknown) => finish().then(resolve),
  };
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: chainFor }),
}));

const { repairInterruptedFulfilment, sendConfirmationOnce, sweepInterruptedFulfilment } =
  await import("@/server/payments/repairFulfilment");

function order(over: Row = {}, payment: Row = {}) {
  enrollments = [{
    id: "e-1", status: "confirmed", internal_test_at: null, status_notified_at: null,
    tenants: { org_type: "event" }, ...over,
  }];
  payments = [{ enrollment_id: "e-1", status: "verified", paid_at: RECENT, payment_method: "kbzpay_mmqr", ...payment }];
  tickets = [];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
  claimError = null;
  order();
  mockIssueTickets.mockImplementation(async (id: string) => {
    tickets.push({ enrollment_id: id, status: "valid" });
  });
  mockNotify.mockResolvedValue(undefined);
});

describe("repairInterruptedFulfilment", () => {
  it("issues the ticket and sends the email for a paid order left with neither", async () => {
    await repairInterruptedFulfilment("e-1");

    expect(mockIssueTickets).toHaveBeenCalledExactlyOnceWith("e-1");
    expect(mockNotify).toHaveBeenCalledExactlyOnceWith("e-1");
  });

  it("issues the ticket before sending the email, which attaches it", async () => {
    const calls: string[] = [];
    mockIssueTickets.mockImplementation(async () => { calls.push("tickets"); });
    mockNotify.mockImplementation(async () => { calls.push("email"); });

    await repairInterruptedFulfilment("e-1");

    expect(calls).toEqual(["tickets", "email"]);
  });

  it("sends one email when two requests repair the same order", async () => {
    await Promise.all([repairInterruptedFulfilment("e-1"), repairInterruptedFulfilment("e-1")]);

    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the order already has tickets", async () => {
    tickets = [{ enrollment_id: "e-1", status: "valid" }];

    await repairInterruptedFulfilment("e-1");

    expect(mockIssueTickets).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  // A voided ticket was voided on purpose. Replacing it would readmit someone.
  it("does not replace a voided ticket", async () => {
    tickets = [{ enrollment_id: "e-1", status: "void" }];

    await repairInterruptedFulfilment("e-1");

    expect(mockIssueTickets).not.toHaveBeenCalled();
  });

  it.each([
    ["an unconfirmed order", { status: "pending_payment" }],
    ["a rejected order", { status: "rejected" }],
    ["an archived test order", { internal_test_at: RECENT }],
    ["a language school order", { tenants: { org_type: "language_school" } }],
  ])("leaves %s alone", async (_name, over) => {
    order(over);

    await repairInterruptedFulfilment("e-1");

    expect(mockIssueTickets).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("issues nothing without a verified payment", async () => {
    order({}, { status: "awaiting_payment", paid_at: null });

    await repairInterruptedFulfilment("e-1");

    expect(mockIssueTickets).not.toHaveBeenCalled();
  });

  // `request_remaining` stamps status_notified_at, so reading any stamp as "the
  // confirmation went out" would cost a part-paid buyer their email.
  it("still emails when the only stamp predates this payment", async () => {
    order({ status_notified_at: "2026-11-01T00:00:00.000Z" });

    await repairInterruptedFulfilment("e-1");

    expect(mockNotify).toHaveBeenCalledOnce();
  });

  it("repairs an old order's ticket without emailing it out of the blue", async () => {
    order({}, { paid_at: "2026-10-01T00:00:00.000Z" });

    await repairInterruptedFulfilment("e-1");

    expect(mockIssueTickets).toHaveBeenCalledOnce();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  // Staff approval sends its own email and records no paid_at.
  it("repairs a staff-approved order's ticket without a second email", async () => {
    order({}, { paid_at: null });

    await repairInterruptedFulfilment("e-1");

    expect(mockIssueTickets).toHaveBeenCalledOnce();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  // Those webhooks send their own email with no claim, so a repair racing one
  // would send a second.
  it.each(["abank_mmqr", "mmqr", "paypay", "hitpay"])(
    "repairs a %s order's ticket without an email",
    async (payment_method) => {
      order({}, { payment_method });

      await repairInterruptedFulfilment("e-1");

      expect(mockIssueTickets).toHaveBeenCalledOnce();
      expect(mockNotify).not.toHaveBeenCalled();
    },
  );

  it.each(["kbzpay_mmqr", "cb_mmqr", "stripe"])("emails a %s order", async (payment_method) => {
    order({}, { payment_method });

    await repairInterruptedFulfilment("e-1");

    expect(mockNotify).toHaveBeenCalledOnce();
  });

  it("sends no email when the ticket could not be issued, and does not throw", async () => {
    mockIssueTickets.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(repairInterruptedFulfilment("e-1")).resolves.toBeUndefined();

    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("does not throw when the email fails", async () => {
    mockNotify.mockRejectedValueOnce(new Error("mail unavailable"));

    await expect(repairInterruptedFulfilment("e-1")).resolves.toBeUndefined();
  });
});

describe("sendConfirmationOnce", () => {
  it("sends once for one settlement", async () => {
    await sendConfirmationOnce("e-1", RECENT);
    await sendConfirmationOnce("e-1", RECENT);

    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  // The settlement's winner has always sent the email. A claim that can't be
  // written must not turn that into no email at all.
  it("still sends for the winner when the claim cannot be written", async () => {
    claimError = { message: "database unavailable" };

    await sendConfirmationOnce("e-1", RECENT);

    expect(mockNotify).toHaveBeenCalledOnce();
  });
});

describe("sweepInterruptedFulfilment", () => {
  it("repairs only the paid orders with no tickets", async () => {
    enrollments = [
      { id: "e-1", status: "confirmed", internal_test_at: null, status_notified_at: null, tenants: { org_type: "event" } },
      { id: "e-2", status: "confirmed", internal_test_at: null, status_notified_at: null, tenants: { org_type: "event" } },
    ];
    payments = [
      { enrollment_id: "e-1", status: "verified", paid_at: RECENT },
      { enrollment_id: "e-2", status: "verified", paid_at: RECENT },
    ];
    tickets = [{ enrollment_id: "e-2", status: "valid" }];

    const counts = await sweepInterruptedFulfilment();

    expect(mockIssueTickets).toHaveBeenCalledExactlyOnceWith("e-1");
    expect(counts).toEqual({ checked: 2, repaired: 1, readFailed: false });
  });
});
