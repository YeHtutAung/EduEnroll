import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Route-level wiring tests. abank.test.ts covers verifyEnquiry() as a pure
// function; these prove the HANDLER actually consults it — that a future change
// can't bypass the verifier, resurrect callback-derived fields, or mutate state
// before the enquiry, while the pure tests all stay green.

const mockAdminFrom = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockAdminFrom }),
}));

// Mock only enquiryOrder — verifyEnquiry stays REAL so these exercise the
// genuine decision path rather than a stubbed one.
const mockEnquiryOrder = vi.fn();
vi.mock("@/lib/abank", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/abank")>();
  return {
    ...actual,
    default: { ...actual.default, enquiryOrder: mockEnquiryOrder },
  };
});

vi.mock("@/server/tickets/issueTickets", () => ({
  issueTicketsForEnrollment: vi.fn().mockResolvedValue(undefined),
}));

const { GET } = await import("@/app/api/webhooks/abank/route");

const PAYMENT = { id: "pay-1", enrollment_id: "enr-1", status: "awaiting_payment", amount: 50000 };

let paymentUpdates: Record<string, unknown>[];
let enrollmentUpdates: Record<string, unknown>[];

beforeEach(() => {
  vi.clearAllMocks();
  paymentUpdates = [];
  enrollmentUpdates = [];

  mockAdminFrom.mockImplementation((table: string) => {
    if (table === "payments") {
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: PAYMENT, error: null }) }) }),
        update: (payload: Record<string, unknown>) => {
          paymentUpdates.push(payload);
          return { eq: async () => ({ error: null }) };
        },
      };
    }
    if (table === "enrollments") {
      return {
        update: (payload: Record<string, unknown>) => {
          enrollmentUpdates.push(payload);
          return { eq: async () => ({ error: null }) };
        },
        // null short-circuits the notification block — not under test here.
        select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
      };
    }
    return {
      select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
    };
  });
});

// A forged callback: claims success, carries fabricated audit metadata, and
// fabricated error fields. Every value here is attacker-supplied.
function forgedCallback() {
  const qs = new URLSearchParams({
    orderId: "AB-ABC123-999",
    status: "SUCCESS",
    transactionId: "FORGED-TXN",
    endToEndId: "FORGED-E2E",
    institutionName: "Forged Bank",
    transactionDateTime: "1999-01-01 00:00:00",
    errorCode: "FORGED-CODE",
    errorDesc: "Forged description",
  });
  return new NextRequest(`https://kuunyi.com/api/webhooks/abank?${qs}`);
}

// Every value the forged callback carries. No stored field may contain any of
// them, on ANY verdict path — the success branch and the failed branch are the
// same trust boundary, and treating them separately is how the failed path kept
// writing errorCode after the success path was fixed.
const FORGED_VALUES = [
  "FORGED-TXN",
  "FORGED-E2E",
  "Forged Bank",
  "1999",
  "FORGED-CODE",
  "Forged description",
];

function expectNoForgedValues(payload: Record<string, unknown> | undefined) {
  const stored = JSON.stringify(payload ?? {});
  for (const forged of FORGED_VALUES) {
    expect(stored, `stored payload leaked "${forged}"`).not.toContain(forged);
  }
}

function enquiry(over: Record<string, unknown> = {}) {
  return {
    data: { paymentTxnStatus: 200, orderId: "AB-ABC123-999", amount: 50000, ...over },
    respondMessage: "OK",
    respondCode: 0,
  };
}

