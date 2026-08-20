import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── POST /api/public/payments/kbzpay ───────────────────────────────────────
// Spec §5.1 and §5.1a. The route composes the claim function, the resolve
// procedure and precreate. Its job is ordering and translation:
//
//   - the payment row is inserted BEFORE any KBZPay call (R2)
//   - a failed precreate NEVER marks the row terminal (R13)
//   - no settleMmqrPayment result object reaches the browser (R10/R11/R12)

type Row = Record<string, unknown>;

let enrollment: Row | null;
let claimRows: Row[];
let claimError: { message: string } | null;
let supersedeRows: Row[];
let paymentUpdates: Row[];
let enrollmentUpdates: Row[];
let rpcCalls: { name: string; args: Row }[];
let updateError: { message: string } | null;

const mockResolveTenantId = vi.fn();
vi.mock("@/lib/api", () => ({
  resolveTenantId: () => mockResolveTenantId(),
}));

const mockFrom = vi.fn();
const mockRpc = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockFrom, rpc: mockRpc }),
}));

const mockPrecreate = vi.fn();
vi.mock("@/lib/kbzpay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/kbzpay")>();
  return { ...actual, precreate: (...a: unknown[]) => mockPrecreate(...a) };
});

const mockResolve = vi.fn();
vi.mock("@/server/payments/resolveKbzpayOrder", () => ({
  resolveKbzpayOrder: (...a: unknown[]) => mockResolve(...a),
}));

vi.mock("@/lib/origin", () => ({
  platformOrigin: () => "https://www.kuunyi.com",
}));

const { POST } = await import("@/app/api/public/payments/kbzpay/route");

const ENROLLMENT = {
  id: "1a2b3c4d-5e6f-7788-99aa-bbccddeeff00",
  enrollment_ref: "ENR-1",
  tenant_id: "ten-1",
  class_id: "cls-1",
  quantity: 2,
  status: "pending_payment",
  student_name_en: "Test Student",
  classes: { id: "cls-1", fee_amount: 20000, level: "N5" },
  enrollment_items: null,
};

const req = (body: unknown = { enrollmentRef: "ENR-1" }) =>
  new NextRequest("https://t.kuunyi.com/api/public/payments/kbzpay", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  vi.clearAllMocks();
  enrollment = { ...ENROLLMENT };
  claimRows = [{ outcome: "created", payment_id: "pay-1", ref: null, qr: null }];
  claimError = null;
  supersedeRows = [{ outcome: "replaced", payment_id: "pay-2" }];
  paymentUpdates = [];
  enrollmentUpdates = [];
  rpcCalls = [];
  updateError = null;

  mockResolveTenantId.mockResolvedValue("ten-1");
  mockPrecreate.mockResolvedValue({ ok: true, qrCode: "0002010102QR", prepayId: "KBZ00abc" });

  mockFrom.mockImplementation((table: string) => {
    if (table === "enrollments") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({ single: async () => ({ data: enrollment, error: null }) }),
          }),
        }),
        update: (payload: Row) => {
          enrollmentUpdates.push(payload);
          return { eq: async () => ({ data: null, error: null }) };
        },
      };
    }
    if (table === "payments") {
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({ single: async () => ({ data: null, error: null }) }),
            }),
          }),
        }),
        update: (payload: Row) => {
          paymentUpdates.push(payload);
          return { eq: async () => ({ data: null, error: updateError }) };
        },
      };
    }
    throw new Error(`unexpected table: ${table}`);
  });

  mockRpc.mockImplementation(async (name: string, args: Row) => {
    rpcCalls.push({ name, args });
    if (name === "claim_kbzpay_order_slot") {
      // Mirror the real function: the 'created' branch returns the ref it was
      // given (`RETURN QUERY SELECT 'created', v_new_id, p_payment_ref, NULL`).
      // Verified against the real database in kbzpay-order-slot.db.test.ts.
      const rows = claimRows.map((r) =>
        r.outcome === "created" && r.ref === null ? { ...r, ref: args.p_payment_ref } : r,
      );
      return { data: rows, error: claimError };
    }
    if (name === "complete_kbzpay_supersede") return { data: supersedeRows, error: null };
    throw new Error(`unexpected rpc: ${name}`);
  });
});

