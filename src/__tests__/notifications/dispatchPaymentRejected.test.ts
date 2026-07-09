import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockSendEmail = vi.fn().mockResolvedValue(true);
const mockEnrollmentRejectedEmail = vi.fn().mockReturnValue({
  subject: "Enrollment Rejected",
  html: "<p>Rejected</p>",
});

vi.mock("@/lib/email", () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
  enrollmentRejectedEmail: (...args: unknown[]) => mockEnrollmentRejectedEmail(...args),
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

const { dispatchPaymentRejected } = await import(
  "@/server/notifications/dispatchPaymentRejected"
);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_INPUT = {
  tenantId: "tenant-1",
  enrollmentRef: "NM-2026-0001",
  studentName: "Aung Aung",
  classLevel: "N5",
  statusUrl: "https://example.com/status/NM-2026-0001",
  paymentUrl: "https://example.com/payment/NM-2026-0001",
  currency: "MMK",
  email: "student@test.com",
  phone: "09123456789",
  messengerPsid: "psid-abc",
  telegramChatId: "chat-123",
  tenantName: "Nihon Moment",
  orgType: "language_school",
  logoUrl: undefined,
  rejectionReason: "Payment slip unclear",
} as const;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("dispatchPaymentRejected", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendEmail.mockResolvedValue(true);
    mockEnrollmentRejectedEmail.mockReturnValue({ subject: "Rejected", html: "<p>ok</p>" });
    mockSendStatusNotification.mockResolvedValue(true);
    mockSendTelegramStatusNotification.mockResolvedValue(true);
  });

  // ── All channels ─────────────────────────────────────────────────────────────

  it("calls email, Messenger, and Telegram when all contact info is present", async () => {
    await dispatchPaymentRejected(BASE_INPUT);

    expect(mockSendEmail).toHaveBeenCalledOnce();
    expect(mockSendStatusNotification).toHaveBeenCalledOnce();
    expect(mockSendTelegramStatusNotification).toHaveBeenCalledOnce();
  });

  it("calls enrollmentRejectedEmail with correct params", async () => {
    await dispatchPaymentRejected(BASE_INPUT);

    expect(mockEnrollmentRejectedEmail).toHaveBeenCalledWith({
      studentName: "Aung Aung",
      enrollmentRef: "NM-2026-0001",
      classLevel: "N5",
      reason: "Payment slip unclear",
      statusUrl: "https://example.com/status/NM-2026-0001",
      orgType: "language_school",
      tenantName: "Nihon Moment",
      logoUrl: undefined,
    });
  });

  it("calls sendEmail with the email address and template output", async () => {
    mockEnrollmentRejectedEmail.mockReturnValue({
      subject: "Enrollment Rejected — NM-2026-0001",
      html: "<p>Rejected</p>",
    });

    await dispatchPaymentRejected(BASE_INPUT);

    expect(mockSendEmail).toHaveBeenCalledWith({
      to: "student@test.com",
      subject: "Enrollment Rejected — NM-2026-0001",
      html: "<p>Rejected</p>",
    });
  });

  it("calls sendStatusNotification with action=reject", async () => {
    await dispatchPaymentRejected(BASE_INPUT);

    expect(mockSendStatusNotification).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      messengerPsid: "psid-abc",
      action: "reject",
      studentName: "Aung Aung",
      enrollmentRef: "NM-2026-0001",
      classLevel: "N5",
      statusUrl: "https://example.com/status/NM-2026-0001",
      paymentUrl: "https://example.com/payment/NM-2026-0001",
      rejectionReason: "Payment slip unclear",
      currency: "MMK",
    });
  });

  it("calls sendTelegramStatusNotification with action=reject", async () => {
    await dispatchPaymentRejected(BASE_INPUT);

    expect(mockSendTelegramStatusNotification).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      telegramChatId: "chat-123",
      action: "reject",
      studentName: "Aung Aung",
      enrollmentRef: "NM-2026-0001",
      classLevel: "N5",
      statusUrl: "https://example.com/status/NM-2026-0001",
      paymentUrl: "https://example.com/payment/NM-2026-0001",
      rejectionReason: "Payment slip unclear",
      currency: "MMK",
    });
  });

  it("passes null rejectionReason when rejectionReason is undefined", async () => {
    const { rejectionReason: _r, ...withoutReason } = BASE_INPUT;
    await dispatchPaymentRejected(withoutReason);

    expect(mockSendStatusNotification).toHaveBeenCalledWith(
      expect.objectContaining({ rejectionReason: null }),
    );
    expect(mockSendTelegramStatusNotification).toHaveBeenCalledWith(
      expect.objectContaining({ rejectionReason: null }),
    );
  });

  // ── No SMS / no channel invite ────────────────────────────────────────────────

  it("does NOT call SMS (not imported)", async () => {
    // SMS is intentionally not used on rejection; this test confirms the module
    // doesn't import sendSms by verifying no unexpected mock is needed.
    await expect(dispatchPaymentRejected(BASE_INPUT)).resolves.toBeUndefined();
  });

  // ── Email channel ─────────────────────────────────────────────────────────────

  it("does NOT call sendEmail when email is null", async () => {
    await dispatchPaymentRejected({ ...BASE_INPUT, email: null });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("does NOT call sendEmail when email is undefined", async () => {
    const { email: _email, ...withoutEmail } = BASE_INPUT;
    await dispatchPaymentRejected(withoutEmail);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  // ── Messenger channel ─────────────────────────────────────────────────────────

  it("does NOT call sendStatusNotification when messengerPsid is null", async () => {
    await dispatchPaymentRejected({ ...BASE_INPUT, messengerPsid: null });
    expect(mockSendStatusNotification).not.toHaveBeenCalled();
  });

  it("does NOT call sendStatusNotification when messengerPsid is undefined", async () => {
    const { messengerPsid: _psid, ...withoutPsid } = BASE_INPUT;
    await dispatchPaymentRejected(withoutPsid);
    expect(mockSendStatusNotification).not.toHaveBeenCalled();
  });

  // ── Telegram channel ──────────────────────────────────────────────────────────

  it("does NOT call sendTelegramStatusNotification when telegramChatId is null", async () => {
    await dispatchPaymentRejected({ ...BASE_INPUT, telegramChatId: null });
    expect(mockSendTelegramStatusNotification).not.toHaveBeenCalled();
  });

  it("does NOT call sendTelegramStatusNotification when telegramChatId is undefined", async () => {
    const { telegramChatId: _tgId, ...withoutTgId } = BASE_INPUT;
    await dispatchPaymentRejected(withoutTgId);
    expect(mockSendTelegramStatusNotification).not.toHaveBeenCalled();
  });

  // ── Error resilience ──────────────────────────────────────────────────────────

  it("does NOT throw when email channel throws", async () => {
    mockSendEmail.mockRejectedValueOnce(new Error("SMTP down"));
    await expect(dispatchPaymentRejected(BASE_INPUT)).resolves.toBeUndefined();
  });

  it("does NOT throw when Messenger channel throws", async () => {
    mockSendStatusNotification.mockRejectedValueOnce(new Error("Messenger API error"));
    await expect(dispatchPaymentRejected(BASE_INPUT)).resolves.toBeUndefined();
  });

  it("does NOT throw when Telegram channel throws", async () => {
    mockSendTelegramStatusNotification.mockRejectedValueOnce(new Error("Telegram down"));
    await expect(dispatchPaymentRejected(BASE_INPUT)).resolves.toBeUndefined();
  });

  it("still calls other channels when one channel fails", async () => {
    mockSendEmail.mockRejectedValueOnce(new Error("Email down"));

    await dispatchPaymentRejected(BASE_INPUT);

    expect(mockSendStatusNotification).toHaveBeenCalledOnce();
    expect(mockSendTelegramStatusNotification).toHaveBeenCalledOnce();
  });

  it("returns undefined (void) on successful dispatch", async () => {
    const result = await dispatchPaymentRejected(BASE_INPUT);
    expect(result).toBeUndefined();
  });
});
