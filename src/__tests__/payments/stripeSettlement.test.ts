// S-suite (Plan v18 Tests "Settlement contract") — mocked control flow over
// settlePaidPayment and handleStripePaymentFailure. The db/route suites prove
// the trigger and RPC behaviour; this suite pins the operations' decision
// tables: which branch runs, which conflict is recorded, which outcomes are
// retryable, and that the failure path never reaches the paid path.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFrom = vi.fn();
const mockRpc = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockFrom, rpc: mockRpc }),
}));

const mockIssue = vi.fn();
vi.mock("@/server/tickets/issueTickets", () => ({
  issueTicketsForEnrollment: (...a: unknown[]) => mockIssue(...a),
}));

const { settlePaidPayment } = await import("@/server/payments/settlePaidPayment");
const { handleStripePaymentFailure } = await import("@/server/payments/handleStripePaymentFailure");

// ── Chain builder ─────────────────────────────────────────────────────────────
// Each .from(table) call consumes the next queued response for that table.
// Chains resolve at .maybeSingle() or at .select() after .update() — matching
// how the operations terminate their queries.
type Resp = { data: unknown; error: { message: string } | null };
let queues: Record<string, Resp[]>;

function queue(table: string, resp: Resp) {
  (queues[table] ??= []).push(resp);
}

function chainFor(table: string) {
  const next = (): Resp => {
    const q = queues[table];
    if (!q || q.length === 0) throw new Error(`no queued response for table ${table}`);
    return q.shift()!;
  };
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "update", "eq", "in"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.maybeSingle = vi.fn(async () => next());
  // update().….select() resolves the update; select() directly after from()
  // returns the chain (locate path goes through maybeSingle).
  let updateCalled = false;
  (chain.update as ReturnType<typeof vi.fn>).mockImplementation(() => {
    updateCalled = true;
    return chain;
  });
  (chain.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
    if (updateCalled) {
      updateCalled = false;
      return Promise.resolve(next());
    }
    return chain;
  });
  return chain;
}

const PAYMENT = {
  id: "pay-1",
  enrollment_id: "enr-1",
  tenant_id: "ten-1",
  status: "awaiting_payment",
  provider_amount_minor: 10000,
  provider_currency: "sgd",
};