const json = async (res: Response) => JSON.parse(await res.text());

describe("guards", () => {
  it("returns 404 for an unknown enrollment", async () => {
    enrollment = null;
    const res = await POST(req());
    expect(res.status).toBe(404);
    expect(mockPrecreate).not.toHaveBeenCalled();
  });

  it.each(["confirmed", "rejected", "payment_submitted"])(
    "returns 409 when the enrollment is %s",
    async (status) => {
      enrollment = { ...ENROLLMENT, status };
      const res = await POST(req());
      expect(res.status).toBe(409);
      expect(mockRpc).not.toHaveBeenCalled();
    },
  );

  it("returns 400 for a missing enrollmentRef", async () => {
    expect((await POST(req({}))).status).toBe(400);
  });
});

describe("ordering — row before provider call (R2)", () => {
  it("claims the slot before calling precreate", async () => {
    await POST(req());

    expect(rpcCalls[0].name).toBe("claim_kbzpay_order_slot");
    expect(mockPrecreate).toHaveBeenCalledTimes(1);
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrecreate.mock.invocationCallOrder[0],
    );
  });

  it("never calls KBZPay when the claim errors", async () => {
    claimError = { message: "deadlock" };
    claimRows = [];

    const res = await POST(req());

    expect(res.status).toBe(502);
    expect(mockPrecreate).not.toHaveBeenCalled();
  });

  it("passes the computed fee and a valid merch_order_id to the claim", async () => {
    await POST(req());

    const args = rpcCalls[0].args;
    expect(args.p_amount).toBe(40000); // 20000 × quantity 2
    expect(args.p_enrollment_id).toBe(ENROLLMENT.id);
    expect(args.p_tenant_id).toBe("ten-1");
    expect(String(args.p_payment_ref)).toMatch(/^[A-Za-z0-9_]{1,40}$/);
  });

  it("builds notify_url from platformOrigin, never the inbound Host", async () => {
    await POST(req());

    expect(mockPrecreate).toHaveBeenCalledWith(
      expect.objectContaining({ notifyUrl: "https://www.kuunyi.com/api/webhooks/kbzpay" }),
    );
  });
});

describe("claim outcomes", () => {
  it("returns the stored QR on reuse without calling KBZPay", async () => {
    claimRows = [{ outcome: "reuse", payment_id: "pay-9", ref: "KBZ_old", qr: "STOREDQR" }];

    const res = await POST(req());
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: "created", qr: "STOREDQR", orderId: "KBZ_old" });
    expect(mockPrecreate).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  // P1 review: the enrollment stopped being a legal payment target between the
  // route's guard and the function's lock.
  it("returns 409 for invalid_enrollment and never calls KBZPay", async () => {
    claimRows = [{ outcome: "invalid_enrollment", payment_id: null, ref: null, qr: null }];

    const res = await POST(req());

    expect(res.status).toBe(409);
    expect(mockPrecreate).not.toHaveBeenCalled();
  });

  it("returns the created shape on the happy path", async () => {
    const res = await POST(req());
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body).toEqual({
      status: "created",
      qr: "0002010102QR",
      orderId: expect.stringMatching(/^KBZ_/),
      amount: 40000,
    });
  });
});

