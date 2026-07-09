import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockSendEnrollmentConfirmationEmail = vi.fn();

vi.mock("@/server/enrollment/enrollmentEmails", () => ({
  sendEnrollmentConfirmationEmail: (...args: unknown[]) =>
    mockSendEnrollmentConfirmationEmail(...args),
}));

const { dispatchEnrollmentCreated } = await import(
  "@/server/notifications/dispatchEnrollmentCreated"
);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_TENANT = {
  name: "Nihon Moment",
  org_type: "language_school",
  logo_url: null,
  email_on_enroll: true,
  currency: "MMK",
} as const;

const BASE_INPUT = {
  fd: { name_en: "Aung Aung", email: "student@test.com" },
  enrollmentRef: "NM-2026-0001",
  classLevel: "N5",
  feeAmount: 50000,
  baseUrl: "https://example.com",
  tenant: BASE_TENANT,
} as const;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("dispatchEnrollmentCreated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Delegates to sendEnrollmentConfirmationEmail ──────────────────────────────

  it("calls sendEnrollmentConfirmationEmail with the full params", () => {
    dispatchEnrollmentCreated(BASE_INPUT);

    expect(mockSendEnrollmentConfirmationEmail).toHaveBeenCalledOnce();
    expect(mockSendEnrollmentConfirmationEmail).toHaveBeenCalledWith(BASE_INPUT);
  });

  it("passes fd=null through to the underlying function", () => {
    dispatchEnrollmentCreated({ ...BASE_INPUT, fd: null });

    expect(mockSendEnrollmentConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ fd: null }),
    );
  });

  it("passes email_on_enroll=false through to the underlying function", () => {
    dispatchEnrollmentCreated({
      ...BASE_INPUT,
      tenant: { ...BASE_TENANT, email_on_enroll: false },
    });

    expect(mockSendEnrollmentConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: expect.objectContaining({ email_on_enroll: false }),
      }),
    );
  });

  // ── Fire-and-forget: async email errors are swallowed inside the delegate ─────
  // sendEnrollmentConfirmationEmail itself catches async sendEmail errors.
  // dispatchEnrollmentCreated does not add an extra try-catch on top of it.
  // This test confirms a normal (non-throwing) call completes cleanly.
  it("completes without error when sendEnrollmentConfirmationEmail returns normally", () => {
    mockSendEnrollmentConfirmationEmail.mockReturnValueOnce(undefined);
    expect(() => dispatchEnrollmentCreated(BASE_INPUT)).not.toThrow();
  });

  // ── Return value ──────────────────────────────────────────────────────────────

  it("returns undefined (void)", () => {
    const result = dispatchEnrollmentCreated(BASE_INPUT);
    expect(result).toBeUndefined();
  });

  // ── Skips when contact info absent ────────────────────────────────────────────
  // The skipping logic lives inside sendEnrollmentConfirmationEmail (which checks
  // email_on_enroll and resolves email from fd). dispatchEnrollmentCreated just
  // delegates — it does not duplicate the guard. We verify the delegate IS called
  // even with no fd, so the underlying function can decide.

  it("still calls the underlying function when fd is null (let it decide)", () => {
    dispatchEnrollmentCreated({ ...BASE_INPUT, fd: null });
    expect(mockSendEnrollmentConfirmationEmail).toHaveBeenCalledOnce();
  });
});
