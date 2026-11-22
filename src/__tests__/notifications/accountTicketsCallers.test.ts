import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { chainQuery } from "@/__tests__/helpers/chainQuery";

// Task 15 (design 8.1): every one of the six confirmation-email callers asks
// buildTicketEmailParts. An order with account-bound tickets gets no PDF for
// them and an "Open My Tickets" link on the TENANT's host; an unprotected order
// gets its PDF and no link, as before.

process.env.NEXT_PUBLIC_APP_URL = "https://kuunyi.com";
const TENANT_LINK = "https://skyfestival.kuunyi.com/account/tickets";

const { mockFrom, mockSendEmail, mockParts, mockRequireAuth } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockSendEmail: vi.fn(),
  mockParts: vi.fn(),
  mockRequireAuth: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mockFrom }) }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendEmail: mockSendEmail,
}));
vi.mock("@/server/tickets/eticketEmailAttachment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/tickets/eticketEmailAttachment")>()),
  buildTicketEmailParts: mockParts,
}));
vi.mock("@/server/notifications/eventEmailTerms", () => ({ loadEventEmailTerms: async () => null }));
vi.mock("@/server/notifications/eventEmailImages", () => ({ loadEventEmailImages: async () => [] }));
vi.mock("@/server/notifications/eventEmailRunners", () => ({ loadEmailRunners: async () => [] }));
vi.mock("@/lib/sms", () => ({ sendSms: vi.fn(async () => true) }));
vi.mock("@/lib/messenger/notify", () => ({ sendStatusNotification: vi.fn(async () => true) }));
vi.mock("@/lib/telegram/notify", () => ({ sendTelegramStatusNotification: vi.fn(async () => true) }));
vi.mock("@/lib/telegram/channel-invite", () => ({ sendChannelInviteIfEligible: vi.fn(async () => true) }));
vi.mock("@/server/tickets/issueTickets", () => ({ issueTicketsForEnrollment: vi.fn(async () => undefined) }));
vi.mock("@/lib/mmpay", () => ({ default: { verifyCb: vi.fn(async () => true) } }));
vi.mock("@/lib/abank", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/abank")>();
  return {
    ...actual,
    default: {
      ...actual.default,
      enquiryOrder: vi.fn(async (orderId: string) => ({
        data: { paymentTxnStatus: 200, orderId, amount: 50000 },
        respondMessage: "OK",
        respondCode: 0,
      })),
    },
  };
});
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  requireAuth: mockRequireAuth,
}));

const { notifyEnrollmentConfirmed } = await import("@/server/payments/notifyEnrollmentConfirmed");
const { dispatchPaymentApproved } = await import("@/server/notifications/dispatchPaymentApproved");
const mmpayRoute = await import("@/app/api/webhooks/mmpay/route");
const abankRoute = await import("@/app/api/webhooks/abank/route");
const abankStatusRoute = await import("@/app/api/public/payments/abank/status/route");
const resendRoute = await import("@/app/api/admin/enrollments/[id]/resend-email/route");

const PDF = { filename: "eticket-SF2-1123-AAAAAA.pdf", content: "cGRm" };
const PROTECTED_ONLY = { attachment: null, accountTickets: true };
const MIXED = { attachment: PDF, accountTickets: true };
const UNPROTECTED = { attachment: PDF, accountTickets: false };

const ENROLLMENT = {
  id: "enr-1",
  tenant_id: "tenant-1",
  telegram_chat_id: null,
  messenger_psid: null,
  email: "buyer@example.test",
  phone: null,
  enrollment_ref: "SF2-1123-AAAAAA",
  student_name_en: "Buyer",
  class_id: "class-1",
  quantity: 1,
  form_data: null,
  status: "confirmed",
  buyer_id: null as string | null,
};
const PAYMENT = {
  id: "pay-1",
  enrollment_id: "enr-1",
  status: "awaiting_payment",
  mmqr_status: "PENDING",
  amount: 50000,
};
const TENANT = {
  name: "Sky Festival",
  org_type: "event",
  logo_url: null,
  currency: "MMK",
  sms_on_payment: false,
  subdomain: "skyfestival",
};

function routeTables(over: Partial<Record<string, { data: unknown; error: unknown }>> = {}) {
  const results: Record<string, { data: unknown; error: unknown }> = {
    enrollments: { data: ENROLLMENT, error: null },
    classes: { data: { level: "General Access", fee_amount: 50000 }, error: null },
    tenants: { data: TENANT, error: null },
    payments: { data: PAYMENT, error: null },
    enrollment_items: { data: [], error: null },
    ...over,
  };
  mockFrom.mockImplementation((table: string) => chainQuery(results[table] ?? { data: null, error: null }));
}

function sentEmail() {
  expect(mockSendEmail).toHaveBeenCalledOnce();
  return mockSendEmail.mock.calls[0][0] as { html: string; attachments?: unknown[] };
}

function expectAccountEmail(withPdf: boolean) {
  const email = sentEmail();
  expect(email.html).toContain(`href="${TENANT_LINK}"`);
  expect(email.html).toContain("Open My Tickets");
  if (withPdf) expect(email.attachments).toEqual([PDF]);
  else expect(email).not.toHaveProperty("attachments");
}

function expectPlainEmail() {
  const email = sentEmail();
  expect(email.html).not.toContain("/account/tickets");
  expect(email.html).not.toContain("Open My Tickets");
  expect(email.attachments).toEqual([PDF]);
}

type Caller = { name: string; run: () => Promise<unknown> };

