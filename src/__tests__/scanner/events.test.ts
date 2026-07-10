import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockAdminFrom = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockAdminFrom }),
}));

const mockResolveScannerTenant = vi.fn();
vi.mock("@/lib/scanner/apiKey", () => ({
  resolveScannerTenant: (request: NextRequest) => mockResolveScannerTenant(request),
}));

const { GET } = await import("@/app/api/events/route");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(authHeader?: string) {
  return new NextRequest("http://localhost/api/events", {
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

interface IntakeRow {
  id: string;
  name: string;
  status: string;
}

interface ClassRow {
  intake_id: string;
  event_date: string | null;
  venue: string | null;
}

function setupTables(intakes: IntakeRow[], classes: ClassRow[]) {
  mockAdminFrom.mockImplementation((table: string) => {
    if (table === "intakes") {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        then: (resolve: (v: { data: IntakeRow[]; error: null }) => unknown) =>
          resolve({ data: intakes, error: null }),
      };
    }
    if (table === "classes") {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        then: (resolve: (v: { data: ClassRow[]; error: null }) => unknown) =>
          resolve({ data: classes, error: null }),
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
}

describe("GET /api/events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when resolveScannerTenant returns null (missing/invalid key)", async () => {
    mockResolveScannerTenant.mockResolvedValue(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns only the tenant's open intakes shaped {id, name, date, location}", async () => {
    mockResolveScannerTenant.mockResolvedValue("tenant-1");

    const futureDate = "2026-07-12";
    setupTables(
      [{ id: "intake-1", name: "July Event", status: "open" }],
      [
        { intake_id: "intake-1", event_date: futureDate, venue: "Main Hall" },
        { intake_id: "intake-1", event_date: "2026-07-20", venue: "Overflow Room" },
      ],
    );

    const res = await GET(makeRequest("Bearer validkey"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([
      {
        id: "intake-1",
        name: "July Event",
        date: new Date(futureDate).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        }),
        location: "Main Hall",
      },
    ]);
  });

  it("excludes an intake whose only event_date is in the past, and one with no dated class", async () => {
    mockResolveScannerTenant.mockResolvedValue("tenant-1");

    setupTables(
      [
        { id: "intake-past", name: "Old Event", status: "open" },
        { id: "intake-nodate", name: "Undated Event", status: "open" },
        { id: "intake-future", name: "Future Event", status: "open" },
      ],
      [
        { intake_id: "intake-past", event_date: "2020-01-01", venue: "Somewhere" },
        { intake_id: "intake-nodate", event_date: null, venue: "Nowhere" },
        { intake_id: "intake-future", event_date: "2099-12-25", venue: "Future Hall" },
      ],
    );

    const res = await GET(makeRequest("Bearer validkey"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([
      {
        id: "intake-future",
        name: "Future Event",
        date: new Date("2099-12-25").toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        }),
        location: "Future Hall",
      },
    ]);
  });
});
