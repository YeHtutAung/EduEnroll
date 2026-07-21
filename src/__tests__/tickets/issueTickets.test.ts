import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { generateKeyPairSync } from "crypto";

// ─── Mutable fixtures read by the mock on each call ──────────────────
let ticketsCount = 0;
let enrollmentData: {
  id: string;
  tenant_id: string;
  class_id: string | null;
  quantity: number | null;
  status: string;
} | null = null;
// Configurable so the enrollment-load failure branch can be exercised: a DB
// error must throw, not be mistaken for "no tickets needed".
let enrollmentError: unknown = null;
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
      // maybeSingle, not single: issueTickets distinguishes "no row" from
      // "query failed", which .single() conflates by erroring on zero rows.
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: enrollmentData, error: enrollmentError }),
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
  enrollmentError = null;
  enrollmentItemsData = [];
  classesData = [];
});

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("issueTicketsForEnrollment", () => {
  it("materializes one ticket per admission for a single-class enrollment", async () => {
    ticketsCount = 0;
    enrollmentData = { id: "e1", tenant_id: "t1", class_id: "c1", quantity: 2, status: "confirmed" };
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
    enrollmentData = { id: "e1", tenant_id: "t1", class_id: null, quantity: null, status: "confirmed" };
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

// ─── Admission guard (#oversell) ─────────────────────────────────────
// A ticket is an admission. Issuing one for an enrollment that is no longer
// confirmed admits a second customer for a seat that was restored and resold.
// The db suite proves this end-to-end through the real trigger; these cover the
// branches cheaply, without a database.
describe("issueTicketsForEnrollment — admission guard", () => {
  it("mints no ticket when the enrollment is rejected", async () => {
    enrollmentData = { id: "e1", tenant_id: "t1", class_id: "c1", quantity: 2, status: "rejected" };
    classesData = [{ id: "c1", level: "VIP", intake_id: "i1", event_date: null }];

    const { issueTicketsForEnrollment } = await import("@/server/tickets/issueTickets");
    await issueTicketsForEnrollment("e1");

    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("mints no ticket when the enrollment is still pending payment", async () => {
    enrollmentData = { id: "e1", tenant_id: "t1", class_id: "c1", quantity: 1, status: "pending_payment" };
    classesData = [{ id: "c1", level: "VIP", intake_id: "i1", event_date: null }];

    const { issueTicketsForEnrollment } = await import("@/server/tickets/issueTickets");
    await issueTicketsForEnrollment("e1");

    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("throws when the enrollment lookup fails", async () => {
    // A database failure must not be read as "no ticket needed", which would
    // silently skip fulfillment for a legitimately confirmed enrollment.
    enrollmentData = null;
    enrollmentError = { message: "connection reset" };

    const { issueTicketsForEnrollment } = await import("@/server/tickets/issueTickets");
    await expect(issueTicketsForEnrollment("e1")).rejects.toThrow();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("returns quietly when the enrollment genuinely does not exist", async () => {
    enrollmentData = null;
    enrollmentError = null;

    const { issueTicketsForEnrollment } = await import("@/server/tickets/issueTickets");
    await expect(issueTicketsForEnrollment("missing")).resolves.toBeUndefined();
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
