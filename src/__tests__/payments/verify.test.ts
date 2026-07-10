import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Mocks ────────────────────────────────────────────────────────────────────

// mockAdminFrom is shared: used by both the `supabase` returned from requireAuth
// and by the `createAdminClient()` call inside the route.
const mockAdminFrom = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: mockAdminFrom,
  }),
}));

vi.mock("@/lib/api", () => ({
  requireAuth: vi.fn().mockResolvedValue({
    supabase: { from: mockAdminFrom },
    user: {
      id: "user-1",
      tenant_id: "tenant-abc",
      role: "owner",
      email: "admin@test.com",
      full_name: "Admin",
      phone: null,
      created_at: "",
    },
    tenantId: "tenant-abc",
    isAgent: false,
    agentChatId: null,
  }),
  badRequest: (msg: string) =>
    Response.json({ error: "Bad Request", message: msg }, { status: 400 }),
  notFound: (r = "Resource") =>
    Response.json({ error: "Not Found", message: `${r} not found.` }, { status: 404 }),
}));

vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  enrollmentApprovedEmail: vi.fn().mockReturnValue({ subject: "s", html: "h" }),
  enrollmentRejectedEmail: vi.fn().mockReturnValue({ subject: "s", html: "h" }),
  partialPaymentEmail: vi.fn().mockReturnValue({ subject: "s", html: "h" }),
}));

vi.mock("@/lib/sms", () => ({ sendSms: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/messenger/notify", () => ({
  sendStatusNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/telegram/notify", () => ({
  sendTelegramStatusNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/telegram/channel-invite", () => ({
  sendChannelInviteIfEligible: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/server/tickets/issueTickets", () => ({
  issueTicketsForEnrollment: vi.fn().mockResolvedValue(undefined),
  voidTicketsForEnrollment: vi.fn().mockResolvedValue(undefined),
}));

// resolveEmailFromFormData and resolvePhoneFromFormData are used in the route
vi.mock("@/lib/utils", () => ({
  resolveEmailFromFormData: vi.fn().mockReturnValue(null),
  resolvePhoneFromFormData: vi.fn().mockReturnValue(null),
}));

const { PATCH } = await import("@/app/api/admin/payments/[id]/verify/route");

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PENDING_PAYMENT = {
  id: "payment-1",
  enrollment_id: "enroll-1",
  tenant_id: "tenant-abc",
  amount: 50000,
  status: "pending",
};

const BASE_ENROLLMENT = {
  id: "enroll-1",
  tenant_id: "tenant-abc",
  class_id: "class-1",
  quantity: 1,
  status: "pending_payment",
  enrollment_ref: "NM-2026-0001",
  student_name_en: "Test Student",
  email: "student@test.com",
  phone: null,
  form_data: null,
  messenger_psid: null,
  telegram_chat_id: null,
};

const TENANT_INFO = {
  name: "Test School",
  org_type: "language_school",
  logo_url: null,
  currency: "MMK",
  sms_on_payment: false,
};

