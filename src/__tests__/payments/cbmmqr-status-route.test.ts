import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Spec §5.4: PENDING | SUCCESS only. Local time never reports a QR dead, and
// the route never replaces an order.

Object.assign(process.env, {
  CBMMQR_YOUNGMONEY_USER_ID: "u", CBMMQR_YOUNGMONEY_PASSWORD: "p", CBMMQR_YOUNGMONEY_SOURCE_ID: "s",
  CBMMQR_YOUNGMONEY_MERCHANT_ID: "M0001", CBMMQR_YOUNGMONEY_TERMINAL_ID: "T0001", CBMMQR_YOUNGMONEY_API_KEY: "k",
});

let payment: Record<string, unknown> | null;
const mockFrom = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mockFrom }) }));
const mockStatus = vi.fn();
vi.mock("@/lib/cbmmqr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cbmmqr")>();
  return { ...actual, checkStatus: (...a: unknown[]) => mockStatus(...a) };
});
const mockSettle = vi.fn();
vi.mock("@/server/payments/settleCbmmqrPayment", () => ({
  settleCbmmqrPayment: (...a: unknown[]) => mockSettle(...a),
}));

const { GET } = await import("@/app/api/public/payments/cbmmqr/status/route");

const REF = "CBAAAAAAAAAAAAAAAAAAAAAAA";
const get = (ref: string | null = REF) =>
  GET(new NextRequest(`https://beatsrun.kuunyi.com/api/public/payments/cbmmqr/status${ref === null ? "" : `?ref=${ref}`}`));
const PAYMENT = {
  payment_ref: REF, payment_method: "cb_mmqr", cbmmqr_merchant: "YOUNGMONEY", status: "awaiting_payment",
  mmqr_status: "PENDING", provider_order_ref: "QR-1", provider_order_expires_at: "2026-10-31T04:03:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  payment = { ...PAYMENT };
  mockFrom.mockImplementation(() => ({
    select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: payment, error: null }) }) }) }),
  }));
  mockStatus.mockResolvedValue({ kind: "answer", code: "0006", currency: null, amount: null });
  mockSettle.mockResolvedValue({ kind: "settled" });
});

describe("GET /api/public/payments/cbmmqr/status", () => {
  it("400 without a well-formed ref", async () => {
    expect((await get(null)).status).toBe(400);
    expect((await get("KBZ_x")).status).toBe(400);
  });

  it("PENDING for an unknown reference", async () => {
    payment = null;
    expect(await (await get()).json()).toEqual({ mmqr_status: "PENDING" });
  });

  it("SUCCESS for a verified payment without calling CB", async () => {
    payment = { ...PAYMENT, status: "verified" };
    expect((await (await get()).json()).mmqr_status).toBe("SUCCESS");
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it("PENDING with expiresAt while CB says waiting — even long past the expiry", async () => {
    payment = { ...PAYMENT, provider_order_expires_at: "2020-01-01T00:00:00.000Z" };
    expect(await (await get()).json()).toEqual({ mmqr_status: "PENDING", expiresAt: "2020-01-01T00:00:00.000Z" });
  });

  it("PENDING without calling CB when CB's reference is unknown or the row is retired", async () => {
    payment = { ...PAYMENT, provider_order_ref: null };
    expect((await (await get()).json()).mmqr_status).toBe("PENDING");
    payment = { ...PAYMENT, mmqr_status: "EXPIRED" };
    expect((await (await get()).json()).mmqr_status).toBe("PENDING");
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it("settles through the wrapper on CB success and answers SUCCESS", async () => {
    const answer = { kind: "answer", code: "0000", currency: "MMK", amount: 40000 };
    mockStatus.mockResolvedValue(answer);
    expect((await (await get()).json()).mmqr_status).toBe("SUCCESS");
    expect(mockStatus).toHaveBeenCalledWith(expect.objectContaining({ id: "YOUNGMONEY" }), "QR-1", undefined);
    expect(mockSettle).toHaveBeenCalledWith(expect.objectContaining({
      payment: { payment_ref: REF, payment_method: "cb_mmqr", cbmmqr_merchant: "YOUNGMONEY" },
      status: answer, source: "status",
    }));
  });

  it.each(["refused", "retryable"])("PENDING when settlement is %s", async (kind) => {
    mockStatus.mockResolvedValue({ kind: "answer", code: "0000", currency: "MMK", amount: 40000 });
    mockSettle.mockResolvedValue({ kind, reason: "x" });
    expect((await (await get()).json()).mmqr_status).toBe("PENDING");
  });

  it("PENDING with expiresAt when the status check throws a configuration error", async () => {
    mockStatus.mockRejectedValue(new Error("CBMMQR_MODE is set to an unrecognised value"));
    expect(await (await get()).json()).toEqual({ mmqr_status: "PENDING", expiresAt: PAYMENT.provider_order_expires_at });
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("PENDING when the pinned merchant has no config", async () => {
    payment = { ...PAYMENT, cbmmqr_merchant: "NOCONFIG" };
    expect((await (await get()).json()).mmqr_status).toBe("PENDING");
    expect(mockStatus).not.toHaveBeenCalled();
  });
});
