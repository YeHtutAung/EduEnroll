import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSendEmail = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/email", () => ({
  sendEmail: mockSendEmail,
  enrollmentConfirmationEmail: vi.fn().mockReturnValue({ subject: "s", html: "h" }),
}));

const { sendEnrollmentConfirmationEmail } = await import("@/server/enrollment/enrollmentEmails");

const BASE_TENANT = {
  name: "Test School",
  org_type: "language_school",
  logo_url: null,
  email_on_enroll: true,
  currency: "MMK",
};

describe("sendEnrollmentConfirmationEmail", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends email when email_on_enroll is true and email is in form_data", async () => {
    sendEnrollmentConfirmationEmail({
      fd: { email: "student@test.com" },
      enrollmentRef: "NM-2026-0001",
      classLevel: "N5",
      feeAmount: 50000,
      baseUrl: "https://test.kuunyi.com",
      tenant: BASE_TENANT,
    });
    await new Promise((r) => setTimeout(r, 10)); // let fire-and-forget run
    expect(mockSendEmail).toHaveBeenCalledOnce();
    expect(mockSendEmail.mock.calls[0][0].to).toBe("student@test.com");
  });

  it("does NOT send email when email_on_enroll is false", () => {
    sendEnrollmentConfirmationEmail({
      fd: { email: "student@test.com" },
      enrollmentRef: "NM-2026-0001",
      classLevel: "N5",
      feeAmount: 50000,
      baseUrl: "https://test.kuunyi.com",
      tenant: { ...BASE_TENANT, email_on_enroll: false },
    });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("does NOT send email when no email in form_data", () => {
    sendEnrollmentConfirmationEmail({
      fd: { name_en: "Test Student" },
      enrollmentRef: "NM-2026-0001",
      classLevel: "N5",
      feeAmount: 50000,
      baseUrl: "https://test.kuunyi.com",
      tenant: BASE_TENANT,
    });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("does NOT send email when fd is null", () => {
    sendEnrollmentConfirmationEmail({
      fd: null,
      enrollmentRef: "NM-2026-0001",
      classLevel: "N5",
      feeAmount: 50000,
      baseUrl: "https://test.kuunyi.com",
      tenant: BASE_TENANT,
    });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});
