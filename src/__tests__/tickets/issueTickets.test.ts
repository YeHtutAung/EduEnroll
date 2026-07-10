import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { generateKeyPairSync } from "crypto";

// ─── Mutable fixtures read by the mock on each call ──────────────────
let ticketsCount = 0;
let enrollmentData: {
  id: string;
  tenant_id: string;
  class_id: string | null;
  quantity: number | null;
} | null = null;
let enrollmentItemsData: { class_id: string; quantity: number }[] = [];
let classesData: { id: string; level: string; intake_id: string; event_date: string | null }[] = [];

const mockUpsert = vi.fn().mockResolvedValue({ data: null, error: null });
const mockUpdateEq = vi.fn().mockResolvedValue({ data: null, error: null });
const mockUpdate = vi.fn().mockReturnValue({ eq: mockUpdateEq });

const mockAdminFrom = vi.fn((table: string) => {
  switch (table) {
    case "tickets":
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ count: ticketsCount, error: null }),
        }),
        upsert: mockUpsert,
        update: mockUpdate,
      };
    case "enrollments":
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: enrollmentData, error: null }),
      };
    case "enrollment_items":
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: enrollmentItemsData, error: null }),
        }),
      };
    case "classes":
      return {
        select: vi.fn().mockReturnValue({
          in: vi.fn().mockResolvedValue({ data: classesData, error: null }),
        }),
      };
    default:
      throw new Error(`Unexpected table in mock: ${table}`);
  }
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockAdminFrom }),
}));

const { issueTicketsForEnrollment, voidTicketsForEnrollment } =
  await import("@/server/tickets/issueTickets");

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("ed25519");
  process.env.TICKET_SIGNING_KEY = privateKey
    .export({ type: "pkcs8", format: "der" })
    .toString("base64");
  process.env.TICKET_KID = "test-kid";
});

beforeEach(() => {
  vi.clearAllMocks();
  ticketsCount = 0;
  enrollmentData = null;
  enrollmentItemsData = [];
  classesData = [];
});

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("issueTicketsForEnrollment", () => {
  it("materializes one ticket per admission for a single-class enrollment", async () => {
    ticketsCount = 0;
    enrollmentData = { id: "e1", tenant_id: "t1", class_id: "c1", quantity: 2 };
    classesData = [{ id: "c1", level: "GA", intake_id: "i1", event_date: "2026-07-12" }];

    await issueTicketsForEnrollment("e1");

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const rows = mockUpsert.mock.calls[0][0] as Record<string, unknown>[];
    const opts = mockUpsert.mock.calls[0][1] as { onConflict: string; ignoreDuplicates: boolean };
    expect(opts).toEqual({ onConflict: "enrollment_id,class_id,seat_no", ignoreDuplicates: true });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        tenant_id: "t1",
        intake_id: "i1",
        class_id: "c1",
        tier: "GA",
        admits: 1,
        status: "valid",
      });
      expect(row.exp).toMatch(ISO_RE);
    }
    expect(rows.map((r) => r.seat_no)).toEqual([1, 2]);
  });

  it("materializes tickets per class line for a cart enrollment", async () => {
    ticketsCount = 0;
    enrollmentData = { id: "e1", tenant_id: "t1", class_id: null, quantity: null };
    enrollmentItemsData = [
      { class_id: "c1", quantity: 2 },
      { class_id: "c2", quantity: 1 },
    ];
    classesData = [
      { id: "c1", level: "GA", intake_id: "i1", event_date: "2026-07-12" },
      { id: "c2", level: "VIP", intake_id: "i1", event_date: "2026-07-12" },
    ];

    await issueTicketsForEnrollment("e1");

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const rows = mockUpsert.mock.calls[0][0] as Record<string, unknown>[];
    expect(rows).toHaveLength(3);
    const gaRows = rows.filter((r) => r.tier === "GA");
    const vipRows = rows.filter((r) => r.tier === "VIP");
    expect(gaRows).toHaveLength(2);
    expect(vipRows).toHaveLength(1);
    expect(gaRows.map((r) => r.seat_no)).toEqual([1, 2]);
    expect(vipRows.map((r) => r.seat_no)).toEqual([1]);
    for (const row of rows) {
      expect(row).toMatchObject({ tenant_id: "t1", intake_id: "i1", admits: 1, status: "valid" });
    }
  });

  it("is idempotent: does nothing when tickets already exist for the enrollment", async () => {
    ticketsCount = 3;

    await issueTicketsForEnrollment("e1");

    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe("voidTicketsForEnrollment", () => {
  it("marks all tickets for the enrollment as void", async () => {
    await voidTicketsForEnrollment("e1");

    expect(mockAdminFrom).toHaveBeenCalledWith("tickets");
    expect(mockUpdate).toHaveBeenCalledWith({ status: "void" });
    expect(mockUpdateEq).toHaveBeenCalledWith("enrollment_id", "e1");
  });
});