describe("unresolved → resolve procedure", () => {
  beforeEach(() => {
    claimRows = [{ outcome: "unresolved", payment_id: "pay-old", ref: "KBZ_old", qr: null }];
  });

  // R10/R11/R12: all three already-paid branches return the SAME browser shape.
  it("returns { status: 'already_paid' } when resolve reports already_paid", async () => {
    mockResolve.mockResolvedValue({ kind: "already_paid" });

    const res = await POST(req());
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "already_paid" });
    expect(body.qr).toBeUndefined();
    expect(body.orderId).toBeUndefined();
    expect(mockPrecreate).not.toHaveBeenCalled();
  });

  it("returns { status: 'already_paid' } when the supersede races a callback (R11)", async () => {
    mockResolve.mockResolvedValue({ kind: "retire", reason: "SUPERSEDED" });
    supersedeRows = [{ outcome: "already_settled", payment_id: "pay-old" }];

    const res = await POST(req());

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ status: "already_paid" });
    expect(mockPrecreate).not.toHaveBeenCalled();
  });

  it.each(["amount_mismatch", "currency_mismatch"])(
    "returns 409 on settlement conflict %s rather than a QR",
    async (reason) => {
      mockResolve.mockResolvedValue({ kind: "settlement_conflict", reason });

      const res = await POST(req());

      expect(res.status).toBe(409);
      expect((await json(res)).qr).toBeUndefined();
      expect(mockPrecreate).not.toHaveBeenCalled();
    },
  );

  it("returns 502 when resolve is blocked, changing nothing", async () => {
    mockResolve.mockResolvedValue({ kind: "blocked", reason: "close failed" });

    const res = await POST(req());

    expect(res.status).toBe(502);
    expect(mockPrecreate).not.toHaveBeenCalled();
    expect(rpcCalls.filter((c) => c.name === "complete_kbzpay_supersede")).toHaveLength(0);
  });

  it("supersedes with the reason resolve produced, then precreates", async () => {
    mockResolve.mockResolvedValue({ kind: "retire", reason: "EXPIRED" });

    const res = await POST(req());

    const call = rpcCalls.find((c) => c.name === "complete_kbzpay_supersede")!;
    expect(call.args.p_reason).toBe("EXPIRED");
    expect(call.args.p_expected_old_ref).toBe("KBZ_old");
    expect(res.status).toBe(200);
    expect(mockPrecreate).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when the supersede reports invalid_enrollment", async () => {
    mockResolve.mockResolvedValue({ kind: "retire", reason: "SUPERSEDED" });
    supersedeRows = [{ outcome: "invalid_enrollment", payment_id: null }];

    expect((await POST(req())).status).toBe(409);
    expect(mockPrecreate).not.toHaveBeenCalled();
  });
});

describe("ambiguous creation states (R13)", () => {
  // A failed precreate proves our REQUEST failed, never that KBZPay created
  // nothing. Marking the row terminal here would free the slot and allow a
  // second order beside one KBZPay may already hold.
  it("leaves the row PENDING when precreate fails — never FAILED", async () => {
    mockPrecreate.mockResolvedValue({ ok: false });

    const res = await POST(req());

    expect(res.status).toBe(502);
    expect(paymentUpdates.some((u) => u.mmqr_status === "FAILED")).toBe(false);
    expect(paymentUpdates.some((u) => u.status === "rejected")).toBe(false);
  });

  // Setting payments.status='rejected' would cascade through
  // trg_payments_sync_enrollment and reject the student's enrollment because
  // OUR outbound call failed.
  it("never touches the enrollment when precreate fails", async () => {
    mockPrecreate.mockResolvedValue({ ok: false });
    await POST(req());
    expect(enrollmentUpdates).toHaveLength(0);
  });

  it("leaves the row PENDING when the provider_qr write fails", async () => {
    updateError = { message: "write failed" };

    const res = await POST(req());

    expect(res.status).toBe(502);
    expect(paymentUpdates.some((u) => u.mmqr_status === "FAILED")).toBe(false);
  });

  it("stores the QR and re-anchors the expiry after a successful precreate", async () => {
    await POST(req());

    expect(paymentUpdates).toHaveLength(1);
    expect(paymentUpdates[0].provider_qr).toBe("0002010102QR");
    expect(paymentUpdates[0].provider_order_expires_at).toBeTruthy();
  });
});

describe("browser contract (§5.1a)", () => {
  it("never leaks a settleMmqrPayment result object", async () => {
    claimRows = [{ outcome: "unresolved", payment_id: "pay-old", ref: "KBZ_old", qr: null }];
    mockResolve.mockResolvedValue({ kind: "already_paid" });

    const body = await json(await POST(req()));

    for (const leaked of ["kind", "paymentId", "enrollmentId"]) {
      expect(body).not.toHaveProperty(leaked);
    }
  });

  it("always carries a status discriminant on success", async () => {
    expect((await json(await POST(req()))).status).toBe("created");
  });
});