describe("ABank callback route — the provider decides, not the caller", () => {
  it("does not confirm when the callback claims success but ABank says pending", async () => {
    mockEnquiryOrder.mockResolvedValue(enquiry({ paymentTxnStatus: 100 }));

    const res = await GET(forgedCallback());

    expect(res.status).toBe(200);
    expect(paymentUpdates).toEqual([]);
    expect(enrollmentUpdates).toEqual([]);
  });

  it("confirms when ABank reports the payment settled", async () => {
    mockEnquiryOrder.mockResolvedValue(enquiry({ transactionId: "REAL-TXN" }));

    const res = await GET(forgedCallback());

    expect(res.status).toBe(200);
    expect(paymentUpdates[0]).toMatchObject({ status: "verified", mmqr_status: "SUCCESS" });
    expect(enrollmentUpdates[0]).toMatchObject({ status: "confirmed" });
  });

  // The audit-field boundary on the SUCCESS path: even on a genuinely settled
  // payment, nothing the caller sent may reach stored data.
  it("never writes callback-supplied audit values on success", async () => {
    mockEnquiryOrder.mockResolvedValue(enquiry()); // no txn id / institution

    await GET(forgedCallback());

    expectNoForgedValues(paymentUpdates[0]);
    expect(paymentUpdates[0]).toMatchObject({
      bank_reference: "CB:verified",
      payer_institution: null,
    });
    // paid_at is server time, not the caller's 1999 timestamp.
    const paidAt = new Date(paymentUpdates[0].paid_at as string).getFullYear();
    expect(paidAt).toBe(new Date().getFullYear());
  });

  // The same boundary on the FAILED path. This is the one that regressed: the
  // success path was corrected while this branch kept writing errorCode and
  // errorDesc into bank_reference.
  it("never writes callback-supplied error values on failure", async () => {
    mockEnquiryOrder.mockResolvedValue(enquiry({ paymentTxnStatus: 500 }));

    await GET(forgedCallback());

    expectNoForgedValues(paymentUpdates[0]);
    expect(paymentUpdates[0]).toMatchObject({
      mmqr_status: "FAILED",
      bank_reference: "provider-failed", // the verdict, nothing else
    });
  });

  // Both rejection reasons, same rule — so a future branch can't reintroduce it.
  it("stores only the verdict reason for every failure kind", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ paymentTxnStatus: 500 }, "provider-failed"],
      [{ amount: 1 }, "amount-mismatch"],
      [{ orderId: "AB-SOMEONE-ELSE" }, "order-id-mismatch"],
    ];

    for (const [over, reason] of cases) {
      paymentUpdates = [];
      mockEnquiryOrder.mockResolvedValue(enquiry(over));

      await GET(forgedCallback());

      expectNoForgedValues(paymentUpdates[0]);
      expect(paymentUpdates[0]).toMatchObject({ bank_reference: reason });
    }
  });

  it("prefers ABank's transaction id when it supplies one", async () => {
    mockEnquiryOrder.mockResolvedValue(enquiry({ transactionId: "REAL-TXN", institutionName: "ABank" }));

    await GET(forgedCallback());

    expect(paymentUpdates[0]).toMatchObject({
      bank_reference: "CB:REAL-TXN",
      payer_institution: "ABank",
    });
  });

  it("does not confirm a short payment", async () => {
    mockEnquiryOrder.mockResolvedValue(enquiry({ amount: 1 }));

    await GET(forgedCallback());

    expect(paymentUpdates[0]).toMatchObject({ mmqr_status: "FAILED" });
    expect(paymentUpdates[0]).not.toHaveProperty("status", "verified");
    expect(enrollmentUpdates).toEqual([]);
  });

  it("does not confirm when ABank echoes a different order", async () => {
    mockEnquiryOrder.mockResolvedValue(enquiry({ orderId: "AB-SOMEONE-ELSE" }));

    await GET(forgedCallback());

    expect(enrollmentUpdates).toEqual([]);
  });

  // Availability: an enquiry outage must not confirm, and must not reject a
  // payment that may be real — leave it for the status poller.
  it("returns 502 and mutates nothing when the enquiry call fails", async () => {
    mockEnquiryOrder.mockRejectedValue(new Error("network"));

    const res = await GET(forgedCallback());

    expect(res.status).toBe(502);
    expect(paymentUpdates).toEqual([]);
    expect(enrollmentUpdates).toEqual([]);
  });

  it("asks ABank about the order id it was given", async () => {
    mockEnquiryOrder.mockResolvedValue(enquiry());

    await GET(forgedCallback());

    expect(mockEnquiryOrder).toHaveBeenCalledWith("AB-ABC123-999");
  });
});
