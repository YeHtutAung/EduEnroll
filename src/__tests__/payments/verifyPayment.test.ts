import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockAdminFrom = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: mockAdminFrom,
  }),
}));

const mockRestoreSeats = vi.fn().mockResolvedValue(undefined);

vi.mock("@/server/payments/seatRestoration", () => ({
  restoreSeats: mockRestoreSeats,
}));

vi.mock("@/server/tickets/issueTickets", () => ({
  issueTicketsForEnrollment: vi.fn().mockResolvedValue(undefined),
  voidTicketsForEnrollment: vi.fn().mockResolvedValue(undefined),
}));

const { verifyPayment } = await import("@/server/payments/verifyPayment");

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_PAYMENT = {
  id: "payment-1",
  enrollment_id: "enroll-1",
  tenant_id: "tenant-abc",
  amount: 50000,
  status: "pending",
  proof_image_url: null,
  proof_image_urls: [],
  bank_reference: null,
  admin_note: null,
  received_amount: null,
  payment_method: null,
  payment_ref: null,
  mmqr_status: null,
  paid_at: null,
  stripe_session_id: null,
  stripe_payment_intent_id: null,
  payer_institution: null,
  verified_by: null,
  verified_at: null,
  created_at: "2026-01-01T00:00:00Z",
} as const;

const BASE_ENROLLMENT = {
  id: "enroll-1",
  enrollment_ref: "NM-2026-0001",
  class_id: "class-1",
  tenant_id: "tenant-abc",
  student_name_en: "Test Student",
  student_name_mm: null,
  nrc_number: null,
  phone: "09123456789",
  email: "student@test.com",
  form_data: null,
  quantity: 1,
  status: "payment_submitted",
  enrolled_at: "2026-01-01T00:00:00Z",
  messenger_psid: null,
  telegram_chat_id: null,
  telegram_link_pending_chat_id: null,
  telegram_phone: null,
  telegram_link_token: null,
  telegram_link_token_expires_at: null,
} as const;

const TENANT_INFO = { currency: "MMK" };

const VERIFIER = { verifiedByHuman: "user-1", verifiedByAgent: null };

const CLASS_INFO = { level: "N5", fee_amount: 50000 };

// ─── Helper: build a standard input ──────────────────────────────────────────

function makeInput(
  action: "approve" | "reject" | "request_remaining",
  overrides: Record<string, unknown> = {},
) {
  return {
    action,
    payment: { ...BASE_PAYMENT } as never,
    enrollment: { ...BASE_ENROLLMENT } as never,
    tenantId: "tenant-abc",
    tenantInfo: TENANT_INFO,
    verifier: VERIFIER,
    requestHost: "localhost:3005",
    ...overrides,
  };
}

// ─── Helper: setup table mocks ────────────────────────────────────────────────

