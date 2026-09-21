import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { generateKeyPairSync } from "crypto";

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
const { signTicketJwt } = await import("@/lib/tickets/sign");

// ─── Real Ed25519 keys ────────────────────────────────────────────────────────
// Signature verification is the security control under test, so these tests use
// real crypto and the real signer. Mocking the verifier would only assert that
// the mock was called.

function installSigningKey(kid = "test-kid-1") {
  const { privateKey } = generateKeyPairSync("ed25519");
  process.env.TICKET_SIGNING_KEY = privateKey
    .export({ type: "pkcs8", format: "der" })
    .toString("base64");
  process.env.TICKET_KID = kid;
}

/** A token for `claims`, signed by a key the server does NOT hold. */
function forgedToken(claims: Parameters<typeof signTicketJwt>[0]) {
  const realKey = process.env.TICKET_SIGNING_KEY;
  const realKid = process.env.TICKET_KID;
  installSigningKey("attacker-kid");
  const token = signTicketJwt(claims);
  process.env.TICKET_SIGNING_KEY = realKey;
  process.env.TICKET_KID = realKid;
  return token;
}

const CLAIMS = { jti: "t1", eid: "intake-A", tier: "GA", admits: 1, exp: 4070908800 };

/** A properly signed token naming this ticket and event. */
const tokenFor = (jti: string, eid: string) =>
  signTicketJwt({ jti, eid, tier: "GA", admits: 1, exp: 4070908800 });

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
  const savedKey = process.env.TICKET_SIGNING_KEY;
  const savedKid = process.env.TICKET_KID;

  beforeEach(() => {
    vi.clearAllMocks();
    installSigningKey();
  });

  afterEach(() => {
    process.env.TICKET_SIGNING_KEY = savedKey;
    process.env.TICKET_KID = savedKid;
  });

  it("returns 401 when resolveScannerTenant returns null (missing/invalid key)", async () => {
    mockResolveScannerTenant.mockResolvedValue(null);
    const res = await POST(makeRequest({ token: tokenFor("t1", "e1"), gate: "Gate-A" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "Unauthorized", message: "Invalid or missing API key." });
  });

  it("returns 404 when the ticket is not found", async () => {
    mockResolveScannerTenant.mockResolvedValue("tenant-1");
    setupTicketMock({ load: null });

    const res = await POST(makeRequest({ token: tokenFor("t1", "e1"), gate: "Gate-A" }));
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

    const res = await POST(makeRequest({ token: tokenFor("t1", "intake-B"), gate: "Gate-A" }));
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

    const res = await POST(makeRequest({ token: tokenFor("t1", "intake-A"), gate: "Gate-A" }));
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

    const res = await POST(makeRequest({ token: tokenFor("t1", "intake-A"), gate: "Gate-A" }));
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

    const res = await POST(makeRequest({ token: tokenFor("t1", "intake-A"), gate: "Gate-A" }));
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

    const res = await POST(makeRequest({ token: tokenFor("t1", "intake-A"), gate: "Gate-A" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ firstScanTime, firstScanGate: "Gate-B" });
  });
});

// ─── Signature verification ───────────────────────────────────────────────────
// The server previously trusted `jti` outright: anyone holding or guessing a
// ticket id could burn an admission by calling this endpoint directly. The
// token's signature is now the admission credential.

describe("POST /api/scans — token signature", () => {
  const savedKey = process.env.TICKET_SIGNING_KEY;
  const savedKid = process.env.TICKET_KID;

  beforeEach(() => {
    vi.clearAllMocks();
    installSigningKey();
    mockResolveScannerTenant.mockResolvedValue("tenant-1");
  });

  afterEach(() => {
    process.env.TICKET_SIGNING_KEY = savedKey;
    process.env.TICKET_KID = savedKid;
  });

  const validLoad = {
    id: "t1",
    intake_id: "intake-A",
    status: "valid",
    exp: FUTURE_EXP,
    first_scan_at: null,
    first_scan_gate: null,
  };

  it("returns 400 when no token is supplied", async () => {
    setupTicketMock({ load: validLoad });
    // The old contract — jti/eid with no token — is no longer an admission.
    const res = await POST(makeRequest({ jti: "t1", eid: "intake-A", gate: "Gate-A" }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when the token was signed by a key the server does not hold", async () => {
    setupTicketMock({ load: validLoad, claimed: [{ first_scan_at: "x", first_scan_gate: "Gate-A" }] });
    const res = await POST(makeRequest({ token: forgedToken(CLAIMS), gate: "Gate-A" }));
    expect(res.status).toBe(404);
  });

  it("returns 404 when the scanned payload is not a ticket token at all", async () => {
    setupTicketMock({ load: validLoad });
    // e.g. an operator scanned a payment QR by mistake
    const res = await POST(makeRequest({ token: "00020101021130560014", gate: "Gate-A" }));
    expect(res.status).toBe(404);
  });

  it("never reaches the database when the signature fails", async () => {
    setupTicketMock({ load: validLoad });
    // jti/eid are supplied deliberately: without them the request would be
    // rejected at body validation and never reach a query anyway, so the
    // assertion would hold for the wrong reason.
    await POST(
      makeRequest({ token: forgedToken(CLAIMS), jti: "t1", eid: "intake-A", gate: "Gate-A" }),
    );
    // A forged token must not even probe for ticket existence.
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });

  it("returns 400 when the body contradicts the token's claims", async () => {
    setupTicketMock({ load: validLoad });
    const token = signTicketJwt(CLAIMS);
    const res = await POST(makeRequest({ token, jti: "someone-elses-ticket", eid: "intake-A", gate: "Gate-A" }));
    expect(res.status).toBe(400);
  });

  it("returns 500, not 404, when the signing key is not configured", async () => {
    // A misconfigured server must not report every attendee as an invalid ticket.
    delete process.env.TICKET_SIGNING_KEY;
    setupTicketMock({ load: validLoad });
    const res = await POST(makeRequest({ token: "a.b.c", gate: "Gate-A" }));
    expect(res.status).toBe(500);
  });

  it("admits on a valid token carrying only token and gate", async () => {
    const { updateSpy } = setupTicketMock({
      load: validLoad,
      claimed: [{ first_scan_at: "2026-09-10T10:00:00.000Z", first_scan_gate: "Gate-A" }],
    });
    const res = await POST(makeRequest({ token: signTicketJwt(CLAIMS), gate: "Gate-A" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ first_scan_gate: "Gate-A" }));
  });
});
