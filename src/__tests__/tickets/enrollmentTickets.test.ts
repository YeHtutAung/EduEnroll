import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { NextRequest } from "next/server";
import { generateKeyPairSync } from "crypto";

const mockAdminFrom = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockAdminFrom }),
}));

vi.mock("@/lib/api", () => ({
  resolveTenantId: vi.fn().mockResolvedValue("tenant-1"),
}));

vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    paymentIntents: { retrieve: vi.fn() },
  }),
}));

const { GET } = await import("@/app/api/public/enrollment/[ref]/route");
const { verifyTicketJwt } = await import("@/lib/tickets/sign");

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("ed25519");
  process.env.TICKET_SIGNING_KEY = privateKey
    .export({ type: "pkcs8", format: "der" })
    .toString("base64");
  process.env.TICKET_KID = "test-kid";
});

function makeRequest() {
  return new NextRequest("http://localhost/api/public/enrollment/NM-2026-0001");
}

const TICKETS = [
  {
    id: "ticket-1",
    intake_id: "intake-1",
    tier: "GA",
    admits: 1,
    exp: "2026-12-31T00:00:00.000Z",
    status: "valid",
  },
  {
    id: "ticket-2",
    intake_id: "intake-1",
    tier: "VIP",
    admits: 2,
    exp: "2026-12-31T00:00:00.000Z",
    status: "valid",
  },
  {
    id: "ticket-3",
    intake_id: "intake-1",
    tier: "GA",
    admits: 1,
    exp: "2026-12-31T00:00:00.000Z",
    status: "void",
  },
];

function setupMocks(enrollmentStatus: string, opts: { withTickets?: boolean } = {}) {
  const { withTickets = false } = opts;

  mockAdminFrom.mockImplementation((table: string) => {
    if (table === "enrollments") {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: {
            id: "enrollment-1",
            enrollment_ref: "NM-2026-0001",
            status: enrollmentStatus,
            student_name_en: "Test Student",
            email: "test@example.com",
            quantity: 1,
            enrollment_items: [],
            classes: null,
            payments: [],
          },
          error: null,
        }),
      };
    }

    if (table === "tickets") {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({
          data: withTickets ? TICKETS : [],
          error: null,
        }),
      };
    }

    if (table === "tenant_appearances") {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { logo_url: null, primary_color: null },
          error: null,
        }),
      };
    }

    if (table === "tenants") {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { payment_mode: "bank_transfer", mmqr_provider: null },
          error: null,
        }),
      };
    }

    if (table === "bank_accounts") {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({ data: [], error: null }),
      };
    }

    throw new Error(`Unexpected table: ${table}`);
  });
}

describe("GET /api/public/enrollment/[ref] tickets", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns signed ticket JWTs for a confirmed enrollment with valid tickets", async () => {
    setupMocks("confirmed", { withTickets: true });

    const res = await GET(makeRequest(), { params: { ref: "NM-2026-0001" } });
    expect(res.status).toBe(200);
    const body = await res.json();

    // Only the 2 "valid" tickets should be included — the "void" one excluded.
    expect(body.tickets).toHaveLength(2);

    for (const t of body.tickets) {
      expect(t).toHaveProperty("jti");
      expect(t).toHaveProperty("tier");
      expect(t).toHaveProperty("admits");
      expect(t).toHaveProperty("jwt");

      const claims = verifyTicketJwt(t.jwt);
      expect(claims.jti).toBe(t.jti);
      expect(claims.eid).toBe("intake-1");
      expect(claims.tier).toBe(t.tier);
      expect(claims.admits).toBe(t.admits);
      expect(claims.exp).toBe(Math.floor(Date.parse("2026-12-31T00:00:00.000Z") / 1000));
    }

    const jtis = body.tickets.map((t: { jti: string }) => t.jti).sort();
    expect(jtis).toEqual(["ticket-1", "ticket-2"]);
  });

  it("returns an empty tickets array and never queries tickets for an unconfirmed enrollment", async () => {
    setupMocks("pending_payment", { withTickets: true });

    const res = await GET(makeRequest(), { params: { ref: "NM-2026-0001" } });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.tickets).toEqual([]);
    expect(mockAdminFrom).not.toHaveBeenCalledWith("tickets");
  });
});
