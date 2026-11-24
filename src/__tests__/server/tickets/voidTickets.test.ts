import { describe, it, expect, vi, beforeEach } from "vitest";

// Voiding is one SQL call (plan 4 decision 1): void_enrollment_tickets voids the
// order's tickets, cancels their open share links and logs `voided` under the
// ticket locks. A void that didn't happen must never look done.

const mockRpc = vi.fn();
const mockFrom = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: mockRpc, from: mockFrom }),
}));

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@/server/conversions/sendPendingConversions", () => ({
  sendPendingConversions: vi.fn(),
}));

const { voidTicketsForEnrollment } = await import("@/server/tickets/issueTickets");

describe("voidTicketsForEnrollment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("calls void_enrollment_tickets once with the enrollment id", async () => {
    mockRpc.mockResolvedValue({ data: 2, error: null });

    await expect(voidTicketsForEnrollment("e1")).resolves.toBeUndefined();

    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith("void_enrollment_tickets", { p_enrollment_id: "e1" });
    // No direct table write: the SQL function is the only path.
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("throws 'void failed' when the RPC returns an error", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "42501", message: "permission denied" } });

    await expect(voidTicketsForEnrollment("e1")).rejects.toThrow(new Error("void failed"));
  });
});
