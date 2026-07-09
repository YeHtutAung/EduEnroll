import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockAdminFrom = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockAdminFrom, rpc: vi.fn().mockResolvedValue({ data: null, error: null }) }),
}));

vi.mock("@/lib/api", () => ({
  resolveTenantId: vi.fn().mockResolvedValue("tenant-A"),
  requireAuth: vi.fn().mockResolvedValue({
    supabase: {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: null,
          error: null,
        }),
      }),
    },
    user: { id: "user-1", tenant_id: "tenant-A", role: "owner" },
    tenantId: "tenant-A",
    isAgent: false,
    agentChatId: null,
  }),
  badRequest: vi.fn((msg: string) => new Response(JSON.stringify({ error: msg }), { status: 400 })),
  notFound: vi.fn((r: string) => new Response(JSON.stringify({ error: `${r} not found` }), { status: 404 })),
}));

vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(),
  enrollmentApprovedEmail: vi.fn().mockReturnValue({}),
  enrollmentRejectedEmail: vi.fn().mockReturnValue({}),
  partialPaymentEmail: vi.fn().mockReturnValue({}),
}));
vi.mock("@/lib/sms", () => ({ sendSms: vi.fn() }));
vi.mock("@/lib/messenger/notify", () => ({ sendStatusNotification: vi.fn() }));
vi.mock("@/lib/telegram/notify", () => ({ sendTelegramStatusNotification: vi.fn() }));
vi.mock("@/lib/telegram/channel-invite", () => ({ sendChannelInviteIfEligible: vi.fn() }));
vi.mock("@/lib/utils", () => ({
  resolveEmailFromFormData: vi.fn().mockReturnValue(null),
  resolvePhoneFromFormData: vi.fn().mockReturnValue(null),
}));

const { PATCH } = await import("@/app/api/admin/payments/[id]/verify/route");

describe("Tenant isolation — payments", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Supabase RLS scoped to tenant — returns null when tenant mismatch
    mockAdminFrom.mockImplementation((table: string) => {
      const chain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn(),
        update: vi.fn().mockReturnThis(),
      };
      if (table === "payments") {
        chain.single.mockResolvedValue({ data: null, error: null });
      }
      return chain;
    });
  });

  it("returns 404 when payment belongs to a different tenant", async () => {
    const req = new NextRequest("http://localhost/api/admin/payments/payment-1/verify", {
      method: "PATCH",
      body: JSON.stringify({ action: "approve" }),
      headers: { "content-type": "application/json" },
    });

    const res = await PATCH(req, { params: { id: "payment-1" } });
    expect(res.status).toBe(404);
  });
});