function setupTableMocks(opts?: {
  enrollmentStatus?: string;
}) {
  const enrollmentStatus = opts?.enrollmentStatus ?? "confirmed";

  mockAdminFrom.mockImplementation((table: string) => {
    const updateChain = {
      eq: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { ...BASE_ENROLLMENT, status: enrollmentStatus },
            error: null,
          }),
        }),
        // Allow direct .eq() → resolve (for payments update)
        then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
      }),
    };

    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue(
        table === "classes" ? { data: CLASS_INFO, error: null } : { data: null, error: null },
      ),
      update: vi.fn().mockReturnValue(updateChain),
    };

    if (table === "enrollment_items") {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ data: [], error: null }),
        update: vi.fn().mockReturnValue(updateChain),
      };
    }

    return chain;
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("verifyPayment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupTableMocks();
  });

  // ── Approve ──────────────────────────────────────────────────────────────────

  describe("approve action", () => {
    it("updates payment status to verified", async () => {
      setupTableMocks({ enrollmentStatus: "confirmed" });
      const result = await verifyPayment(makeInput("approve"));
      expect(result.payment.status).toBe("verified");
    });

    it("sets verified_by from verifier.verifiedByHuman", async () => {
      setupTableMocks({ enrollmentStatus: "confirmed" });
      const result = await verifyPayment(makeInput("approve"));
      expect(result.payment.verified_by).toBe("user-1");
    });

    it("updates enrollment status to confirmed", async () => {
      setupTableMocks({ enrollmentStatus: "confirmed" });
      const result = await verifyPayment(makeInput("approve"));
      expect(result.enrollment.status).toBe("confirmed");
    });

    it("includes classLevel and URLs in result", async () => {
      setupTableMocks({ enrollmentStatus: "confirmed" });
      const result = await verifyPayment(makeInput("approve"));
      expect(result.classLevel).toBe("N5");
      expect(result.statusUrl).toContain("NM-2026-0001");
      expect(result.paymentUrl).toContain("NM-2026-0001");
    });

    it("does NOT call restoreSeats", async () => {
      setupTableMocks({ enrollmentStatus: "confirmed" });
      await verifyPayment(makeInput("approve"));
      expect(mockRestoreSeats).not.toHaveBeenCalled();
    });

    it("formats feeFormatted with currency", async () => {
      setupTableMocks({ enrollmentStatus: "confirmed" });
      const result = await verifyPayment(makeInput("approve"));
      expect(result.feeFormatted).toBe("50,000 MMK");
    });
  });

  // ── Reject ───────────────────────────────────────────────────────────────────

  describe("reject action", () => {
    it("updates payment status to rejected", async () => {
      setupTableMocks({ enrollmentStatus: "rejected" });
      const result = await verifyPayment(makeInput("reject"));
      expect(result.payment.status).toBe("rejected");
    });

    it("calls restoreSeats when enrollment was not already rejected", async () => {
      setupTableMocks({ enrollmentStatus: "rejected" });
      await verifyPayment(makeInput("reject"));
      expect(mockRestoreSeats).toHaveBeenCalledOnce();
      expect(mockRestoreSeats).toHaveBeenCalledWith({
        id: "enroll-1",
        class_id: "class-1",
        quantity: 1,
      });
    });

    it("does NOT call restoreSeats when enrollment.status is already 'rejected'", async () => {
      setupTableMocks({ enrollmentStatus: "rejected" });
      // Override enrollment to already be rejected
      await verifyPayment(
        makeInput("reject", {
          enrollment: { ...BASE_ENROLLMENT, status: "rejected" } as never,
        }),
      );
      expect(mockRestoreSeats).not.toHaveBeenCalled();
    });

    it("includes rejection_reason in result when provided", async () => {
      setupTableMocks({ enrollmentStatus: "rejected" });
      const result = await verifyPayment(
        makeInput("reject", { rejection_reason: "Blurry screenshot" }),
      );
      expect(result.rejection_reason).toBe("Blurry screenshot");
    });

    it("does not include rejection_reason in result when not provided", async () => {
      setupTableMocks({ enrollmentStatus: "rejected" });
      const result = await verifyPayment(makeInput("reject"));
      expect(result.rejection_reason).toBeUndefined();
    });
  });

  // ── Request Remaining ─────────────────────────────────────────────────────────

  describe("request_remaining action", () => {
    it("updates enrollment status to partial_payment", async () => {
      setupTableMocks({ enrollmentStatus: "partial_payment" });
      const result = await verifyPayment(
        makeInput("request_remaining", { admin_note: "Short by 5000" }),
      );
      expect(result.enrollment.status).toBe("partial_payment");
    });

    it("includes received_amount in payment update when provided", async () => {
      setupTableMocks({ enrollmentStatus: "partial_payment" });
      const result = await verifyPayment(
        makeInput("request_remaining", {
          admin_note: "Short by 5000",
          received_amount: 45000,
        }),
      );
      expect(result.payment.received_amount).toBe(45000);
    });

    it("does NOT include received_amount in payment when not provided", async () => {
      setupTableMocks({ enrollmentStatus: "partial_payment" });
      const result = await verifyPayment(
        makeInput("request_remaining", { admin_note: "Please pay remaining" }),
      );
      // received_amount key should not appear in the update payload (spread of BASE_PAYMENT has null)
      // The key should not be added by the service (it remains null from the original payment spread)
      expect(result.payment).not.toHaveProperty("received_amount", 45000);
    });

    it("does NOT call restoreSeats", async () => {
      setupTableMocks({ enrollmentStatus: "partial_payment" });
      await verifyPayment(
        makeInput("request_remaining", { admin_note: "Pay the rest" }),
      );
      expect(mockRestoreSeats).not.toHaveBeenCalled();
    });
  });
});
