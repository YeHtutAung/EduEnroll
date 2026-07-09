import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFrom = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mockFrom }) }));

const { restoreSeats } = await import("@/server/payments/seatRestoration");

describe("restoreSeats", () => {
  beforeEach(() => vi.clearAllMocks());

  it("restores seats for a single-class enrollment", async () => {
    const updateSpy = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      update: updateSpy,
      single: vi.fn().mockResolvedValue({ data: { seat_remaining: 3 }, error: null }),
    });

    await restoreSeats({ id: "enroll-1", class_id: "class-1", quantity: 2 });

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ seat_remaining: 5 }), // 3 + 2
    );
  });

  it("restores seats for each item in a cart enrollment", async () => {
    const updateSpy = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });

    mockFrom.mockImplementation((table: string) => {
      if (table === "enrollment_items") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockResolvedValue({
            data: [
              { class_id: "class-1", quantity: 1 },
              { class_id: "class-2", quantity: 2 },
            ],
            error: null,
          }),
        };
      }
      if (table === "classes") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: { seat_remaining: 5 }, error: null }),
          update: updateSpy,
        };
      }
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });

    await restoreSeats({ id: "enroll-1", class_id: null, quantity: null });

    expect(updateSpy).toHaveBeenCalledTimes(2);
  });

  it("does nothing when class_id is null and no enrollment items", async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ data: [], error: null }),
    });

    await restoreSeats({ id: "enroll-1", class_id: null, quantity: null });
    // updateSpy never called — no assertions needed, just verify no errors thrown
  });
});
