import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api", () => ({ resolveTenantId: vi.fn(async () => "tenant-1") }));

const mockFrom = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockFrom }),
}));

const stripe = {
  retrieve: vi.fn(),
  createMethod: vi.fn(),
  confirm: vi.fn(),
};
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    paymentIntents: {
      retrieve: (...args: unknown[]) => stripe.retrieve(...args),
      confirm: (...args: unknown[]) => stripe.confirm(...args),
    },
    paymentMethods: { create: (...args: unknown[]) => stripe.createMethod(...args) },
  }),
}));

type Resp = { data: unknown; error: { message: string } | null };
let queues: Record<string, Resp[]>;
function queue(table: string, response: Resp) {
  (queues[table] ??= []).push(response);
}
function chain(table: string) {
  const q: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in"]) q[method] = vi.fn(() => q);
  q.maybeSingle = vi.fn(async () => {
    const response = queues[table]?.shift();
    if (!response) throw new Error(`missing ${table} response`);
    return response;
  });
  return q;
}

const request = () =>
  new NextRequest(new Request("https://t.example/api/public/payments/stripe/paynow-confirm", {
    method: "POST",
    body: JSON.stringify({ enrollmentRef: "F-1", paymentIntentId: "pi_1" }),
  }));

beforeEach(() => {
  vi.clearAllMocks();
  queues = {};
  mockFrom.mockImplementation((table: string) => chain(table));
  stripe.retrieve.mockResolvedValue({ id: "pi_1", status: "requires_payment_method" });
  stripe.createMethod.mockResolvedValue({ id: "pm_1" });
  stripe.confirm.mockResolvedValue({
    next_action: {
      paynow_display_qr_code: {
        data: "PAYNOW-QR-DATA",
        image_url_png: "https://stripe.test/qr.png",
        image_url_svg: "https://stripe.test/qr.svg",
      },
    },
  });
});

describe("Stripe confirmation preflight", () => {
  it("rejects an expired enrollment before any Stripe call", async () => {
    queue("enrollments", { data: { id: "enr-1", status: "rejected" }, error: null });
    const { POST } = await import("@/app/api/public/payments/stripe/paynow-confirm/route");
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(stripe.retrieve).not.toHaveBeenCalled();
    expect(stripe.confirm).not.toHaveBeenCalled();
  });

  it("rejects a PaymentIntent that is not owned by the enrollment", async () => {
    queue("enrollments", { data: { id: "enr-1", status: "pending_payment" }, error: null });
    queue("payments", { data: null, error: null });
    const { POST } = await import("@/app/api/public/payments/stripe/paynow-confirm/route");
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(stripe.confirm).not.toHaveBeenCalled();
  });

  it("fails closed on a payment lookup error", async () => {
    queue("enrollments", { data: { id: "enr-1", status: "pending_payment" }, error: null });
    queue("payments", { data: null, error: { message: "db down" } });
    const { POST } = await import("@/app/api/public/payments/stripe/paynow-confirm/route");
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(stripe.confirm).not.toHaveBeenCalled();
  });

  it("confirms only an active owned attempt", async () => {
    queue("enrollments", { data: { id: "enr-1", status: "pending_payment" }, error: null });
    queue("payments", { data: { id: "pay-1", status: "awaiting_payment" }, error: null });
    const { POST } = await import("@/app/api/public/payments/stripe/paynow-confirm/route");
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      qrData: "PAYNOW-QR-DATA",
      qrImageUrl: "https://stripe.test/qr.png",
    });
    expect(stripe.confirm).toHaveBeenCalledTimes(1);
  });

  it("card validation route uses the same ownership gate", async () => {
    queue("enrollments", { data: { id: "enr-1", status: "pending_payment" }, error: null });
    queue("payments", { data: { id: "pay-1", status: "awaiting_payment" }, error: null });
    const { POST } = await import("@/app/api/public/payments/stripe/intent/validate/route");
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ eligible: true });
  });
});
