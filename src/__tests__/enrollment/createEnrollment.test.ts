import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRpc = vi.fn();
const mockFrom = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: mockRpc, from: mockFrom }),
}));

const { createEnrollment } = await import("@/server/enrollment/createEnrollment");

describe("createEnrollment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { intake_id: "intake-1" }, error: null }),
    });
  });

  it("returns validation error for invalid class_id", async () => {
    const result = await createEnrollment({ class_id: "not-a-uuid" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it("returns error for missing class_id", async () => {
    const result = await createEnrollment({ class_id: "" });
    expect(result.ok).toBe(false);
  });

  it("returns CLASS_FULL error when DB says full", async () => {
    mockRpc.mockResolvedValue({ data: { success: false, error: "CLASS_FULL" }, error: null });
    const result = await createEnrollment({ class_id: "00000000-0000-0000-0000-000000000001" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toBe("Class Full");
    }
  });

  it("returns success with enrollment result on valid input", async () => {
    mockRpc.mockResolvedValue({
      data: {
        success: true,
        enrollment_id: "enroll-1",
        enrollment_ref: "NM-2026-0001",
        class_level: "N5",
        fee_amount: 50000,
        quantity: 1,
        tenant_id: "tenant-abc",
      },
      error: null,
    });
    const result = await createEnrollment({ class_id: "00000000-0000-0000-0000-000000000001" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.enrollment_ref).toBe("NM-2026-0001");
  });

  it("calls submit_enrollment RPC with correct params", async () => {
    mockRpc.mockResolvedValue({ data: { success: false, error: "CLASS_NOT_FOUND" }, error: null });
    await createEnrollment({
      class_id: "00000000-0000-0000-0000-000000000001",
      idempotency_key: "key-abc",
      quantity: 2,
    });
    expect(mockRpc).toHaveBeenCalledWith("submit_enrollment", {
      p_class_id: "00000000-0000-0000-0000-000000000001",
      p_idempotency_key: "key-abc",
      p_quantity: 2,
    });
  });
});