const CLASS_INFO = {
  level: "N5",
  fee_amount: 50000,
  seat_remaining: 5,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(paymentId: string, body: object) {
  return new NextRequest(
    `http://localhost/api/admin/payments/${paymentId}/verify`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
}

/**
 * Sets up mockAdminFrom so each table returns sensible defaults.
 * The route queries tables in this order:
 *   1. payments (via supabase from requireAuth) — .select().eq().eq().single()
 *   2. enrollments (via supabase from requireAuth) — .select().eq().eq().single()
 *   3. tenants (via createAdminClient) — .select().eq().single()
 *   4. classes (via createAdminClient) — .select().eq().single() + .update().eq()
 *   5. payments update (via createAdminClient) — .update().eq()
 *   6. enrollments update (via createAdminClient) — .update().eq().select().single()
 *   7. enrollments status_notified_at update (via createAdminClient, if email/psid set)
 */
function setupTableMocks(opts?: {
  paymentOverride?: Partial<typeof PENDING_PAYMENT>;
  enrollmentOverride?: Partial<typeof BASE_ENROLLMENT>;
  enrollmentUpdatedStatus?: string;
}) {
  const paymentData = { ...PENDING_PAYMENT, ...(opts?.paymentOverride ?? {}) };
  const enrollmentData = { ...BASE_ENROLLMENT, ...(opts?.enrollmentOverride ?? {}) };
  const enrollmentUpdatedStatus = opts?.enrollmentUpdatedStatus ?? "confirmed";

  mockAdminFrom.mockImplementation((table: string) => {
    // A flexible chain: most methods return `this`, terminal .single() returns result
    const makeChain = (singleResult: { data: unknown; error: null }) => {
      const chain: Record<string, unknown> = {};

      // update() returns a chain where .eq() resolves with { error: null }
      const updateChain: Record<string, unknown> = {
        eq: vi.fn().mockImplementation(() => {
          // For enrollments update, we need .eq().select().single()
          const selectChain = {
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { ...enrollmentData, status: enrollmentUpdatedStatus },
                error: null,
              }),
            }),
            // Also allow direct .eq() → resolves (for payments update)
            then: (resolve: (v: { error: null }) => void) =>
              resolve({ error: null }),
          };
          return selectChain;
        }),
      };

      chain["select"] = vi.fn().mockReturnThis();
      chain["eq"] = vi.fn().mockReturnThis();
      chain["single"] = vi.fn().mockResolvedValue(singleResult);
      chain["update"] = vi.fn().mockReturnValue(updateChain);

      return chain;
    };

    if (table === "payments") {
      return makeChain({ data: paymentData, error: null });
    }

    if (table === "enrollments") {
      return makeChain({ data: enrollmentData, error: null });
    }

    if (table === "tenants") {
      return makeChain({ data: TENANT_INFO, error: null });
    }

    if (table === "classes") {
      return makeChain({ data: CLASS_INFO, error: null });
    }

    if (table === "enrollment_items") {
      return makeChain({ data: [], error: null });
    }

    // Fallback for any other table
    return makeChain({ data: null, error: null });
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PATCH /api/admin/payments/[id]/verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupTableMocks();
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  it("returns 400 for invalid action", async () => {
    const res = await PATCH(
      makeRequest("payment-1", { action: "invalid" }),
      { params: { id: "payment-1" } },
    );
    expect(res.status).toBe(400);
  });

  it("returns 409 when payment is already verified", async () => {
    setupTableMocks({ paymentOverride: { status: "verified" } });
    const res = await PATCH(
      makeRequest("payment-1", { action: "approve" }),
      { params: { id: "payment-1" } },
    );
    expect(res.status).toBe(409);
  });

  // ── Approve ─────────────────────────────────────────────────────────────────

  it("approve: returns 200 with updated payment and enrollment", async () => {
    setupTableMocks({ enrollmentUpdatedStatus: "confirmed" });
    const res = await PATCH(
      makeRequest("payment-1", { action: "approve" }),
      { params: { id: "payment-1" } },
    );
    expect(res.status).toBe(200);
  });

  it("approve: response body includes payment with status 'verified'", async () => {
    setupTableMocks({ enrollmentUpdatedStatus: "confirmed" });
    const res = await PATCH(
      makeRequest("payment-1", { action: "approve" }),
      { params: { id: "payment-1" } },
    );
    const body = await res.json();
    expect(body.payment.status).toBe("verified");
  });

  it("approve: response body includes enrollment with status 'confirmed'", async () => {
    setupTableMocks({ enrollmentUpdatedStatus: "confirmed" });
    const res = await PATCH(
      makeRequest("payment-1", { action: "approve" }),
      { params: { id: "payment-1" } },
    );
    const body = await res.json();
    expect(body.enrollment.status).toBe("confirmed");
  });

  // ── Reject ──────────────────────────────────────────────────────────────────

  it("reject: returns 200 with updated payment and enrollment", async () => {
    setupTableMocks({ enrollmentUpdatedStatus: "rejected" });
    const res = await PATCH(
      makeRequest("payment-1", {
        action: "reject",
        rejection_reason: "Blurry screenshot",
      }),
      { params: { id: "payment-1" } },
    );
    expect(res.status).toBe(200);
  });

  it("reject: response body includes payment with status 'rejected'", async () => {
    setupTableMocks({ enrollmentUpdatedStatus: "rejected" });
    const res = await PATCH(
      makeRequest("payment-1", {
        action: "reject",
        rejection_reason: "Blurry screenshot",
      }),
      { params: { id: "payment-1" } },
    );
    const body = await res.json();
    expect(body.payment.status).toBe("rejected");
  });

  it("reject: works without rejection_reason", async () => {
    setupTableMocks({ enrollmentUpdatedStatus: "rejected" });
    const res = await PATCH(
      makeRequest("payment-1", { action: "reject" }),
      { params: { id: "payment-1" } },
    );
    expect(res.status).toBe(200);
  });

  // ── Request Remaining ───────────────────────────────────────────────────────

  it("request_remaining: returns 400 when admin_note is missing", async () => {
    const res = await PATCH(
      makeRequest("payment-1", { action: "request_remaining" }),
      { params: { id: "payment-1" } },
    );
    expect(res.status).toBe(400);
  });

  it("request_remaining: returns 400 when admin_note is empty string", async () => {
    const res = await PATCH(
      makeRequest("payment-1", { action: "request_remaining", admin_note: "  " }),
      { params: { id: "payment-1" } },
    );
    expect(res.status).toBe(400);
  });

  it("request_remaining: returns 200 with enrollment status 'partial_payment'", async () => {
    setupTableMocks({ enrollmentUpdatedStatus: "partial_payment" });
    const res = await PATCH(
      makeRequest("payment-1", {
        action: "request_remaining",
        admin_note: "Short by 5000",
        received_amount: 45000,
      }),
      { params: { id: "payment-1" } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enrollment.status).toBe("partial_payment");
  });

  it("request_remaining: works without received_amount", async () => {
    setupTableMocks({ enrollmentUpdatedStatus: "partial_payment" });
    const res = await PATCH(
      makeRequest("payment-1", {
        action: "request_remaining",
        admin_note: "Please pay the remaining balance",
      }),
      { params: { id: "payment-1" } },
    );
    expect(res.status).toBe(200);
  });
});
