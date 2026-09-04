import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFrom = vi.fn();
const mockSendEmail = vi.fn().mockResolvedValue(true);
const mockEnrollmentApprovedEmail = vi.fn().mockReturnValue({ subject: "Confirmed", html: "<p>ok</p>" });

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mockFrom }) }));
vi.mock("@/lib/email", () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
  enrollmentApprovedEmail: (...args: unknown[]) => mockEnrollmentApprovedEmail(...args),
}));
vi.mock("@/server/tickets/eticketEmailAttachment", () => ({
  buildEticketEmailAttachment: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/sms", () => ({ sendSms: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/telegram/notify", () => ({ sendTelegramStatusNotification: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/telegram/channel-invite", () => ({ sendChannelInviteIfEligible: vi.fn().mockResolvedValue(true) }));

const { notifyEnrollmentConfirmed } = await import("@/server/payments/notifyEnrollmentConfirmed");

const enrollment = {
  tenant_id: "tenant-1",
  telegram_chat_id: null,
  email: "buyer@example.test",
  phone: null,
  enrollment_ref: "LM-0904-8VEN",
  student_name_en: "Buyer",
  class_id: "class-1",
  quantity: 2,
  form_data: null,
};

function setup(payment: { amount: number | null; platform_fee: number | null } | null) {
  mockFrom.mockImplementation((table: string) => {
    if (table === "enrollments") {
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: enrollment, error: null }) };
    }
    if (table === "classes") {
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: { level: "General Access - GA", fee_amount: 1_000 }, error: null }) };
    }
    if (table === "tenants") {
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: { name: "Louder Myanmar", org_type: "event", logo_url: null, currency: "MMK", sms_on_payment: false, subdomain: "brave" }, error: null }) };
    }
    return {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: payment, error: null }),
    };
  });
}

describe("notifyEnrollmentConfirmed email totals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendEmail.mockResolvedValue(true);
    mockEnrollmentApprovedEmail.mockReturnValue({ subject: "Confirmed", html: "<p>ok</p>" });
  });

  it("passes the settled payment breakdown to the confirmation email", async () => {
    setup({ amount: 4_000, platform_fee: 2_000 });

    await notifyEnrollmentConfirmed("enrollment-1");

    expect(mockEnrollmentApprovedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        feeFormatted: "2,000 MMK",
        ticketSubtotalFormatted: "2,000 MMK",
        platformFeeFormatted: "2,000 MMK",
        totalPaidFormatted: "4,000 MMK",
        ticketCount: 2,
      }),
    );
    expect(mockSendEmail).toHaveBeenCalledOnce();
  });

  it("still sends the existing subtotal-only email when no settled payment row exists", async () => {
    setup(null);

    await notifyEnrollmentConfirmed("enrollment-1");

    expect(mockEnrollmentApprovedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        feeFormatted: "2,000 MMK",
        ticketSubtotalFormatted: undefined,
        platformFeeFormatted: undefined,
        totalPaidFormatted: undefined,
      }),
    );
    expect(mockSendEmail).toHaveBeenCalledOnce();
  });
});
