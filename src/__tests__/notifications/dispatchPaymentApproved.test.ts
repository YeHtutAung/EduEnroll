import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockSendEmail = vi.fn().mockResolvedValue(true);
const mockEnrollmentApprovedEmail = vi.fn().mockReturnValue({
  subject: "Enrollment Approved",
  html: "<p>Approved</p>",
});

vi.mock("@/lib/email", () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
  enrollmentApprovedEmail: (...args: unknown[]) => mockEnrollmentApprovedEmail(...args),
}));

const mockSendSms = vi.fn().mockResolvedValue(true);

vi.mock("@/lib/sms", () => ({
  sendSms: (...args: unknown[]) => mockSendSms(...args),
}));

const mockSendStatusNotification = vi.fn().mockResolvedValue(true);

vi.mock("@/lib/messenger/notify", () => ({
  sendStatusNotification: (...args: unknown[]) => mockSendStatusNotification(...args),
}));

const mockSendTelegramStatusNotification = vi.fn().mockResolvedValue(true);

vi.mock("@/lib/telegram/notify", () => ({
  sendTelegramStatusNotification: (...args: unknown[]) =>
    mockSendTelegramStatusNotification(...args),
}));

const mockSendChannelInviteIfEligible = vi.fn().mockResolvedValue(true);

vi.mock("@/lib/telegram/channel-invite", () => ({
  sendChannelInviteIfEligible: (...args: unknown[]) =>
    mockSendChannelInviteIfEligible(...args),
}));

