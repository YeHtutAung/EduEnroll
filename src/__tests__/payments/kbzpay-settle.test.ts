import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── settleMmqrPayment ──────────────────────────────────────────────────────
// Spec §6. The ordering is load-bearing: currency is checked BEFORE the amount
// (R3), the transition is conditional so retries are idempotent, and this
// module never writes enrollments.status — trg_payments_sync_enrollment owns
// that (migration 049).

type Row = Record<string, unknown>;

let state: {
  payment: Row | null;
  reloaded: Row | null;
  enrollment: Row | null;
  updateRows: { id: string }[];
  updateError: { message: string } | null;
  claimRows: { id: string }[];
};

let paymentUpdates: Row[];
let enrollmentUpdates: Row[];
let claimFilters: string[];

const mockFrom = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockFrom }),
}));

const mockIssueTickets = vi.fn();
vi.mock("@/server/tickets/issueTickets", () => ({
  issueTicketsForEnrollment: (...a: unknown[]) => mockIssueTickets(...a),
}));

const mockNotify = vi.fn();
vi.mock("@/server/payments/notifyEnrollmentConfirmed", () => ({
  notifyEnrollmentConfirmed: (...a: unknown[]) => mockNotify(...a),
}));

const mockWaitUntil = vi.fn();
vi.mock("@vercel/functions", () => ({
  waitUntil: (...a: unknown[]) => mockWaitUntil(...a),
}));

const mockSendPending = vi.fn();
vi.mock("@/server/conversions/sendPendingConversions", () => ({
  sendPendingConversions: (...a: unknown[]) => mockSendPending(...a),
}));

const { settleMmqrPayment } = await import("@/server/payments/settleMmqrPayment");

const PAYMENT = {
  id: "pay-1",
  enrollment_id: "enr-1",
  tenant_id: "ten-1",
  status: "awaiting_payment",
  amount: 40000,
};

beforeEach(() => {
  vi.clearAllMocks();
  paymentUpdates = [];
  enrollmentUpdates = [];
  state = {
    payment: { ...PAYMENT },
    reloaded: null,
    enrollment: { id: "enr-1", status: "confirmed" },
    updateRows: [{ id: "pay-1" }],
    updateError: null,
    claimRows: [{ id: "enr-1" }],
  };
  claimFilters = [];
  mockIssueTickets.mockResolvedValue(undefined);
  mockNotify.mockResolvedValue(undefined);

  mockFrom.mockImplementation((table: string) => {
    if (table === "payments") {
      return {
        select: () => ({
          eq: (col: string) => ({
            maybeSingle: async () => ({
              data: col === "payment_ref" ? state.payment : (state.reloaded ?? state.payment),
              error: null,
            }),
          }),
        }),
        update: (payload: Row) => {
          paymentUpdates.push(payload);
          return {
            eq: () => ({
              in: () => ({
                select: async () => ({ data: state.updateRows, error: state.updateError }),
              }),
            }),
          };
        },
      };
    }
    if (table === "enrollments") {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: state.enrollment, error: null }) }),
        }),
        update: (payload: Row) => {
          enrollmentUpdates.push(payload);
          return {
            eq: () => ({
              or: (filter: string) => {
                claimFilters.push(filter);
                return { select: async () => ({ data: state.claimRows, error: null }) };
              },
            }),
          };
        },
      };
    }
    throw new Error(`unexpected table: ${table}`);
  });
});

const settle = (over: Partial<Parameters<typeof settleMmqrPayment>[0]> = {}) =>
  settleMmqrPayment({
    paymentRef: "KBZ_1a2b3c4d_9f3c",
    observedAmount: 40000,
    observedCurrency: "MMK",
    mmOrderId: "01003791060036848066",
    walletIdentifier: "MCB",
    source: "callback",
    ...over,
  });

describe("currency guard (R3)", () => {
  it("refuses to settle when the currency is not MMK", async () => {
    const r = await settle({ observedCurrency: "USD" });
    expect(r.kind).toBe("currency_mismatch");
    expect(paymentUpdates).toHaveLength(0);
  });

  it("refuses when the currency is missing entirely", async () => {
    const r = await settle({ observedCurrency: null });
    expect(r.kind).toBe("currency_mismatch");
    expect(paymentUpdates).toHaveLength(0);
  });

  // An amount is meaningless without its currency: 40000 USD must never settle
  // a 40000 MMK enrollment. So the currency test comes FIRST.
  it("checks currency before the amount, so a matching amount cannot rescue it", async () => {
    const r = await settle({ observedCurrency: "USD", observedAmount: 40000 });
    expect(r.kind).toBe("currency_mismatch");
  });
});

describe("amount guard", () => {
  it("refuses when the amount does not match the stored snapshot", async () => {
    const r = await settle({ observedAmount: 10000 });
    expect(r.kind).toBe("amount_mismatch");
    expect(paymentUpdates).toHaveLength(0);
  });

  it("validates against the payments.amount snapshot, not a recomputed fee", async () => {
    // The snapshot was written at order-create time; class config may have
    // changed since. 40000 is what the student was quoted.
    state.payment = { ...PAYMENT, amount: 40000 };
    expect((await settle({ observedAmount: 40000 })).kind).toBe("settled");
  });
});

