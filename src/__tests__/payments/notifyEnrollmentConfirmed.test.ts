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

type Payment = {
  amount: number | null;
  platform_fee: number | null;
  paid_at: string | null;
  created_at: string;
};

function setup(payments: Payment[]) {
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
    const orderColumns: (keyof Payment)[] = [];
    const paymentQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn((column: keyof Payment) => {
        orderColumns.push(column);
        return paymentQuery;
      }),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockImplementation(() => {
        const selected = [...payments].sort((a, b) => {
          for (const column of orderColumns) {
            const aValue = a[column];
            const bValue = b[column];
            if (aValue == null && bValue == null) continue;
            if (aValue == null) return 1;
            if (bValue == null) return -1;
            const difference = bValue.toString().localeCompare(aValue.toString());
            if (difference !== 0) return difference;
          }
          return 0;
        })[0] ?? null;
        return Promise.resolve({ data: selected, error: null });
      }),
    };
    return paymentQuery;
  });
}

describe("notifyEnrollmentConfirmed email totals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendEmail.mockResolvedValue(true);
    mockEnrollmentApprovedEmail.mockReturnValue({ subject: "Confirmed", html: "<p>ok</p>" });
  });

  it("passes the settled payment breakdown to the confirmation email", async () => {
    setup([{ amount: 4_000, platform_fee: 2_000, paid_at: "2026-09-04T10:00:00Z", created_at: "2026-09-04T09:00:00Z" }]);

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
    setup([]);

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

  it("uses the most recently settled payment instead of the largest verified amount", async () => {
    setup([
      { amount: 6_000, platform_fee: 4_000, paid_at: "2026-09-04T09:00:00Z", created_at: "2026-09-04T08:00:00Z" },
      { amount: 4_000, platform_fee: 2_000, paid_at: "2026-09-04T10:00:00Z", created_at: "2026-09-04T09:00:00Z" },
    ]);

    await notifyEnrollmentConfirmed("enrollment-1");

    expect(mockEnrollmentApprovedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        platformFeeFormatted: "2,000 MMK",
        totalPaidFormatted: "4,000 MMK",
      }),
    );
  });
});