const callers: Caller[] = [
  { name: "notifyEnrollmentConfirmed", run: () => notifyEnrollmentConfirmed("enr-1") },
  {
    name: "dispatchPaymentApproved (status link on the platform root)",
    run: () =>
      dispatchPaymentApproved({
        tenantId: "tenant-1",
        enrollmentId: "enr-1",
        enrollmentRef: "SF2-1123-AAAAAA",
        studentName: "Buyer",
        classLevel: "General Access",
        statusUrl: "https://kuunyi.com/status?ref=SF2-1123-AAAAAA",
        paymentUrl: "https://kuunyi.com/status?ref=SF2-1123-AAAAAA",
        currency: "MMK",
        email: "buyer@example.test",
        orgType: "event",
        tenantName: "Sky Festival",
      }),
  },
  {
    name: "POST /api/webhooks/mmpay",
    run: () =>
      mmpayRoute.POST(
        new NextRequest("https://kuunyi.com/api/webhooks/mmpay", {
          method: "POST",
          body: JSON.stringify({ orderId: "MM-1", status: "SUCCESS", transactionRefId: "T1" }),
        }),
      ),
  },
  {
    name: "GET /api/webhooks/abank",
    run: () => abankRoute.GET(new NextRequest("https://kuunyi.com/api/webhooks/abank?orderId=AB-1&status=SUCCESS")),
  },
  {
    name: "GET /api/public/payments/abank/status",
    run: () =>
      abankStatusRoute.GET(new NextRequest("https://skyfestival.kuunyi.com/api/public/payments/abank/status?ref=AB-1")),
  },
  {
    name: "POST /api/admin/enrollments/[id]/resend-email",
    run: () =>
      resendRoute.POST(
        new NextRequest("https://skyfestival.kuunyi.com/api/admin/enrollments/enr-1/resend-email", {
          method: "POST",
          body: "{}",
        }),
        { params: { id: "enr-1" } },
      ),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockSendEmail.mockResolvedValue(true);
  routeTables();
  mockRequireAuth.mockResolvedValue({ supabase: { from: mockFrom }, tenantId: "tenant-1" });
});

describe.each(callers)("$name", ({ run }) => {
  it("an all-protected order: no attachment, Open My Tickets on the tenant host", async () => {
    mockParts.mockResolvedValue(PROTECTED_ONLY);
    await run();
    expect(mockParts).toHaveBeenCalledWith("enr-1");
    expectAccountEmail(false);
  });

  it("a mixed order: the unprotected PDF plus Open My Tickets", async () => {
    mockParts.mockResolvedValue(MIXED);
    await run();
    expectAccountEmail(true);
  });

  it("an unprotected order: the PDF and no account link, as before", async () => {
    mockParts.mockResolvedValue(UNPROTECTED);
    await run();
    expectPlainEmail();
  });

  it("a failed parts lookup falls back to no PDF and no link", async () => {
    mockParts.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await run();
    spy.mockRestore();
    const email = sentEmail();
    expect(email).not.toHaveProperty("attachments");
    expect(email.html).not.toContain("/account/tickets");
  });
});

describe("dispatchPaymentApproved — tenant host lookup", () => {
  it("falls back to the status link's host when the tenant row can't be read", async () => {
    routeTables({ tenants: { data: null, error: { code: "XX000" } } });
    mockParts.mockResolvedValue(PROTECTED_ONLY);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await callers[1].run();
    spy.mockRestore();
    expect(sentEmail().html).toContain('href="https://kuunyi.com/account/tickets"');
  });
});

describe("POST /api/admin/enrollments/[id]/resend-email — account orders", () => {
  const resend = (body: unknown) =>
    resendRoute.POST(
      new NextRequest("https://skyfestival.kuunyi.com/api/admin/enrollments/enr-1/resend-email", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      { params: { id: "enr-1" } },
    );

  it("refuses another email for an order with a buyer account", async () => {
    routeTables({ enrollments: { data: { ...ENROLLMENT, buyer_id: "buyer-1" }, error: null } });
    mockParts.mockResolvedValue(PROTECTED_ONLY);

    const res = await resend({ email: "someone-else@example.test" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Conflict",
      message: "This order belongs to a buyer account; its email is the account's email.",
    });
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockParts).not.toHaveBeenCalled();
  });

  it("still resends to the account email", async () => {
    routeTables({ enrollments: { data: { ...ENROLLMENT, buyer_id: "buyer-1" }, error: null } });
    mockParts.mockResolvedValue(PROTECTED_ONLY);

    const res = await resend({});

    expect(res.status).toBe(200);
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "buyer@example.test" }));
  });

  it("accepts the account email itself typed as the override", async () => {
    routeTables({ enrollments: { data: { ...ENROLLMENT, buyer_id: "buyer-1" }, error: null } });
    mockParts.mockResolvedValue(PROTECTED_ONLY);

    const res = await resend({ email: " Buyer@Example.test " });

    expect(res.status).toBe(200);
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "buyer@example.test" }));
  });

  it("an account order with no stored email refuses (never falls back to the form's address)", async () => {
    for (const email of [null, ""]) {
      routeTables({
        enrollments: {
          data: { ...ENROLLMENT, buyer_id: "buyer-1", email, form_data: { email: "form@example.test" } },
          error: null,
        },
      });
      mockParts.mockResolvedValue(PROTECTED_ONLY);
      const res = await resend({});
      expect(res.status).toBe(409);
      expect(mockSendEmail).not.toHaveBeenCalled();
    }
  });

  it("an order without a buyer account still takes an override, as before", async () => {
    mockParts.mockResolvedValue(UNPROTECTED);

    const res = await resend({ email: "other@example.test" });

    expect(res.status).toBe(200);
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "other@example.test" }));
  });
});
