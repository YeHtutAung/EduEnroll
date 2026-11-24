import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from "crypto";

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
const { signTicketJwt, signBoundTicket } = await import("@/lib/tickets/sign");
const { k2SignedText } = await import("@/lib/tickets/k2Text");

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
  holder_buyer_id?: string | null;
  classes?: { event_date: string | null; end_time: string | null } | null;
  intakes?: { ticket_protection: boolean } | null;
  enrollments?: { buyer_id: string | null } | null;
}

interface DeviceRow {
  public_key: string;
  buyer_id: string | null;
}

// Sets up the by-table mock for the `tickets` table across the route's
// possible sequential calls:
//   1st `.select()` call  -> ticket load
//   2nd `.select()` call  -> re-read after a failed claim (409 path)
//   `.update()` call      -> the race-safe conditional claim
function setupTicketMock(opts: {
  load: TicketLoadRow | null;
  loadError?: { code: string; message: string } | null;
  claimed?: unknown[];
  claimError?: { code: string; message: string } | null;
  reread?: Record<string, string | null> | null;
  device?: DeviceRow | null;
  deviceError?: { code: string; message: string } | null;
}) {
  let selectCalls = 0;
  // The route now embeds the intake's protection flag and the order's buyer.
  // A row that doesn't say otherwise is an unprotected ticket, as every ticket
  // was before account-bound tickets existed.
  const load =
    opts.load && !("intakes" in opts.load)
      ? { intakes: { ticket_protection: false }, enrollments: { buyer_id: null }, ...opts.load }
      : opts.load;
  const updateSpy = vi.fn();
  const updateEqSpy = vi.fn();
  const updateIsSpy = vi.fn();
  const updateOrSpy = vi.fn();
  const ticketSelectSpy = vi.fn();
  const deviceSelectSpy = vi.fn();
  const deviceEqSpy = vi.fn();
  const deviceIsSpy = vi.fn();

  mockAdminFrom.mockImplementation((table: string) => {
    if (table === "ticket_devices") {
      const chain: {
        select: ReturnType<typeof vi.fn>;
        eq: ReturnType<typeof vi.fn>;
        is: ReturnType<typeof vi.fn>;
        maybeSingle: ReturnType<typeof vi.fn>;
      } = { select: vi.fn(), eq: vi.fn(), is: vi.fn(), maybeSingle: vi.fn() };
      chain.select.mockImplementation((...args: unknown[]) => {
        deviceSelectSpy(...args);
        return chain;
      });
      chain.eq.mockImplementation((...args: unknown[]) => {
        deviceEqSpy(...args);
        return chain;
      });
      chain.is.mockImplementation((...args: unknown[]) => {
        deviceIsSpy(...args);
        return chain;
      });
      chain.maybeSingle.mockResolvedValue({
        data: opts.deviceError ? null : (opts.device ?? null),
        error: opts.deviceError ?? null,
      });
      return chain;
    }
    if (table !== "tickets") throw new Error(`Unexpected table: ${table}`);
    return {
      select: vi.fn().mockImplementation((...args: unknown[]) => {
        ticketSelectSpy(...args);
        selectCalls += 1;
        const isFirstCall = selectCalls === 1;
        const chain: { eq: ReturnType<typeof vi.fn>; single: ReturnType<typeof vi.fn> } = {
          eq: vi.fn(),
          single: vi.fn(),
        };
        chain.eq.mockReturnValue(chain);
        chain.single.mockResolvedValue({
          data: isFirstCall ? load : (opts.reread ?? null),
          error: isFirstCall ? (opts.loadError ?? null) : null,
        });
        return chain;
      }),
      update: vi.fn().mockImplementation((payload: unknown) => {
        updateSpy(payload);
        const chain: {
          eq: ReturnType<typeof vi.fn>;
          is: ReturnType<typeof vi.fn>;
          or: ReturnType<typeof vi.fn>;
          select: ReturnType<typeof vi.fn>;
        } = {
          eq: vi.fn(),
          is: vi.fn(),
          or: vi.fn(),
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
        chain.or.mockImplementation((...args: unknown[]) => {
          updateOrSpy(...args);
          return chain;
        });
        chain.select.mockResolvedValue({
          data: opts.claimError ? null : (opts.claimed ?? []),
          error: opts.claimError ?? null,
        });
        return chain;
      }),
    };
  });

  return {
    updateSpy,
    updateEqSpy,
    updateIsSpy,
    updateOrSpy,
    ticketSelectSpy,
    deviceSelectSpy,
    deviceEqSpy,
    deviceIsSpy,
  };
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

// ─── Once per day on multi-day tickets ────────────────────────────────────────

describe("POST /api/scans — entry per day", () => {
  const savedKey = process.env.TICKET_SIGNING_KEY;
  const savedKid = process.env.TICKET_KID;

  beforeEach(() => {
    vi.clearAllMocks();
    installSigningKey();
    mockResolveScannerTenant.mockResolvedValue("tenant-1");
    vi.spyOn(console, "error").mockImplementation(() => {});
    // 22 Nov 2026, 12:00 in Yangon.
    vi.useFakeTimers({ now: new Date("2026-11-22T05:30:00.000Z"), toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.TICKET_SIGNING_KEY = savedKey;
    process.env.TICKET_KID = savedKid;
  });

  const load = (overrides: Partial<TicketLoadRow> = {}): TicketLoadRow => ({
    id: "t1",
    intake_id: "intake-A",
    status: "valid",
    exp: FUTURE_EXP,
    first_scan_at: null,
    first_scan_gate: null,
    classes: { event_date: "2026-11-21", end_time: "2026-11-24" },
    ...overrides,
  });
  const scan = () => POST(makeRequest({ token: tokenFor("t1", "intake-A"), gate: "Gate-A" }));
  const notScannedToday = "last_scan_date.is.null,last_scan_date.lt.2026-11-22";

  it("admits a pass's first scan and records it as both the first and today's", async () => {
    const { updateSpy, updateOrSpy, updateIsSpy } = setupTicketMock({
      load: load(),
      claimed: [{ id: "t1" }],
    });

    const res = await scan();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(updateOrSpy).toHaveBeenCalledWith(notScannedToday);
    expect(updateIsSpy).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledWith({
      first_scan_at: "2026-11-22T05:30:00.000Z",
      first_scan_gate: "Gate-A",
      last_scan_date: "2026-11-22",
      last_scan_at: "2026-11-22T05:30:00.000Z",
      last_scan_gate: "Gate-A",
    });
  });

  it("admits the pass again on a later day and keeps the first scan as it was", async () => {
    const { updateSpy, updateOrSpy } = setupTicketMock({
      load: load({ first_scan_at: "2026-11-21T11:00:00.000Z", first_scan_gate: "Gate-B" }),
      claimed: [{ id: "t1" }],
    });

    const res = await scan();

    expect(res.status).toBe(200);
    expect(updateOrSpy).toHaveBeenCalledWith(notScannedToday);
    expect(updateSpy).toHaveBeenCalledWith({
      last_scan_date: "2026-11-22",
      last_scan_at: "2026-11-22T05:30:00.000Z",
      last_scan_gate: "Gate-A",
    });
  });

  it("refuses a second scan on the same day and reports today's scan, not the first", async () => {
    setupTicketMock({
      load: load({ first_scan_at: "2026-11-21T11:00:00.000Z", first_scan_gate: "Gate-B" }),
      claimed: [],
      reread: { last_scan_at: "2026-11-22T04:00:00.000Z", last_scan_gate: "Gate-C" },
    });

    const res = await scan();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      firstScanTime: "2026-11-22T04:00:00.000Z",
      firstScanGate: "Gate-C",
    });
  });

  it.each([
    ["ends on its start date", { event_date: "2026-11-22", end_time: "2026-11-22" }],
    ["has no end date", { event_date: "2026-11-22", end_time: null }],
    ["has an end before its start", { event_date: "2026-11-22", end_time: "2026-11-20" }],
  ])("keeps a ticket single-use when its event %s", async (_label, classes) => {
    const { updateSpy, updateIsSpy, updateOrSpy } = setupTicketMock({
      load: load({ classes }),
      claimed: [{ first_scan_at: "x", first_scan_gate: "Gate-A" }],
    });

    await scan();

    expect(updateIsSpy).toHaveBeenCalledWith("first_scan_at", null);
    expect(updateOrSpy).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledWith({
      first_scan_at: "2026-11-22T05:30:00.000Z",
      first_scan_gate: "Gate-A",
    });
  });

  it("still refuses a voided multi-day pass", async () => {
    const { updateSpy } = setupTicketMock({ load: load({ status: "void" }) });
    const res = await scan();
    expect(res.status).toBe(404);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  // A database fault must not read as a bad or used ticket: both tell the
  // operator to turn the attendee away.
  it("returns 500, not 404, when the ticket cannot be read", async () => {
    setupTicketMock({ load: null, loadError: { code: "42703", message: "column does not exist" } });
    const res = await scan();
    expect(res.status).toBe(500);
  });

  it("returns 404 when the ticket truly does not exist", async () => {
    setupTicketMock({ load: null, loadError: { code: "PGRST116", message: "0 rows" } });
    const res = await scan();
    expect(res.status).toBe(404);
  });

  it("returns 500, not 409, when the scan cannot be recorded", async () => {
    setupTicketMock({ load: load(), claimError: { code: "42703", message: "column does not exist" } });
    const res = await scan();
    expect(res.status).toBe(500);
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

// ─── Account-bound (protected) tickets ────────────────────────────────────────
// Design section 7. A protected ticket is admitted only by a live k2 QR signed
// by the phone that is the ticket's active device for the order's buyer.

describe("POST /api/scans — protected tickets", () => {
  const savedKey = process.env.TICKET_SIGNING_KEY;
  const savedKid = process.env.TICKET_KID;
  const NOW_MS = Date.parse("2026-11-22T05:30:00.000Z");
  const NOW_S = Math.floor(NOW_MS / 1000);
  const BUYER = "buyer-1";

  /** A phone: a P-256 key pair and its public half as the 65-byte raw point, base64url. */
  function phone() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const raw = Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(jwk.x, "base64url"),
      Buffer.from(jwk.y, "base64url"),
    ]);
    return { privateKey, dk: raw.toString("base64url") };
  }

  function k2For(p: { privateKey: KeyObject; dk: string }, ts = NOW_S, jti = "t1", eid = "intake-A") {
    const bound = signBoundTicket({ jti, eid, tier: "GA", admits: 1, exp: 4070908800 }, p.dk);
    const sig = nodeSign("sha256", Buffer.from(k2SignedText(jti, String(ts)), "utf8"), {
      key: p.privateKey,
      dsaEncoding: "ieee-p1363",
    });
    return `k2.${bound}.${ts}.${sig.toString("base64url")}`;
  }

  const load = (overrides: Partial<TicketLoadRow> = {}): TicketLoadRow => ({
    id: "t1",
    intake_id: "intake-A",
    status: "valid",
    exp: FUTURE_EXP,
    first_scan_at: null,
    first_scan_gate: null,
    classes: { event_date: "2026-11-22", end_time: null },
    intakes: { ticket_protection: true },
    enrollments: { buyer_id: BUYER },
    ...overrides,
  });
  const scan = (token: string) => POST(makeRequest({ token, gate: "Gate-A" }));
  const CLAIMED = [{ first_scan_at: "2026-11-22T05:30:00.000Z", first_scan_gate: "Gate-A" }];

  let bound: ReturnType<typeof phone>;

  beforeEach(() => {
    vi.clearAllMocks();
    installSigningKey();
    mockResolveScannerTenant.mockResolvedValue("tenant-1");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers({ now: new Date(NOW_MS), toFake: ["Date"] });
    bound = phone();
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.TICKET_SIGNING_KEY = savedKey;
    process.env.TICKET_KID = savedKid;
  });

  it("admits a live QR from the active phone of the order's buyer, then answers 409 to the same QR", async () => {
    const qr = k2For(bound);
    const { updateSpy } = setupTicketMock({
      load: load(),
      device: { public_key: bound.dk, buyer_id: BUYER },
      claimed: CLAIMED,
    });
    const first = await scan(qr);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ first_scan_gate: "Gate-A" }));

    setupTicketMock({
      load: load({ first_scan_at: "2026-11-22T05:30:00.000Z", first_scan_gate: "Gate-A" }),
      device: { public_key: bound.dk, buyer_id: BUYER },
      claimed: [],
      reread: { first_scan_at: "2026-11-22T05:30:00.000Z", first_scan_gate: "Gate-A" },
    });
    const second = await scan(qr);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      firstScanTime: "2026-11-22T05:30:00.000Z",
      firstScanGate: "Gate-A",
    });
  });

  it("loads the protection embeds and reads only the ticket's active, unrevoked phone", async () => {
    const { ticketSelectSpy, deviceSelectSpy, deviceEqSpy, deviceIsSpy } = setupTicketMock({
      load: load(),
      device: { public_key: bound.dk, buyer_id: BUYER },
      claimed: CLAIMED,
    });
    const res = await scan(k2For(bound));
    expect(res.status).toBe(200);
    // Without these embeds every real scan would be a 500 (the mock fills them in).
    const sel = String(ticketSelectSpy.mock.calls[0]?.[0] ?? "");
    expect(sel).toContain("intakes(ticket_protection)");
    expect(sel).toContain("enrollments(buyer_id)");
    // A revoked phone (deletion, rebind) must never be the row compared.
    expect(deviceSelectSpy).toHaveBeenCalledWith("public_key, buyer_id");
    expect(deviceEqSpy).toHaveBeenCalledWith("ticket_id", "t1");
    expect(deviceIsSpy).toHaveBeenCalledWith("revoked_at", null);
  });

  it("refuses a plain token for a protected ticket", async () => {
    const { updateSpy } = setupTicketMock({
      load: load(),
      device: { public_key: bound.dk, buyer_id: BUYER },
      claimed: CLAIMED,
    });
    const res = await scan(tokenFor("t1", "intake-A"));
    expect(res.status).toBe(404);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("refuses a k2 QR for a ticket on an unprotected intake", async () => {
    const { updateSpy } = setupTicketMock({
      load: load({ intakes: { ticket_protection: false } }),
      device: { public_key: bound.dk, buyer_id: BUYER },
      claimed: CLAIMED,
    });
    const res = await scan(k2For(bound));
    expect(res.status).toBe(404);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("refuses a bare bound token outside its envelope, before any query", async () => {
    setupTicketMock({
      load: load(),
      device: { public_key: bound.dk, buyer_id: BUYER },
      claimed: CLAIMED,
    });
    const bare = signBoundTicket({ jti: "t1", eid: "intake-A", tier: "GA", admits: 1, exp: 4070908800 }, bound.dk);
    const res = await scan(bare);
    expect(res.status).toBe(404);
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });

  it("refuses a QR from a phone that is not the active one (a revoked phone)", async () => {
    const revoked = phone();
    const { updateSpy } = setupTicketMock({
      load: load(),
      device: { public_key: bound.dk, buyer_id: BUYER },
      claimed: CLAIMED,
    });
    const res = await scan(k2For(revoked));
    expect(res.status).toBe(404);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("refuses when the ticket has no active phone", async () => {
    const { updateSpy } = setupTicketMock({ load: load(), device: null, claimed: CLAIMED });
    const res = await scan(k2For(bound));
    expect(res.status).toBe(404);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("refuses when the active phone belongs to someone other than the order's buyer", async () => {
    const { updateSpy } = setupTicketMock({
      load: load(),
      device: { public_key: bound.dk, buyer_id: "buyer-2" },
      claimed: CLAIMED,
    });
    const res = await scan(k2For(bound));
    expect(res.status).toBe(404);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  // Two missing buyers are not the same buyer.
  it("refuses when both the order's buyer and the phone's buyer are null", async () => {
    const { updateSpy } = setupTicketMock({
      load: load({ enrollments: { buyer_id: null } }),
      device: { public_key: bound.dk, buyer_id: null },
      claimed: CLAIMED,
    });
    const res = await scan(k2For(bound));
    expect(res.status).toBe(404);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("refuses when the order embed is missing and the phone has no buyer", async () => {
    const { updateSpy } = setupTicketMock({
      load: load({ enrollments: null }),
      device: { public_key: bound.dk, buyer_id: null },
      claimed: CLAIMED,
    });
    const res = await scan(k2For(bound));
    expect(res.status).toBe(404);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  // ── Seat sharing: the phone must be the current holder's (design 7 step 5) ──
  const FRIEND = "friend-1";

  it("asks for the seat's holder alongside the order's buyer", async () => {
    const { ticketSelectSpy } = setupTicketMock({
      load: load(),
      device: { public_key: bound.dk, buyer_id: BUYER },
      claimed: CLAIMED,
    });
    await scan(k2For(bound));
    const sel = String(ticketSelectSpy.mock.calls[0]?.[0] ?? "");
    expect(sel).toContain("holder_buyer_id");
  });

  it("admits a claimed seat from the active phone of the friend who holds it", async () => {
    const { updateSpy } = setupTicketMock({
      load: load({ holder_buyer_id: FRIEND }),
      device: { public_key: bound.dk, buyer_id: FRIEND },
      claimed: CLAIMED,
    });
    const res = await scan(k2For(bound));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(updateSpy).toHaveBeenCalled();
  });

  it("refuses a claimed seat when the active phone is the leader's", async () => {
    const { updateSpy } = setupTicketMock({
      load: load({ holder_buyer_id: FRIEND }),
      device: { public_key: bound.dk, buyer_id: BUYER },
      claimed: CLAIMED,
    });
    const res = await scan(k2For(bound));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not Found", message: "Ticket not found." });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("admits the leader's phone when nobody has claimed the seat", async () => {
    const { updateSpy } = setupTicketMock({
      load: load({ holder_buyer_id: null }),
      device: { public_key: bound.dk, buyer_id: BUYER },
      claimed: CLAIMED,
    });
    const res = await scan(k2For(bound));
    expect(res.status).toBe(200);
    expect(updateSpy).toHaveBeenCalled();
  });

  it("refuses a claimed seat when the friend's phone has no buyer, even with the order embed missing", async () => {
    const { updateSpy } = setupTicketMock({
      load: load({ holder_buyer_id: FRIEND, enrollments: null }),
      device: { public_key: bound.dk, buyer_id: null },
      claimed: CLAIMED,
    });
    const res = await scan(k2For(bound));
    expect(res.status).toBe(404);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("returns 500, not 404, when the phone cannot be read", async () => {
    const { updateSpy } = setupTicketMock({
      load: load(),
      deviceError: { code: "42501", message: "permission denied" },
      claimed: CLAIMED,
    });
    const res = await scan(k2For(bound));
    expect(res.status).toBe(500);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("returns 500, not 404, when the intake embed is missing", async () => {
    const { updateSpy } = setupTicketMock({
      load: load({ intakes: null }),
      device: { public_key: bound.dk, buyer_id: BUYER },
      claimed: CLAIMED,
    });
    const res = await scan(k2For(bound));
    expect(res.status).toBe(500);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("refuses a stale QR (60 s old) without touching the database", async () => {
    setupTicketMock({
      load: load(),
      device: { public_key: bound.dk, buyer_id: BUYER },
      claimed: CLAIMED,
    });
    const res = await scan(k2For(bound, NOW_S - 60));
    expect(res.status).toBe(404);
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });

  it("refuses a bare bound token for an unprotected ticket too (copied out of browser storage)", async () => {
    const { updateSpy } = setupTicketMock({
      load: load({ intakes: { ticket_protection: false }, enrollments: { buyer_id: null } }),
      claimed: CLAIMED,
    });
    const bare = signBoundTicket({ jti: "t1", eid: "intake-A", tier: "GA", admits: 1, exp: 4070908800 }, bound.dk);
    const res = await scan(bare);
    expect(res.status).toBe(404);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("takes expiry from the ticket row, not from the k2 claims", async () => {
    // The bound token says 2099; the database says the ticket has expired.
    const { updateSpy } = setupTicketMock({
      load: load({ exp: PAST_EXP }),
      device: { public_key: bound.dk, buyer_id: BUYER },
      claimed: CLAIMED,
    });
    const res = await scan(k2For(bound));
    expect(res.status).toBe(404);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("compares the phone key as an exact string", async () => {
    const { updateSpy } = setupTicketMock({
      load: load(),
      device: { public_key: `${bound.dk}=`, buyer_id: BUYER },
      claimed: CLAIMED,
    });
    const res = await scan(k2For(bound));
    expect(res.status).toBe(404);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("refuses a token over 4 KB before verifying it or touching the database", async () => {
    setupTicketMock({ load: load(), device: { public_key: bound.dk, buyer_id: BUYER }, claimed: CLAIMED });
    const res = await scan(`${k2For(bound)}${"A".repeat(4096)}`);
    expect(res.status).toBe(404);
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });

  it("checks the length before anything else: an over-long token is 404 even with no signing key", async () => {
    delete process.env.TICKET_SIGNING_KEY;
    setupTicketMock({ load: load() });
    const res = await scan("A".repeat(4097));
    expect(res.status).toBe(404);
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });

  it("accepts a token of exactly 4 KB as far as the length check", async () => {
    delete process.env.TICKET_SIGNING_KEY;
    setupTicketMock({ load: load() });
    // Past the cap check, the missing key is reported as before.
    const res = await scan("A".repeat(4096));
    expect(res.status).toBe(500);
  });

  it("still admits an unprotected ticket with a plain token, without reading phones", async () => {
    const { updateSpy } = setupTicketMock({
      load: load({ intakes: { ticket_protection: false }, enrollments: { buyer_id: null } }),
      claimed: CLAIMED,
    });
    const res = await scan(tokenFor("t1", "intake-A"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(updateSpy).toHaveBeenCalled();
    expect(mockAdminFrom).not.toHaveBeenCalledWith("ticket_devices");
  });
});
