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

type IntakeFormats = {
  data: { id: string; ticket_qr_format: string; ticket_protection?: boolean }[] | null;
  error: unknown;
};

function setupMocks(
  enrollmentStatus: string,
  opts: { withTickets?: boolean; intakes?: IntakeFormats; tickets?: unknown[] } = {},
) {
  const {
    withTickets = false,
    intakes = { data: [{ id: "intake-1", ticket_qr_format: "jwt" }], error: null },
    tickets = TICKETS,
  } = opts;

  mockAdminFrom.mockImplementation((table: string) => {
    if (table === "intakes") {
      return {
        select: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue(intakes),
      };
    }

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
          data: withTickets ? tickets : [],
          error: null,
        }),
      };
    }

    // Singular — the real table. This mock previously answered to
    // "tenant_appearances", matching a typo in the route, so the suite passed
    // while production silently returned no branding at all.
    if (table === "tenant_appearance") {
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

  it("puts the signed token in the QR for an event on the jwt format", async () => {
    setupMocks("confirmed", { withTickets: true });

    const body = await (await GET(makeRequest(), { params: { ref: "NM-2026-0001" } })).json();

    for (const t of body.tickets) expect(t.qr).toBe(t.jwt);
  });

  it("puts the bare ticket UUID in the QR for an event on the uuid format, and still returns the jwt", async () => {
    setupMocks("confirmed", {
      withTickets: true,
      intakes: { data: [{ id: "intake-1", ticket_qr_format: "uuid" }], error: null },
    });

    const res = await GET(makeRequest(), { params: { ref: "NM-2026-0001" } });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.tickets).toHaveLength(2);
    for (const t of body.tickets) {
      expect(t.qr).toBe(t.jti);
      expect(verifyTicketJwt(t.jwt).jti).toBe(t.jti);
    }
  });

  // Not knowing the format is not the same as the default format: a jwt QR on
  // a uuid event is a ticket the gate cannot read. So no ticket at all.
  it("fails closed with 503 and no tickets when the event format lookup fails", async () => {
    setupMocks("confirmed", {
      withTickets: true,
      intakes: { data: null, error: { code: "57014", message: "timeout" } },
    });

    const res = await GET(makeRequest(), { params: { ref: "NM-2026-0001" } });
    expect(res.status).toBe(503);
    expect((await res.json()).tickets).toBeUndefined();
  });

  it("fails closed with 503 when a ticket's event has no readable format", async () => {
    setupMocks("confirmed", {
      withTickets: true,
      intakes: { data: [{ id: "intake-1", ticket_qr_format: "barcode" }], error: null },
    });

    const res = await GET(makeRequest(), { params: { ref: "NM-2026-0001" } });
    expect(res.status).toBe(503);
  });

  it("does not look up event formats when there are no valid tickets", async () => {
    setupMocks("confirmed", { withTickets: false });

    const res = await GET(makeRequest(), { params: { ref: "NM-2026-0001" } });
    expect(res.status).toBe(200);
    expect((await res.json()).tickets).toEqual([]);
    expect(mockAdminFrom).not.toHaveBeenCalledWith("intakes");
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

// Task 15 (design 8.1): a ticket on an account-bound (protected) event is never
// signed or returned here. It lives only on /account/tickets; the response says
// how many there are so the pages can send the buyer there.
describe("GET /api/public/enrollment/[ref] — account-bound tickets", () => {
  beforeEach(() => vi.clearAllMocks());

  const MIXED = [
    { id: "open-1", intake_id: "intake-open", tier: "GA", admits: 1, exp: "2026-12-31T00:00:00.000Z", status: "valid" },
    { id: "bound-1", intake_id: "intake-bound", tier: "VIP", admits: 1, exp: "2026-12-31T00:00:00.000Z", status: "valid" },
    { id: "bound-2", intake_id: "intake-bound", tier: "VIP", admits: 1, exp: "2026-12-31T00:00:00.000Z", status: "valid" },
    { id: "bound-void", intake_id: "intake-bound", tier: "VIP", admits: 1, exp: "2026-12-31T00:00:00.000Z", status: "void" },
  ];
  const INTAKES: IntakeFormats = {
    data: [
      { id: "intake-open", ticket_qr_format: "jwt", ticket_protection: false },
      { id: "intake-bound", ticket_qr_format: "jwt", ticket_protection: true },
    ],
    error: null,
  };

  it("leaves protected tickets out entirely and counts them", async () => {
    setupMocks("confirmed", { withTickets: true, tickets: MIXED, intakes: INTAKES });

    const res = await GET(makeRequest(), { params: { ref: "NM-2026-0001" } });
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);

    expect(body.tickets.map((t: { jti: string }) => t.jti)).toEqual(["open-1"]);
    expect(body.account_ticket_count).toBe(2);
    // No id, token or QR for a protected ticket anywhere in the body.
    expect(text).not.toContain("bound-1");
    expect(text).not.toContain("bound-2");
    expect(verifyTicketJwt(body.tickets[0].jwt).jti).toBe("open-1");
  });

  it("an all-protected order returns no tickets and the count", async () => {
    setupMocks("confirmed", {
      withTickets: true,
      tickets: MIXED.filter((t) => t.intake_id === "intake-bound"),
      intakes: INTAKES,
    });

    const body = await (await GET(makeRequest(), { params: { ref: "NM-2026-0001" } })).json();
    expect(body.tickets).toEqual([]);
    expect(body.account_ticket_count).toBe(2);
  });

  it("an unprotected order's response has no account_ticket_count, exactly as before", async () => {
    setupMocks("confirmed", {
      withTickets: true,
      intakes: { data: [{ id: "intake-1", ticket_qr_format: "jwt", ticket_protection: false }], error: null },
    });

    const body = await (await GET(makeRequest(), { params: { ref: "NM-2026-0001" } })).json();
    expect(body.tickets).toHaveLength(2);
    expect(body).not.toHaveProperty("account_ticket_count");
  });

  it("reads ticket_protection with the QR format", async () => {
    const intakeSelect = vi.fn().mockReturnThis();
    setupMocks("confirmed", { withTickets: true, intakes: INTAKES, tickets: MIXED });
    const route = mockAdminFrom.getMockImplementation()!;
    mockAdminFrom.mockImplementation((table: string) =>
      table === "intakes" ? { select: intakeSelect, in: vi.fn().mockResolvedValue(INTAKES) } : route(table),
    );

    await GET(makeRequest(), { params: { ref: "NM-2026-0001" } });
    expect(intakeSelect).toHaveBeenCalledWith(expect.stringContaining("ticket_protection"));
  });
});
