import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRpc = vi.fn();
const mockFrom = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: mockRpc, from: mockFrom }),
}));

const { createCartEnrollment } = await import("@/server/enrollment/createCartEnrollment");

const VALID_UUID = "00000000-0000-0000-0000-000000000001";
const VALID_UUID_2 = "00000000-0000-0000-0000-000000000002";

describe("createCartEnrollment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { intake_id: "intake-1" }, error: null }),
    });
  });

  it("returns validation error for empty items array", async () => {
    const result = await createCartEnrollment({ items: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toBe("Validation Error");
      expect(result.message).toMatch(/at least one item/i);
    }
  });

  it("returns validation error for item with invalid class_id UUID", async () => {
    const result = await createCartEnrollment({
      items: [{ class_id: "not-a-uuid", quantity: 1 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toBe("Validation Error");
      expect(result.message).toMatch(/valid class_id UUID/i);
    }
  });

  it("returns validation error for item with empty class_id", async () => {
    const result = await createCartEnrollment({
      items: [{ class_id: "", quantity: 1 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });

  it("returns NOT_ENOUGH_SEATS error (409) when DB returns that code", async () => {
    mockRpc.mockResolvedValue({
      data: {
        success: false,
        error: "NOT_ENOUGH_SEATS",
        class_level: "GA",
        seat_remaining: 2,
      },
      error: null,
    });
    const result = await createCartEnrollment({
      items: [{ class_id: VALID_UUID, quantity: 5 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toBe("Not Enough Seats");
      expect(result.message).toContain("2");
    }
  });

  it("returns success with enrollment_ref and total_fee on valid input", async () => {
    mockRpc.mockResolvedValue({
      data: {
        success: true,
        enrollment_id: "enroll-cart-1",
        enrollment_ref: "NM-2026-0099",
        tenant_id: "tenant-xyz",
        total_fee: 100000,
        quantity: 2,
        items: [
          { class_id: VALID_UUID, class_level: "VIP", quantity: 2, fee_amount: 50000, subtotal: 100000 },
        ],
      },
      error: null,
    });
    const result = await createCartEnrollment({
      items: [{ class_id: VALID_UUID, quantity: 2 }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.enrollment_ref).toBe("NM-2026-0099");
      expect(result.result.total_fee).toBe(100000);
      expect(result.result.items).toHaveLength(1);
    }
  });

  it("calls submit_cart_enrollment RPC with correct params", async () => {
    mockRpc.mockResolvedValue({
      data: { success: false, error: "CLASS_NOT_FOUND" },
      error: null,
    });
    await createCartEnrollment({
      items: [
        { class_id: VALID_UUID, quantity: 1 },
        { class_id: VALID_UUID_2, quantity: 3 },
      ],
    });
    expect(mockRpc).toHaveBeenCalledWith("submit_cart_enrollment", {
      p_items: [
        { class_id: VALID_UUID, quantity: 1 },
        { class_id: VALID_UUID_2, quantity: 3 },
      ],
    });
  });

  it("returns 500 on RPC transport error", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: "connection refused" },
    });
    const result = await createCartEnrollment({
      items: [{ class_id: VALID_UUID, quantity: 1 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
    }
  });

  it("returns CLASS_NOT_OPEN error (409) for unavailable ticket type", async () => {
    mockRpc.mockResolvedValue({
      data: { success: false, error: "CLASS_NOT_OPEN", class_level: "N5" },
      error: null,
    });
    const result = await createCartEnrollment({
      items: [{ class_id: VALID_UUID, quantity: 1 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toBe("Ticket Unavailable");
    }
  });
});