const { dispatchPaymentApproved } = await import(
  "@/server/notifications/dispatchPaymentApproved"
);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_INPUT = {
  tenantId: "tenant-1",
  enrollmentId: "enroll-1",
  enrollmentRef: "NM-2026-0001",
  studentName: "Aung Aung",
  classLevel: "N5",
  feeFormatted: "50,000 MMK",
  statusUrl: "https://example.com/status/NM-2026-0001",
  paymentUrl: "https://example.com/payment/NM-2026-0001",
  currency: "MMK",
  email: "student@test.com",
  phone: "09123456789",
  messengerPsid: "psid-abc",
  telegramChatId: "chat-123",
  classId: "class-1",
  tenantName: "Nihon Moment",
  orgType: "language_school",
  logoUrl: null,
  smsOnPayment: true,
} as const;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("dispatchPaymentApproved", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendEmail.mockResolvedValue(true);
    mockEnrollmentApprovedEmail.mockReturnValue({ subject: "Approved", html: "<p>ok</p>" });
    mockSendSms.mockResolvedValue(true);
    mockSendStatusNotification.mockResolvedValue(true);
    mockSendTelegramStatusNotification.mockResolvedValue(true);
    mockSendChannelInviteIfEligible.mockResolvedValue(true);
  });

  // ── All channels ─────────────────────────────────────────────────────────────

  it("calls all channels when all contact info is present", async () => {
    await dispatchPaymentApproved(BASE_INPUT);

    expect(mockSendEmail).toHaveBeenCalledOnce();
    expect(mockSendSms).toHaveBeenCalledOnce();
    expect(mockSendStatusNotification).toHaveBeenCalledOnce();
    expect(mockSendTelegramStatusNotification).toHaveBeenCalledOnce();
    expect(mockSendChannelInviteIfEligible).toHaveBeenCalledOnce();
  });

  it("calls enrollmentApprovedEmail with correct params", async () => {
    await dispatchPaymentApproved(BASE_INPUT);

    expect(mockEnrollmentApprovedEmail).toHaveBeenCalledWith({
      studentName: "Aung Aung",
      enrollmentRef: "NM-2026-0001",
      classLevel: "N5",
      statusUrl: "https://example.com/status/NM-2026-0001",
      feeFormatted: "50,000 MMK",
      orgType: "language_school",
      tenantName: "Nihon Moment",
      logoUrl: null,
    });
  });

  it("calls sendEmail with the email address and template output", async () => {
    mockEnrollmentApprovedEmail.mockReturnValue({
      subject: "Enrollment Approved — NM-2026-0001",
      html: "<p>Approved</p>",
    });

    await dispatchPaymentApproved(BASE_INPUT);

    expect(mockSendEmail).toHaveBeenCalledWith({
      to: "student@test.com",
      subject: "Enrollment Approved — NM-2026-0001",
      html: "<p>Approved</p>",
    });
  });

  it("calls sendSms with correct params", async () => {
    await dispatchPaymentApproved(BASE_INPUT);

    expect(mockSendSms).toHaveBeenCalledWith({
      to: "09123456789",
      message: "Hi Aung Aung, your payment for NM-2026-0001 has been confirmed. Welcome to class!",
      clientReference: "NM-2026-0001",
    });
  });

  it("calls sendStatusNotification with action=approve", async () => {
    await dispatchPaymentApproved(BASE_INPUT);

    expect(mockSendStatusNotification).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      messengerPsid: "psid-abc",
      action: "approve",
      studentName: "Aung Aung",
      enrollmentRef: "NM-2026-0001",
      classLevel: "N5",
      statusUrl: "https://example.com/status/NM-2026-0001",
      paymentUrl: "https://example.com/payment/NM-2026-0001",
      currency: "MMK",
    });
  });

  it("calls sendTelegramStatusNotification with action=approve", async () => {
    await dispatchPaymentApproved(BASE_INPUT);

    expect(mockSendTelegramStatusNotification).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      telegramChatId: "chat-123",
      action: "approve",
      studentName: "Aung Aung",
      enrollmentRef: "NM-2026-0001",
      classLevel: "N5",
      statusUrl: "https://example.com/status/NM-2026-0001",
      paymentUrl: "https://example.com/payment/NM-2026-0001",
      currency: "MMK",
    });
  });

  it("calls sendChannelInviteIfEligible with correct params", async () => {
    await dispatchPaymentApproved(BASE_INPUT);

    expect(mockSendChannelInviteIfEligible).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      enrollmentId: "enroll-1",
      classId: "class-1",
      telegramChatId: "chat-123",
      studentName: "Aung Aung",
    });
  });

  // ── Email channel ─────────────────────────────────────────────────────────────

  it("does NOT call sendEmail when email is null", async () => {
    await dispatchPaymentApproved({ ...BASE_INPUT, email: null });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("does NOT call sendEmail when email is undefined", async () => {
    await dispatchPaymentApproved({ ...BASE_INPUT, email: undefined });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  // ── SMS channel ───────────────────────────────────────────────────────────────

  it("does NOT call sendSms when phone is null", async () => {
    await dispatchPaymentApproved({ ...BASE_INPUT, phone: null });
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it("does NOT call sendSms when phone is undefined", async () => {
    await dispatchPaymentApproved({ ...BASE_INPUT, phone: undefined });
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it("does NOT call sendSms when smsOnPayment is false", async () => {
    await dispatchPaymentApproved({ ...BASE_INPUT, smsOnPayment: false });
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it("calls sendSms when smsOnPayment is undefined (default allow)", async () => {
    await dispatchPaymentApproved({ ...BASE_INPUT, smsOnPayment: undefined });
    expect(mockSendSms).toHaveBeenCalledOnce();
  });

  // ── Messenger channel ─────────────────────────────────────────────────────────

  it("does NOT call sendStatusNotification when messengerPsid is null", async () => {
    await dispatchPaymentApproved({ ...BASE_INPUT, messengerPsid: null });
    expect(mockSendStatusNotification).not.toHaveBeenCalled();
  });

  it("does NOT call sendStatusNotification when messengerPsid is undefined", async () => {
    await dispatchPaymentApproved({ ...BASE_INPUT, messengerPsid: undefined });
    expect(mockSendStatusNotification).not.toHaveBeenCalled();
  });

  // ── Telegram channel ──────────────────────────────────────────────────────────

  it("does NOT call sendTelegramStatusNotification when telegramChatId is null", async () => {
    await dispatchPaymentApproved({ ...BASE_INPUT, telegramChatId: null });
    expect(mockSendTelegramStatusNotification).not.toHaveBeenCalled();
  });

  it("does NOT call sendTelegramStatusNotification when telegramChatId is undefined", async () => {
    await dispatchPaymentApproved({ ...BASE_INPUT, telegramChatId: undefined });
    expect(mockSendTelegramStatusNotification).not.toHaveBeenCalled();
  });

  it("does NOT call sendChannelInviteIfEligible when telegramChatId is null", async () => {
    await dispatchPaymentApproved({ ...BASE_INPUT, telegramChatId: null });
    expect(mockSendChannelInviteIfEligible).not.toHaveBeenCalled();
  });

  it("passes classId=null to sendChannelInviteIfEligible when classId is undefined", async () => {
    await dispatchPaymentApproved({ ...BASE_INPUT, classId: undefined });

    expect(mockSendChannelInviteIfEligible).toHaveBeenCalledWith(
      expect.objectContaining({ classId: null }),
    );
  });

  // ── Error resilience ──────────────────────────────────────────────────────────

  it("does NOT throw when email channel throws", async () => {
    mockSendEmail.mockRejectedValueOnce(new Error("SMTP down"));
    await expect(dispatchPaymentApproved(BASE_INPUT)).resolves.toBeUndefined();
  });

  it("does NOT throw when SMS channel throws", async () => {
    mockSendSms.mockRejectedValueOnce(new Error("SMS gateway error"));
    await expect(dispatchPaymentApproved(BASE_INPUT)).resolves.toBeUndefined();
  });

  it("does NOT throw when Messenger channel throws", async () => {
    mockSendStatusNotification.mockRejectedValueOnce(new Error("Messenger API error"));
    await expect(dispatchPaymentApproved(BASE_INPUT)).resolves.toBeUndefined();
  });

  it("does NOT throw when Telegram channel throws", async () => {
    mockSendTelegramStatusNotification.mockRejectedValueOnce(new Error("Telegram down"));
    await expect(dispatchPaymentApproved(BASE_INPUT)).resolves.toBeUndefined();
  });

  it("does NOT throw when channel invite throws", async () => {
    mockSendChannelInviteIfEligible.mockRejectedValueOnce(new Error("Invite error"));
    await expect(dispatchPaymentApproved(BASE_INPUT)).resolves.toBeUndefined();
  });

  it("still calls other channels when one channel fails", async () => {
    mockSendEmail.mockRejectedValueOnce(new Error("Email down"));

    await dispatchPaymentApproved(BASE_INPUT);

    // Other channels should still have been called
    expect(mockSendSms).toHaveBeenCalledOnce();
    expect(mockSendStatusNotification).toHaveBeenCalledOnce();
    expect(mockSendTelegramStatusNotification).toHaveBeenCalledOnce();
    expect(mockSendChannelInviteIfEligible).toHaveBeenCalledOnce();
  });

  it("returns undefined (void) on successful dispatch", async () => {
    const result = await dispatchPaymentApproved(BASE_INPUT);
    expect(result).toBeUndefined();
  });
});
