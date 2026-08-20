import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
let autoCancelMinutes: number | null;
let tenantError: { message: string } | null;
let tenantMissing: boolean;

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
const { orderWindow } = await import("@/server/payments/kbzpayOrderWindow");

const ENROLLMENT = {
  id: "1a2b3c4d-5e6f-7788-99aa-bbccddeeff00",
  enrollment_ref: "ENR-1",
  tenant_id: "ten-1",
  class_id: "cls-1",
  quantity: 2,
  status: "pending_payment",
  enrolled_at: new Date().toISOString(), // fresh by default
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
  autoCancelMinutes = 15; // tenant setting: 15 MINUTES (column is misnamed _hours)
  tenantError = null;
  tenantMissing = false;

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
    if (table === "tenants") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: tenantMissing ? null : { auto_cancel_hours: autoCancelMinutes },
              error: tenantError,
            }),
          }),
        }),
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
      expect.objectContaining({ notifyUrl: "https://www.kuunyi.com/api/webhooks/kbzmmqr" }),
    );
  });
});

// KBZPay registers a callback host per environment, and the host they register
// must match what we send per order. KBZPAY_NOTIFY_ORIGIN is the operator-set,
// per-deployment value for that — never derived from the request or from
// whichever tenant is checking out (spec §7).
describe("KBZPAY_NOTIFY_ORIGIN", () => {
  afterEach(() => {
    delete process.env.KBZPAY_NOTIFY_ORIGIN;
  });

  it("overrides the notify_url origin when set", async () => {
    process.env.KBZPAY_NOTIFY_ORIGIN = "https://brave.kuunyi.com";

    await POST(req());

    expect(mockPrecreate).toHaveBeenCalledWith(
      expect.objectContaining({ notifyUrl: "https://brave.kuunyi.com/api/webhooks/kbzmmqr" }),
    );
  });

  it("uses only the origin, discarding any path or query in the value", async () => {
    // KBZPay rejects a notify_url carrying query parameters, so the value is
    // normalised to an origin rather than concatenated blindly.
    process.env.KBZPAY_NOTIFY_ORIGIN = "https://brave.kuunyi.com/some/path?x=1";

    await POST(req());

    expect(mockPrecreate).toHaveBeenCalledWith(
      expect.objectContaining({ notifyUrl: "https://brave.kuunyi.com/api/webhooks/kbzmmqr" }),
    );
  });

  it("falls back to platformOrigin when unset", async () => {
    await POST(req());

    expect(mockPrecreate).toHaveBeenCalledWith(
      expect.objectContaining({ notifyUrl: "https://www.kuunyi.com/api/webhooks/kbzmmqr" }),
    );
  });

  // A malformed value must not become a relative or empty URL — that would
  // hand KBZPay an unreachable callback and strand every payment silently.
  it("falls back to platformOrigin when the value is not a valid URL", async () => {
    process.env.KBZPAY_NOTIFY_ORIGIN = "brave.kuunyi.com";

    await POST(req());

    expect(mockPrecreate).toHaveBeenCalledWith(
      expect.objectContaining({ notifyUrl: "https://www.kuunyi.com/api/webhooks/kbzmmqr" }),
    );
  });

  // new URL() accepts http:, ftp: and file: perfectly happily, and .origin
  // returns them unchanged — so without an explicit scheme check the callback
  // could be delivered over plaintext, or worse.
  it.each([
    ["http", "http://brave.kuunyi.com"],
    ["ftp", "ftp://brave.kuunyi.com"],
    ["javascript", "javascript:alert(1)"],
  ])("refuses a %s scheme and falls back to platformOrigin", async (_label, value) => {
    process.env.KBZPAY_NOTIFY_ORIGIN = value;

    await POST(req());

    expect(mockPrecreate).toHaveBeenCalledWith(
      expect.objectContaining({ notifyUrl: "https://www.kuunyi.com/api/webhooks/kbzmmqr" }),
    );
  });

  // file: is the nastiest case: its .origin is the literal string "null", so
  // the pre-fix code would have sent KBZPay "null/api/webhooks/kbzmmqr".
  it("refuses a file: URL, whose origin is the literal string 'null'", async () => {
    expect(new URL("file:///tmp/x").origin).toBe("null");

    process.env.KBZPAY_NOTIFY_ORIGIN = "file:///tmp/x";
    await POST(req());

    const sent = mockPrecreate.mock.calls[0][0].notifyUrl as string;
    expect(sent).toBe("https://www.kuunyi.com/api/webhooks/kbzmmqr");
    expect(sent).not.toContain("null");
  });

  it("never emits a non-https notify_url for any accepted value", async () => {
    for (const value of [
      "https://brave.kuunyi.com",
      "http://brave.kuunyi.com",
      "ftp://brave.kuunyi.com",
      "file:///tmp/x",
      "brave.kuunyi.com",
      "",
    ]) {
      mockPrecreate.mockClear();
      if (value) process.env.KBZPAY_NOTIFY_ORIGIN = value;
      else delete process.env.KBZPAY_NOTIFY_ORIGIN;

      await POST(req());

      const sent = mockPrecreate.mock.calls[0][0].notifyUrl as string;
      expect(sent.startsWith("https://")).toBe(true);
    }
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

// ─── Order window vs the tenant's auto-cancel timer ─────────────────────────
//
// The QR must not outlive the enrollment. check_expired_enrollments() rejects
// an unpaid enrollment after the tenant's window and does NOT touch the payment
// row, so a QR still payable afterwards lets a student pay for an enrollment
// that no longer exists: the money settles, but fn_block_reconfirm_rejected and
// the sync trigger both refuse to re-confirm a rejected enrollment, so no
// ticket is issued and the seat is gone.
//
// NOTE: tenants.auto_cancel_hours holds MINUTES, not hours (migration 058).
describe("order window (route level)", () => {
  const fresh = () => { enrollment = { ...ENROLLMENT, enrolled_at: new Date().toISOString() }; };
  const timeoutOf = () => mockPrecreate.mock.calls[0][0].timeoutMinutes as number;
  const claimExpiry = () =>
    Date.parse(rpcCalls.find((c) => c.name === "claim_kbzpay_order_slot")!.args
      .p_expires_at as string);

  // Bounded, not exact: enrolled_at is a real timestamp and the window is
  // floored, so a "fresh" enrollment yields configured-1 once any time has
  // passed. Exact-value behaviour is pinned in the orderWindow tests below,
  // which control the clock.
  it("derives the window from the tenant setting", async () => {
    autoCancelMinutes = 15;
    fresh();
    await POST(req());

    expect(timeoutOf()).toBeGreaterThanOrEqual(14);
    expect(timeoutOf()).toBeLessThanOrEqual(15);
  });

  it("uses the same window for provider_order_expires_at", async () => {
    autoCancelMinutes = 15;
    fresh();
    const before = Date.now();
    await POST(req());

    const minutes = (claimExpiry() - before) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15.1);
  });

  // 0 disables auto-cancel, so there is no enrollment deadline to outlive and
  // KBZPay's maximum is the right choice.
  it.each([0, null])("falls back to KBZPay's 120m maximum when auto-cancel is %s", async (value) => {
    autoCancelMinutes = value as number | null;
    fresh();
    await POST(req());
    expect(timeoutOf()).toBe(120);
  });

  it("clamps to KBZPay's 120-minute maximum", async () => {
    autoCancelMinutes = 4320; // the 72-hour default, in minutes
    fresh();
    await POST(req());
    expect(timeoutOf()).toBe(120);
  });

  it("never emits a window outside KBZPay's accepted 1-120 range", async () => {
    for (const value of [2, 15, 119, 120, 121, 4320, 0, null]) {
      mockPrecreate.mockClear();
      autoCancelMinutes = value as number | null;
      fresh();
      await POST(req());

      // A window too short to issue returns 409 and calls nothing — also valid.
      if (mockPrecreate.mock.calls.length === 0) continue;

      const t = timeoutOf();
      expect(Number.isInteger(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(1);
      expect(t).toBeLessThanOrEqual(120);
    }
  });

  it("never lets the QR outlive a configured auto-cancel window", async () => {
    for (const value of [2, 15, 60, 119, 120]) {
      mockPrecreate.mockClear();
      autoCancelMinutes = value;
      fresh();
      await POST(req());

      if (mockPrecreate.mock.calls.length === 0) continue;
      expect(timeoutOf()).toBeLessThanOrEqual(value);
    }
  });
});

describe("tenant lookup failure", () => {
  it("returns 502 when the tenant lookup errors, and never calls KBZPay", async () => {
    tenantError = { message: "connection reset" };

    const res = await POST(req());

    expect(res.status).toBe(502);
    expect(mockPrecreate).not.toHaveBeenCalled();
  });

  it("returns 502 when no tenant row is found", async () => {
    tenantMissing = true;

    const res = await POST(req());

    expect(res.status).toBe(502);
    expect(mockPrecreate).not.toHaveBeenCalled();
  });

  it("claims no order slot when the tenant lookup fails", async () => {
    tenantError = { message: "connection reset" };

    await POST(req());

    // No payment row, so nothing to reconcile and no slot held.
    expect(rpcCalls).toHaveLength(0);
  });

  it("never falls back to 120m when the deadline is unknown", async () => {
    for (const setup of [
      () => { tenantError = { message: "boom" }; },
      () => { tenantMissing = true; },
    ]) {
      mockPrecreate.mockClear();
      tenantError = null;
      tenantMissing = false;
      autoCancelMinutes = 15;
      setup();

      await POST(req());
      expect(mockPrecreate).not.toHaveBeenCalled();
    }
  });

  // Distinct from the above: the row WAS read, and auto-cancel is disabled.
  // There is no deadline to outlive, so KBZPay's maximum is correct.
  it("still accepts auto_cancel_hours: null as a valid 'use 120m' case", async () => {
    autoCancelMinutes = null;

    const res = await POST(req());

    expect(res.status).toBe(200);
    expect(mockPrecreate.mock.calls[0][0].timeoutMinutes).toBe(120);
  });
});

// ─── Remaining time, not configured duration ────────────────────────────────
//
// The deadline is enrolled_at + auto_cancel minutes, matching
// check_expired_enrollments(). Sending the full configured duration for an
// enrollment created 14 minutes into a 15-minute window would leave the QR
// payable ~14 minutes AFTER the enrollment is rejected.
describe("orderWindow (remaining time)", () => {
  const NOW = Date.parse("2026-08-20T12:00:00.000Z");
  const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

  it("uses the REMAINING time, not the configured duration", () => {
    // 14 minutes into a 15-minute window: 1 minute left, not 15.
    const w = orderWindow(15, minutesAgo(14), NOW);
    expect(w).toMatchObject({ kind: "ok", timeoutMinutes: 1 });
  });

  it("gives the full window to a brand-new enrollment", () => {
    expect(orderWindow(15, minutesAgo(0), NOW)).toMatchObject({ timeoutMinutes: 15 });
  });

  it.each([
    [1, 14],
    [7, 8],
    [14, 1],
  ])("leaves %s minutes elapsed → %s minutes remaining", (elapsed, expected) => {
    expect(orderWindow(15, minutesAgo(elapsed), NOW)).toMatchObject({ timeoutMinutes: expected });
  });

  it("reports expired when under a minute remains", () => {
    // 14.5 minutes elapsed → 30 seconds left, below KBZPay's 1-minute minimum.
    expect(orderWindow(15, new Date(NOW - 14.5 * 60_000).toISOString(), NOW)).toEqual({
      kind: "expired",
    });
  });

  it("reports expired once the deadline has passed", () => {
    expect(orderWindow(15, minutesAgo(20), NOW)).toEqual({ kind: "expired" });
  });

  it("clamps to KBZPay's 120-minute maximum for a long window", () => {
    expect(orderWindow(4320, minutesAgo(0), NOW)).toMatchObject({ timeoutMinutes: 120 });
  });

  it.each([0, null, undefined])("uses 120m when auto-cancel is %s", (value) => {
    expect(orderWindow(value as number | null, minutesAgo(999), NOW)).toMatchObject({
      kind: "ok",
      timeoutMinutes: 120,
    });
  });

  it.each([null, undefined, "not-a-date"])(
    "reports unknown for enrolled_at %s rather than guessing",
    (value) => {
      expect(orderWindow(15, value as string | null, NOW)).toEqual({ kind: "unknown" });
    },
  );

  it("expires at the enrollment deadline, not now + timeout", () => {
    const w = orderWindow(15, minutesAgo(10), NOW);
    if (w.kind !== "ok") throw new Error("expected ok");
    // Deadline is enrolled_at + 15m = NOW + 5m.
    expect(w.expiresAt.getTime()).toBe(NOW + 5 * 60_000);
  });

  it("caps expiresAt at KBZPay's 120 minutes when the deadline is further out", () => {
    const w = orderWindow(4320, minutesAgo(0), NOW);
    if (w.kind !== "ok") throw new Error("expected ok");
    expect(w.expiresAt.getTime()).toBe(NOW + 120 * 60_000);
  });

  // The invariant this whole PR exists for.
  it("never lets the QR outlive the enrollment deadline", () => {
    for (const autoCancel of [1, 5, 15, 60, 119, 120, 240, 4320]) {
      for (const elapsed of [0, 1, 5, 14, 30, 119, 240]) {
        const w = orderWindow(autoCancel, minutesAgo(elapsed), NOW);
        if (w.kind !== "ok") continue;

        const deadline = NOW - elapsed * 60_000 + autoCancel * 60_000;
        expect(NOW + w.timeoutMinutes * 60_000).toBeLessThanOrEqual(deadline);
        expect(w.expiresAt.getTime()).toBeLessThanOrEqual(deadline);
      }
    }
  });
});

describe("route honours the remaining window", () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  it("sends the remaining minutes, not the configured duration", async () => {
    autoCancelMinutes = 15;
    enrollment = { ...ENROLLMENT, enrolled_at: minutesAgo(10) };

    await POST(req());

    expect(mockPrecreate.mock.calls[0][0].timeoutMinutes).toBe(5);
  });

  it("returns 409 and creates nothing when under a minute remains", async () => {
    autoCancelMinutes = 15;
    enrollment = { ...ENROLLMENT, enrolled_at: minutesAgo(14.6) };

    const res = await POST(req());

    expect(res.status).toBe(409);
    expect(mockPrecreate).not.toHaveBeenCalled();
    expect(rpcCalls).toHaveLength(0);
  });

  it("returns 502 when enrolled_at cannot be parsed", async () => {
    autoCancelMinutes = 15;
    enrollment = { ...ENROLLMENT, enrolled_at: null };

    const res = await POST(req());

    expect(res.status).toBe(502);
    expect(mockPrecreate).not.toHaveBeenCalled();
  });
});