describe("settlement", () => {
  it("settles a matching payment and issues tickets", async () => {
    const r = await settle();

    expect(r).toMatchObject({ kind: "settled", paymentId: "pay-1", enrollmentId: "enr-1" });
    expect(paymentUpdates).toHaveLength(1);
    expect(paymentUpdates[0]).toMatchObject({
      status: "verified",
      mmqr_status: "SUCCESS",
      bank_reference: "01003791060036848066",
      payer_institution: "MCB",
    });
    expect(paymentUpdates[0].paid_at).toBeTruthy();
    expect(mockIssueTickets).toHaveBeenCalledWith("enr-1");
    expect(mockNotify).toHaveBeenCalledWith("enr-1");
  });

  // trg_payments_sync_enrollment confirms the enrollment in the SAME statement
  // as the payment transition. Writing it here as well would be a second,
  // unsynchronised source of truth.
  it("NEVER writes enrollments.status", async () => {
    await settle();
    expect(enrollmentUpdates.filter((u) => "status" in u)).toHaveLength(0);
  });

  // A status poll can reach a verified order while the winner is still working,
  // repair it, and send the email first.
  it("sends no second email when a repair already claimed it", async () => {
    state.claimRows = [];

    const outcome = await settle();

    expect(outcome.kind).toBe("settled");
    expect(mockIssueTickets).toHaveBeenCalledWith("enr-1");
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("claims the email against this settlement's paid_at", async () => {
    await settle();

    expect(enrollmentUpdates[0]).toHaveProperty("status_notified_at");
    expect(claimFilters[0]).toBe(`status_notified_at.is.null,status_notified_at.lt."${paymentUpdates[0].paid_at}"`);
  });

  it("returns already_settled when the conditional update affects zero rows", async () => {
    state.updateRows = [];
    state.reloaded = { id: "pay-1", status: "verified" };

    const r = await settle();

    expect(r.kind).toBe("already_settled");
    // Fulfilment still runs — it repairs a partial ticket set …
    expect(mockIssueTickets).toHaveBeenCalledWith("enr-1");
    // … but the notification belongs to the transition winner only.
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("is idempotent across KBZPay's 60s and 600s retries", async () => {
    const first = await settle();
    expect(first.kind).toBe("settled");

    state.updateRows = [];
    state.reloaded = { id: "pay-1", status: "verified" };
    const second = await settle();
    const third = await settle();

    expect(second.kind).toBe("already_settled");
    expect(third.kind).toBe("already_settled");
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });
});

describe("failure modes", () => {
  it("returns not_found for an unknown payment_ref", async () => {
    state.payment = null;
    const r = await settle();
    expect(r.kind).toBe("not_found");
    expect(paymentUpdates).toHaveLength(0);
  });

  it("returns retryable when fulfilment throws after settlement", async () => {
    mockIssueTickets.mockRejectedValue(new Error("ticket store unavailable"));
    const r = await settle();
    // The money is recorded; the retry repairs the tickets.
    expect(r.kind).toBe("retryable");
  });

  it("does not fail the settlement when only the notification throws", async () => {
    mockNotify.mockRejectedValue(new Error("smtp down"));
    const r = await settle();
    expect(r.kind).toBe("settled");
  });

  it("returns retryable when the conditional update errors", async () => {
    state.updateError = { message: "deadlock detected" };
    state.updateRows = [];
    const r = await settle();
    expect(r.kind).toBe("retryable");
  });

  it("does not settle against a rejected enrollment", async () => {
    state.enrollment = { id: "enr-1", status: "rejected" };
    const r = await settle();
    expect(r.kind).toBe("retryable");
    expect(mockIssueTickets).not.toHaveBeenCalled();
  });
});

// The rest of this file replaces issueTickets, which is where the sender starts.
// So these run the real one, over a tenant lookup that decides what it does.
describe("purchase conversion sender", () => {
  const useRealIssueTickets = async (tenant: { data: Row | null; error: { message: string } | null }) => {
    const actual = await vi.importActual<typeof import("@/server/tickets/issueTickets")>(
      "@/server/tickets/issueTickets",
    );
    mockIssueTickets.mockImplementation(actual.issueTicketsForEnrollment);
    state.enrollment = { id: "enr-1", tenant_id: "ten-1", class_id: "c1", quantity: 1, status: "confirmed" };
    const tablesBefore = mockFrom.getMockImplementation()!;
    mockFrom.mockImplementation((table: string) =>
      table === "tenants"
        ? { select: () => ({ eq: () => ({ maybeSingle: async () => tenant }) }) }
        : tablesBefore(table),
    );
  };
  const neverSettles = new Promise<void>(() => undefined);
  const WAITING = "still waiting";
  const outcomeOf = <T,>(p: Promise<T>) =>
    Promise.race([p, new Promise<typeof WAITING>((resolve) => setTimeout(() => resolve(WAITING), 200))]);

  it("does not stop the buyer's confirmation when it never settles", async () => {
    await useRealIssueTickets({ data: { org_type: "language_school" }, error: null });
    mockSendPending.mockReturnValue(neverSettles);

    const r = await outcomeOf(settle());

    expect(r).toMatchObject({ kind: "settled", paymentId: "pay-1" });
    expect(mockSendPending).toHaveBeenCalledExactlyOnceWith("enr-1");
    expect(mockWaitUntil.mock.calls[0][0]).toBe(neverSettles);
    expect(mockNotify).toHaveBeenCalledExactlyOnceWith("enr-1");
  });

  it("still returns retryable when fulfilment throws, with the sender running", async () => {
    await useRealIssueTickets({ data: null, error: { message: "connection reset" } });
    mockSendPending.mockReturnValue(neverSettles);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const r = await outcomeOf(settle());

    expect(r).toMatchObject({ kind: "retryable" });
    expect(mockSendPending).toHaveBeenCalledExactlyOnceWith("enr-1");
    expect(mockNotify).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
