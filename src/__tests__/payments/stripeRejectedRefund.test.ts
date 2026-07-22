import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateRefund = vi.fn();
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ refunds: { create: (...args: unknown[]) => mockCreateRefund(...args) } }),
}));

const mockFrom = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockFrom }),
}));

function conflictUpdate(result: { data: unknown; error: unknown }) {
  const q: Record<string, unknown> = {};
  for (const method of ["update", "eq"]) q[method] = vi.fn(() => q);
  q.select = vi.fn(async () => result);
  return q;
}

const { refundRejectedStripePayment, reconcileStripeRefund } =
  await import("@/server/payments/refundRejectedStripePayment");

beforeEach(() => {
  vi.clearAllMocks();
  mockFrom.mockImplementation(() => conflictUpdate({ data: [{ id: "conflict-1" }], error: null }));
});

describe("automatic refund for rejected enrollment settlement", () => {
  it("creates one idempotent refund and resolves an immediately successful refund", async () => {
    mockCreateRefund.mockResolvedValue({
      id: "re_1",
      status: "succeeded",
      payment_intent: "pi_1",
      metadata: { integration_namespace: "eduenroll", conflict_type: "rejected_enrollment" },
    });
    await refundRejectedStripePayment("pi_1");
    expect(mockCreateRefund).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_1" }),
      { idempotencyKey: "eduenroll:refund:rejected:pi_1" },
    );
    const chain = mockFrom.mock.results[0].value;
    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "resolved",
      resolution_note: "Automatic refund re_1: succeeded",
    }));
  });

  it("keeps an asynchronous PayNow refund open while pending", async () => {
    mockCreateRefund.mockResolvedValue({
      id: "pyr_1",
      status: "pending",
      payment_intent: "pi_1",
      metadata: { integration_namespace: "eduenroll", conflict_type: "rejected_enrollment" },
    });
    await refundRejectedStripePayment("pi_1");
    const chain = mockFrom.mock.results[0].value;
    expect(chain.update).toHaveBeenCalledWith({ resolution_note: "Automatic refund pyr_1: pending" });
  });

  it("updates the Session conflict when hosted Checkout owns the payment", async () => {
    mockCreateRefund.mockResolvedValue({
      id: "re_checkout",
      status: "succeeded",
      payment_intent: "pi_1",
      metadata: {
        integration_namespace: "eduenroll",
        conflict_type: "rejected_enrollment",
        conflict_object_id: "cs_1",
      },
    });

    await refundRejectedStripePayment("pi_1", "cs_1");

    const chain = mockFrom.mock.results[0].value;
    expect(chain.eq).toHaveBeenCalledWith("provider_object_id", "cs_1");
  });

  it("refund.updated resolves the matching conflict", async () => {
    await reconcileStripeRefund({
      id: "pyr_1",
      status: "succeeded",
      payment_intent: "pi_1",
      metadata: {
        integration_namespace: "eduenroll",
        conflict_type: "rejected_enrollment",
        conflict_object_id: "pi_1",
      },
    } as never);
    const chain = mockFrom.mock.results[0].value;
    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ status: "resolved" }));
  });

  it("ignores refunds not owned by this integration", async () => {
    await reconcileStripeRefund({
      id: "re_other",
      status: "succeeded",
      payment_intent: "pi_other",
      metadata: {},
    } as never);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