const paidInput = (over?: Partial<Parameters<typeof settlePaidPayment>[0]>) => ({
  paymentIntentId: "pi_1",
  observedAmountMinor: 10000,
  observedCurrency: "sgd",
  source: { type: "webhook_event" as const, id: "evt_1" },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  queues = {};
  mockFrom.mockImplementation((table: string) => chainFor(table));
  mockRpc.mockResolvedValue({ data: null, error: null });
  mockIssue.mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
describe("settlePaidPayment — happy path and replay", () => {
  it("settles: conditional update wins, enrollment confirmed, tickets issued, outcome 'settled'", async () => {
    queue("payments", { data: PAYMENT, error: null }); // locate
    queue("payments", { data: [{ id: "pay-1" }], error: null }); // update won
    queue("enrollments", { data: { id: "enr-1", status: "confirmed" }, error: null });
    const out = await settlePaidPayment(paidInput());
    expect(out).toEqual({ kind: "settled", paymentId: "pay-1", enrollmentId: "enr-1" });
    expect(mockIssue).toHaveBeenCalledExactlyOnceWith("enr-1");
    expect(mockRpc).not.toHaveBeenCalled(); // no conflict recorded
  });

  it("S3: already-verified replay goes straight to fulfilment repair (already_settled)", async () => {
    queue("payments", { data: { ...PAYMENT, status: "verified" }, error: null });
    queue("enrollments", { data: { id: "enr-1", status: "confirmed" }, error: null });
    const out = await settlePaidPayment(paidInput());
    expect(out.kind).toBe("already_settled");
    expect(mockIssue).toHaveBeenCalledExactlyOnceWith("enr-1"); // repair runs
  });

  it("S3b: verified row with NULL snapshot still repairs — snapshot gates the transition, not the replay", async () => {
    // Every pre-plan verified row has a null snapshot. Blocking the replay
    // branch on it would break #188's fulfilment repair for exactly the
    // historical orders it shipped to fix.
    queue("payments", {
      data: { ...PAYMENT, status: "verified", provider_amount_minor: null, provider_currency: null },
      error: null,
    });
    queue("enrollments", { data: { id: "enr-1", status: "confirmed" }, error: null });
    const out = await settlePaidPayment(paidInput());
    expect(out.kind).toBe("already_settled");
    expect(mockIssue).toHaveBeenCalledExactlyOnceWith("enr-1");
    expect(mockRpc).not.toHaveBeenCalled(); // no missing_contract_snapshot conflict
  });

  it("zero-row race: reload finds verified → already_settled via the shared path", async () => {
    queue("payments", { data: PAYMENT, error: null }); // active at locate
    queue("payments", { data: [], error: null }); // update lost the race
    queue("payments", { data: { id: "pay-1", status: "verified" }, error: null }); // reload
    queue("enrollments", { data: { id: "enr-1", status: "confirmed" }, error: null });
    const out = await settlePaidPayment(paidInput());
    expect(out.kind).toBe("already_settled");
  });
});

describe("settlePaidPayment — snapshot validation (S7, S8, S9)", () => {
  it("S9: null snapshot → missing_contract_snapshot, no settlement update, no tickets", async () => {
    queue("payments", { data: { ...PAYMENT, provider_amount_minor: null }, error: null });
    const out = await settlePaidPayment(paidInput());
    expect(out).toEqual({ kind: "conflict", conflictType: "missing_contract_snapshot" });
    expect(mockRpc).toHaveBeenCalledExactlyOnceWith(
      "record_stripe_conflict",
      expect.objectContaining({ p_conflict_type: "missing_contract_snapshot" }),
    );
    expect(mockIssue).not.toHaveBeenCalled();
  });

  it("S7: amount mismatch → conflict, no settlement", async () => {
    queue("payments", { data: PAYMENT, error: null });
    const out = await settlePaidPayment(paidInput({ observedAmountMinor: 9999 }));
    expect(out).toEqual({ kind: "conflict", conflictType: "amount_mismatch" });
    expect(mockIssue).not.toHaveBeenCalled();
  });

  it("S8: currency mismatch → conflict, no settlement", async () => {
    queue("payments", { data: PAYMENT, error: null });
    const out = await settlePaidPayment(paidInput({ observedCurrency: "usd" }));
    expect(out).toEqual({ kind: "conflict", conflictType: "currency_mismatch" });
  });

  it("uppercase observed currency matches the canonical stored snapshot", async () => {
    queue("payments", { data: PAYMENT, error: null });
    queue("payments", { data: [{ id: "pay-1" }], error: null });
    queue("enrollments", { data: { id: "enr-1", status: "confirmed" }, error: null });
    const out = await settlePaidPayment(paidInput({ observedCurrency: "SGD" }));
    expect(out.kind).toBe("settled");
  });
});

describe("settlePaidPayment — zero-row reload table (S4, S5)", () => {
  it("S4: reloaded 'rejected' → payment_already_rejected conflict, NOT already-settled", async () => {
    queue("payments", { data: PAYMENT, error: null });
    queue("payments", { data: [], error: null });
    queue("payments", { data: { id: "pay-1", status: "rejected" }, error: null });
    const out = await settlePaidPayment(paidInput());
    expect(out).toEqual({ kind: "conflict", conflictType: "payment_already_rejected" });
    expect(mockIssue).not.toHaveBeenCalled();
  });

  it("S5: row absent on reload → retryable (500)", async () => {
    queue("payments", { data: PAYMENT, error: null });
    queue("payments", { data: [], error: null });
    queue("payments", { data: null, error: null });
    const out = await settlePaidPayment(paidInput());
    expect(out.kind).toBe("retryable");
  });

  it("no payment row at locate → retryable (500), never a silent 200", async () => {
    queue("payments", { data: null, error: null });
    const out = await settlePaidPayment(paidInput());
    expect(out.kind).toBe("retryable");
  });

  it("reloaded unexpected state → unexpected_payment_state conflict", async () => {
    queue("payments", { data: PAYMENT, error: null });
    queue("payments", { data: [], error: null });
    queue("payments", { data: { id: "pay-1", status: "partial" }, error: null });
    const out = await settlePaidPayment(paidInput());
    expect(out).toEqual({ kind: "conflict", conflictType: "unexpected_payment_state" });
  });
});

describe("settlePaidPayment — post-settlement classification (S1, S2, S6)", () => {
  it("S6: already-verified + rejected enrollment → conflict, no silent success", async () => {
    queue("payments", { data: { ...PAYMENT, status: "verified" }, error: null });
    queue("enrollments", { data: { id: "enr-1", status: "rejected" }, error: null });
    const out = await settlePaidPayment(paidInput());
    expect(out).toEqual({ kind: "conflict", conflictType: "rejected_enrollment" });
    expect(mockIssue).not.toHaveBeenCalled(); // no ticket for a rejected enrollment
  });

  it("S1: settlement statement fails → retryable, nothing else runs", async () => {
    queue("payments", { data: PAYMENT, error: null });
    queue("payments", { data: null, error: { message: "boom" } });
    const out = await settlePaidPayment(paidInput());
    expect(out.kind).toBe("retryable");
    expect(mockIssue).not.toHaveBeenCalled();
  });

  it("S2: fulfilment fails AFTER settlement → throws (route returns 500), settlement stands", async () => {
    queue("payments", { data: PAYMENT, error: null });
    queue("payments", { data: [{ id: "pay-1" }], error: null });
    queue("enrollments", { data: { id: "enr-1", status: "confirmed" }, error: null });
    mockIssue.mockRejectedValue(new Error("ticket query failed"));
    await expect(settlePaidPayment(paidInput())).rejects.toThrow("ticket query failed");
  });

  it("unexpected enrollment state → unexpected_enrollment_state conflict, no tickets", async () => {
    queue("payments", { data: PAYMENT, error: null });
    queue("payments", { data: [{ id: "pay-1" }], error: null });
    queue("enrollments", { data: { id: "enr-1", status: "pending_payment" }, error: null });
    const out = await settlePaidPayment(paidInput());
    expect(out).toEqual({ kind: "conflict", conflictType: "unexpected_enrollment_state" });
    expect(mockIssue).not.toHaveBeenCalled();
  });
});

describe("settlePaidPayment — conflict write failures (S10)", () => {
  it("S10: conflict insert fails → throws (route returns 500)", async () => {
    queue("payments", { data: { ...PAYMENT, provider_amount_minor: null }, error: null });
    mockRpc.mockResolvedValue({ data: null, error: { message: "rpc down" } });
    await expect(settlePaidPayment(paidInput())).rejects.toThrow(/conflict record failed/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("handleStripePaymentFailure — §5b transition table", () => {
  const failInput = { sessionId: "cs_1", source: { type: "webhook_event" as const, id: "evt_f" } };

  it("active payment → rejected; enrollments NEVER written by this operation", async () => {
    queue("payments", { data: [{ id: "pay-1" }], error: null }); // conditional update won
    const out = await handleStripePaymentFailure(failInput);
    expect(out).toEqual({ kind: "rejected", paymentId: "pay-1" });
    expect(mockFrom).not.toHaveBeenCalledWith("enrollments");
  });

  it("duplicate failed event → replay, idempotent, no conflict", async () => {
    queue("payments", { data: [], error: null });
    queue("payments", { data: { id: "pay-1", enrollment_id: "enr-1", status: "rejected" }, error: null });
    const out = await handleStripePaymentFailure(failInput);
    expect(out).toEqual({ kind: "replay" });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("stale failure on a VERIFIED payment → failure_after_verified conflict, status untouched", async () => {
    queue("payments", { data: [], error: null });
    queue("payments", { data: { id: "pay-1", enrollment_id: "enr-1", status: "verified" }, error: null });
    const out = await handleStripePaymentFailure(failInput);
    expect(out).toEqual({ kind: "conflict", conflictType: "failure_after_verified" });
    expect(mockRpc).toHaveBeenCalledExactlyOnceWith(
      "record_stripe_conflict",
      expect.objectContaining({ p_conflict_type: "failure_after_verified" }),
    );
  });

  it("no matching row → retryable (500)", async () => {
    queue("payments", { data: [], error: null });
    queue("payments", { data: null, error: null });
    const out = await handleStripePaymentFailure(failInput);
    expect(out.kind).toBe("retryable");
  });

  it("update statement fails → retryable (500)", async () => {
    queue("payments", { data: null, error: { message: "db down" } });
    const out = await handleStripePaymentFailure(failInput);
    expect(out.kind).toBe("retryable");
  });

  it("conflict write fails → throws (route returns 500)", async () => {
    queue("payments", { data: [], error: null });
    queue("payments", { data: { id: "pay-1", enrollment_id: "enr-1", status: "verified" }, error: null });
    mockRpc.mockResolvedValue({ data: null, error: { message: "rpc down" } });
    await expect(handleStripePaymentFailure(failInput)).rejects.toThrow(/conflict record failed/);
  });

  it("R15 precondition: the failure operation never imports or invokes the paid path", async () => {
    // Module-level separation: handleStripePaymentFailure's module must not
    // reference settlePaidPayment at all — a shared entry point is how the
    // paid path would be reached.
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/server/payments/handleStripePaymentFailure.ts", "utf8");
    // No import of it, no call to it. (A comment may NAME it to explain the
    // separation — that is documentation, not a code path.)
    expect(src).not.toMatch(/import[^;]*settlePaidPayment/);
    expect(src).not.toMatch(/settlePaidPayment\s*\(/);
  });
});
