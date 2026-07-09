import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockSendEmail = vi.fn().mockResolvedValue(true);
const mockPartialPaymentEmail = vi.fn().mockReturnValue({
  subject: "Partial Payment Request",
  html: "<p>Partial</p>",
});

vi.mock("@/lib/email", () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
  partialPaymentEmail: (...args: unknown[]) => mockPartialPaymentEmail(...args),
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

const { dispatchPartialPaymentRequested } = await import(
  "@/server/notifications/dispatchPartialPaymentRequested"
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
  adminNote: "Please pay the remaining 10,000 MMK.",
  totalAmount: 50000,
  receivedAmount: 40000,
  remainingAmount: 10000,
} as const;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("dispatchPartialPaymentRequested", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendEmail.mockResolvedValue(true);
    mockPartialPaymentEmail.mockReturnValue({ subject: "Partial", html: "<p>ok</p>" });
    mockSendStatusNotification.mockResolvedValue(true);
    mockSendTelegramStatusNotification.mockResolvedValue(true);
  });

  // ── All channels ─────────────────────────────────────────────────────────────

  it("calls email, Messenger, and Telegram when all contact info is present", async () => {
    await dispatchPartialPaymentRequested(BASE_INPUT);

    expect(mockSendEmail).toHaveBeenCalledOnce();
    expect(mockSendStatusNotification).toHaveBeenCalledOnce();
    expect(mockSendTelegramStatusNotification).toHaveBeenCalledOnce();
  });

  it("calls partialPaymentEmail with correct params", async () => {
    await dispatchPartialPaymentRequested(BASE_INPUT);

    expect(mockPartialPaymentEmail).toHaveBeenCalledWith({
      studentName: "Aung Aung",
      enrollmentRef: "NM-2026-0001",
      classLevel: "N5",
      totalAmount: 50000,
      receivedAmount: 40000,
      remainingAmount: 10000,
      adminNote: "Please pay the remaining 10,000 MMK.",
      paymentUrl: "https://example.com/payment/NM-2026-0001",
      statusUrl: "https://example.com/status/NM-2026-0001",
      orgType: "language_school",
      tenantName: "Nihon Moment",
      logoUrl: undefined,
    });
  });

  it("calls sendEmail with the email address and template output", async () => {
    mockPartialPaymentEmail.mockReturnValue({
      subject: "Partial Payment Request — NM-2026-0001",
      html: "<p>Partial</p>",
    });

    await dispatchPartialPaymentRequested(BASE_INPUT);

    expect(mockSendEmail).toHaveBeenCalledWith({
      to: "student@test.com",
      subject: "Partial Payment Request — NM-2026-0001",
      html: "<p>Partial</p>",
    });
  });

  it("calls sendStatusNotification with action=request_remaining", async () => {
    await dispatchPartialPaymentRequested(BASE_INPUT);

    expect(mockSendStatusNotification).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      messengerPsid: "psid-abc",
      action: "request_remaining",
      studentName: "Aung Aung",
      enrollmentRef: "NM-2026-0001",
      classLevel: "N5",
      statusUrl: "https://example.com/status/NM-2026-0001",
      paymentUrl: "https://example.com/payment/NM-2026-0001",
      adminNote: "Please pay the remaining 10,000 MMK.",
      receivedAmount: 40000,
      remainingAmount: 10000,
      currency: "MMK",
    });
  });

  it("calls sendTelegramStatusNotification with action=request_remaining", async () => {
    await dispatchPartialPaymentRequested(BASE_INPUT);

    expect(mockSendTelegramStatusNotification).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      telegramChatId: "chat-123",
      action: "request_remaining",
      studentName: "Aung Aung",
      enrollmentRef: "NM-2026-0001",
      classLevel: "N5",
      statusUrl: "https://example.com/status/NM-2026-0001",
      paymentUrl: "https://example.com/payment/NM-2026-0001",
      adminNote: "Please pay the remaining 10,000 MMK.",
      receivedAmount: 40000,
      remainingAmount: 10000,
      currency: "MMK",
    });
  });

  it("passes null receivedAmount and remainingAmount when not provided", async () => {
    const { receivedAmount: _r, remainingAmount: _ra, ...withoutAmounts } = BASE_INPUT;
    await dispatchPartialPaymentRequested(withoutAmounts);

    expect(mockSendStatusNotification).toHaveBeenCalledWith(
      expect.objectContaining({ receivedAmount: null, remainingAmount: null }),
    );
    expect(mockSendTelegramStatusNotification).toHaveBeenCalledWith(
      expect.objectContaining({ receivedAmount: null, remainingAmount: null }),
    );
    expect(mockPartialPaymentEmail).toHaveBeenCalledWith(
      expect.objectContaining({ receivedAmount: null, remainingAmount: null }),
    );
  });

  // ── Email channel ─────────────────────────────────────────────────────────────

  it("does NOT call sendEmail when email is null", async () => {
    await dispatchPartialPaymentRequested({ ...BASE_INPUT, email: null });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("does NOT call sendEmail when email is undefined", async () => {
    const { email: _email, ...withoutEmail } = BASE_INPUT;
    await dispatchPartialPaymentRequested(withoutEmail);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  // ── Messenger channel ─────────────────────────────────────────────────────────

  it("does NOT call sendStatusNotification when messengerPsid is null", async () => {
    await dispatchPartialPaymentRequested({ ...BASE_INPUT, messengerPsid: null });
    expect(mockSendStatusNotification).not.toHaveBeenCalled();
  });

  it("does NOT call sendStatusNotification when messengerPsid is undefined", async () => {
    const { messengerPsid: _psid, ...withoutPsid } = BASE_INPUT;
    await dispatchPartialPaymentRequested(withoutPsid);
    expect(mockSendStatusNotification).not.toHaveBeenCalled();
  });

  // ── Telegram channel ──────────────────────────────────────────────────────────

  it("does NOT call sendTelegramStatusNotification when telegramChatId is null", async () => {
    await dispatchPartialPaymentRequested({ ...BASE_INPUT, telegramChatId: null });
    expect(mockSendTelegramStatusNotification).not.toHaveBeenCalled();
  });

  it("does NOT call sendTelegramStatusNotification when telegramChatId is undefined", async () => {
    const { telegramChatId: _tgId, ...withoutTgId } = BASE_INPUT;
    await dispatchPartialPaymentRequested(withoutTgId);
    expect(mockSendTelegramStatusNotification).not.toHaveBeenCalled();
  });

  // ── Error resilience ──────────────────────────────────────────────────────────

  it("does NOT throw when email channel throws", async () => {
    mockSendEmail.mockRejectedValueOnce(new Error("SMTP down"));
    await expect(dispatchPartialPaymentRequested(BASE_INPUT)).resolves.toBeUndefined();
  });

  it("does NOT throw when Messenger channel throws", async () => {
    mockSendStatusNotification.mockRejectedValueOnce(new Error("Messenger API error"));
    await expect(dispatchPartialPaymentRequested(BASE_INPUT)).resolves.toBeUndefined();
  });

  it("does NOT throw when Telegram channel throws", async () => {
    mockSendTelegramStatusNotification.mockRejectedValueOnce(new Error("Telegram down"));
    await expect(dispatchPartialPaymentRequested(BASE_INPUT)).resolves.toBeUndefined();
  });

  it("still calls other channels when one channel fails", async () => {
    mockSendEmail.mockRejectedValueOnce(new Error("Email down"));

    await dispatchPartialPaymentRequested(BASE_INPUT);

    expect(mockSendStatusNotification).toHaveBeenCalledOnce();
    expect(mockSendTelegramStatusNotification).toHaveBeenCalledOnce();
  });

  it("returns undefined (void) on successful dispatch", async () => {
    const result = await dispatchPartialPaymentRequested(BASE_INPUT);
    expect(result).toBeUndefined();
  });
});
