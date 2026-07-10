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

const { POST } = await import("@/app/api/scans/route");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(body: unknown, authHeader = "Bearer validkey") {
  return new NextRequest("http://localhost/api/scans", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      authorization: authHeader,
      "content-type": "application/json",
    },
  });
}

interface TicketLoadRow {
  id: string;
  intake_id: string;
  status: string;
  exp: string;
  first_scan_at: string | null;
  first_scan_gate: string | null;
}

interface ClaimRow {
  first_scan_at: string;
  first_scan_gate: string | null;
}

// Sets up the by-table mock for the `tickets` table across the route's
// possible sequential calls:
//   1st `.select()` call  -> ticket load
//   2nd `.select()` call  -> re-read after a failed claim (409 path)
//   `.update()` call      -> the race-safe conditional claim
function setupTicketMock(opts: {
  load: TicketLoadRow | null;
  claimed?: ClaimRow[];
  reread?: { first_scan_at: string; first_scan_gate: string | null } | null;
}) {
  let selectCalls = 0;
  const updateSpy = vi.fn();
  const updateEqSpy = vi.fn();
  const updateIsSpy = vi.fn();

  mockAdminFrom.mockImplementation((table: string) => {
    if (table !== "tickets") throw new Error(`Unexpected table: ${table}`);
    return {
      select: vi.fn().mockImplementation(() => {
        selectCalls += 1;
        const isFirstCall = selectCalls === 1;
        const chain: { eq: ReturnType<typeof vi.fn>; single: ReturnType<typeof vi.fn> } = {
          eq: vi.fn(),
          single: vi.fn(),
        };
        chain.eq.mockReturnValue(chain);
        chain.single.mockResolvedValue({
          data: isFirstCall ? opts.load : (opts.reread ?? null),
          error: null,
        });
        return chain;
      }),
      update: vi.fn().mockImplementation((payload: unknown) => {
        updateSpy(payload);
        const chain: {
          eq: ReturnType<typeof vi.fn>;
          is: ReturnType<typeof vi.fn>;
          select: ReturnType<typeof vi.fn>;
        } = {
          eq: vi.fn(),
          is: vi.fn(),
          select: vi.fn(),
        };
        chain.eq.mockImplementation((...args: unknown[]) => {
          updateEqSpy(...args);
          return chain;
        });
        chain.is.mockImplementation((...args: unknown[]) => {
          updateIsSpy(...args);
          return chain;
        });
        chain.select.mockResolvedValue({ data: opts.claimed ?? [], error: null });
        return chain;
      }),
    };
  });

  return { updateSpy, updateEqSpy, updateIsSpy };
}

const FUTURE_EXP = "2099-01-01T00:00:00.000Z";
const PAST_EXP = "2020-01-01T00:00:00.000Z";

describe("POST /api/scans", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when resolveScannerTenant returns null (missing/invalid key)", async () => {
    mockResolveScannerTenant.mockResolvedValue(null);
    const res = await POST(makeRequest({ jti: "t1", eid: "e1", gate: "Gate-A" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "Unauthorized", message: "Invalid or missing API key." });
  });

  it("returns 404 when the ticket is not found", async () => {
    mockResolveScannerTenant.mockResolvedValue("tenant-1");
    setupTicketMock({ load: null });

    const res = await POST(makeRequest({ jti: "t1", eid: "e1", gate: "Gate-A" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "Not Found", message: "Ticket not found." });
  });

  it("returns 404 when eid does not match ticket.intake_id", async () => {
    mockResolveScannerTenant.mockResolvedValue("tenant-1");
    setupTicketMock({
      load: {
        id: "t1",
        intake_id: "intake-A",
        status: "valid",
        exp: FUTURE_EXP,
        first_scan_at: null,
        first_scan_gate: null,
      },
    });

    const res = await POST(makeRequest({ jti: "t1", eid: "intake-B", gate: "Gate-A" }));
    expect(res.status).toBe(404);
  });

  it("returns 404 when ticket status is void", async () => {
    mockResolveScannerTenant.mockResolvedValue("tenant-1");
    setupTicketMock({
      load: {
        id: "t1",
        intake_id: "intake-A",
        status: "void",
        exp: FUTURE_EXP,
        first_scan_at: null,
        first_scan_gate: null,
      },
    });

    const res = await POST(makeRequest({ jti: "t1", eid: "intake-A", gate: "Gate-A" }));
    expect(res.status).toBe(404);
  });

  it("returns 404 when the ticket is expired", async () => {
    mockResolveScannerTenant.mockResolvedValue("tenant-1");
    setupTicketMock({
      load: {
        id: "t1",
        intake_id: "intake-A",
        status: "valid",
        exp: PAST_EXP,
        first_scan_at: null,
        first_scan_gate: null,
      },
    });

    const res = await POST(makeRequest({ jti: "t1", eid: "intake-A", gate: "Gate-A" }));
    expect(res.status).toBe(404);
  });

  it("returns 200 on first scan and claims via a race-safe conditional update", async () => {
    mockResolveScannerTenant.mockResolvedValue("tenant-1");
    const claimedAt = "2026-07-10T10:00:00.000Z";
    const { updateSpy, updateIsSpy } = setupTicketMock({
      load: {
        id: "t1",
        intake_id: "intake-A",
        status: "valid",
        exp: FUTURE_EXP,
        first_scan_at: null,
        first_scan_gate: null,
      },
      claimed: [{ first_scan_at: claimedAt, first_scan_gate: "Gate-A" }],
    });

    const res = await POST(makeRequest({ jti: "t1", eid: "intake-A", gate: "Gate-A" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    // The conditional update must only claim tickets that haven't been scanned yet.
    expect(updateIsSpy).toHaveBeenCalledWith("first_scan_at", null);
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ first_scan_gate: "Gate-A" }));
  });

  it("returns 409 with the original scan info when already scanned", async () => {
    mockResolveScannerTenant.mockResolvedValue("tenant-1");
    const firstScanTime = "2026-07-10T09:00:00.000Z";
    setupTicketMock({
      load: {
        id: "t1",
        intake_id: "intake-A",
        status: "valid",
        exp: FUTURE_EXP,
        first_scan_at: firstScanTime,
        first_scan_gate: "Gate-B",
      },
      claimed: [],
      reread: { first_scan_at: firstScanTime, first_scan_gate: "Gate-B" },
    });

    const res = await POST(makeRequest({ jti: "t1", eid: "intake-A", gate: "Gate-A" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ firstScanTime, firstScanGate: "Gate-B" });
  });
});
