import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── registerInterest: ordering and outcomes ────────────────────────────────
//
// Every case here is about ORDER or about what the caller is told — never
// about how the module talks to Supabase internally. The two invariants under
// test:
//
//   1. No token is emailed whose hash is not already stored (persist, then
//      send). A failed send costs a notification; a failed write costs an
//      error, never a false success.
//   2. The whole rotation decision happens under the row lock before any mail
//      goes out — so rotate_interest_token is called BEFORE sendEmail, not
//      alongside it.
//
// Both ordering assertions ("insert before send", "rotate before send") are
// the ones most at risk of passing vacuously, so each is written against a
// single recorded timeline rather than against two independent "was called"
// checks.

// ── A recorded timeline of side effects, in the order they happened ─────────
let timeline: string[];
let eqArgs: Array<[string, unknown]>;
let insertPayloads: Array<Record<string, unknown>>;
let updatePayloads: Array<Record<string, unknown>>;

// Per-test canned results.
let lookupResult: { data: unknown; error: { message: string } | null };
let insertResult: { data: unknown; error: { message: string } | null };
let rpcResults: Record<string, { data: unknown; error: { message: string } | null }>;

const mockRpc = vi.fn(async (fn: string) => {
  timeline.push(`rpc:${fn}`);
  return rpcResults[fn] ?? { data: null, error: { message: `no canned result for ${fn}` } };
});

const mockFrom = vi.fn((table: string) => {
  const chain: Record<string, unknown> = {};

  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn((col: string, val: unknown) => {
    eqArgs.push([col, val]);
    return chain;
  });
  chain.insert = vi.fn((payload: Record<string, unknown>) => {
    timeline.push(`insert:${table}`);
    insertPayloads.push(payload);
    return chain;
  });
  chain.update = vi.fn((payload: Record<string, unknown>) => {
    timeline.push(
      "last_link_attempt_at" in payload ? "clearAttempt" : "stampSent",
    );
    updatePayloads.push(payload);
    return chain;
  });
  chain.maybeSingle = vi.fn(async () => lookupResult);
  chain.single = vi.fn(async () => insertResult);
  // Terminal for `.update(...).eq(...)`, which is awaited without .single().
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });

  return chain;
});

const mockSendEmail = vi.fn(async () => {
  timeline.push("sendEmail");
  return sendEmailReturns;
});
let sendEmailReturns = true;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: mockRpc, from: mockFrom }),
}));

vi.mock("@/lib/email", () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...(args as [])),
  interestConfirmationEmail: () => ({ subject: "s", html: "<p>h</p>" }),
}));

const { registerInterest } = await import("@/server/interest/registerInterest");

const INTAKE = "11111111-1111-1111-1111-111111111111";
const TENANT = "22222222-2222-2222-2222-222222222222";
const ROW_ID = "33333333-3333-3333-3333-333333333333";

const input = (over: Partial<Parameters<typeof registerInterest>[0]> = {}) => ({
  intakeId: INTAKE,
  tenantId: TENANT,
  name: "Aung Aung",
  email: "person@example.com",
  phone: "0912345678",
  ipHash: "a".repeat(64),
  linkBase: "https://acme.kuunyi.com/enroll/summer-fest",
  eventName: "Summer Fest",
  windowOpensAt: "1 Sep 2026, 10:00",
  coveredTiers: ["General Admission"],
  ...over,
});

/** Index in the recorded timeline, or -1. */
const at = (event: string) => timeline.indexOf(event);

beforeEach(() => {
  vi.clearAllMocks();
  timeline = [];
  eqArgs = [];
  insertPayloads = [];
  updatePayloads = [];
  sendEmailReturns = true;
  lookupResult = { data: null, error: null };
  insertResult = { data: { id: ROW_ID }, error: null };
  rpcResults = {
    consume_interest_signup_slot: { data: true, error: null },
    rotate_interest_token: { data: "ROTATED", error: null },
  };
});

describe("registerInterest — first signup", () => {
  it("writes the row BEFORE sending the email", async () => {
    const result = await registerInterest(input());

    expect(result.ok).toBe(true);
    // Both must have happened, and the write must come first: a token whose
    // hash is not yet stored must never reach an inbox.
    expect(at("insert:event_interest")).toBeGreaterThanOrEqual(0);
    expect(at("sendEmail")).toBeGreaterThanOrEqual(0);
    expect(at("insert:event_interest")).toBeLessThan(at("sendEmail"));
  });

  it("returns the raw token and emailed:false when the send fails, keeping the row", async () => {
    sendEmailReturns = false;

    const result = await registerInterest(input());

    expect(result).toMatchObject({ ok: true, emailed: false });
    if (result.ok) expect(typeof result.token).toBe("string");
    // The row was written and is not rolled back — the on-screen link works.
    expect(at("insert:event_interest")).toBeGreaterThanOrEqual(0);
    // A failed send must not be stamped as sent.
    expect(at("stampSent")).toBe(-1);
  });

  it("never sends and never reports success when the insert fails", async () => {
    insertResult = { data: null, error: { message: "duplicate key" } };

    const result = await registerInterest(input());

    expect(result).toEqual({ ok: false, reason: "WRITE_FAILED" });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("normalises the email for both the lookup and the stored row", async () => {
    await registerInterest(input({ email: "  Foo@Example.COM " }));

    expect(eqArgs).toContainEqual(["email", "foo@example.com"]);
    expect(insertPayloads[0]).toMatchObject({ email: "foo@example.com" });
  });
});

describe("registerInterest — repeat signup", () => {
  beforeEach(() => {
    lookupResult = { data: { id: ROW_ID }, error: null };
  });

  it("returns no raw token", async () => {
    const result = await registerInterest(input());

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty("token");
  });

  it("rotates under the lock BEFORE sending the email", async () => {
    await registerInterest(input());

    expect(at("rpc:rotate_interest_token")).toBeGreaterThanOrEqual(0);
    expect(at("sendEmail")).toBeGreaterThanOrEqual(0);
    expect(at("rpc:rotate_interest_token")).toBeLessThan(at("sendEmail"));
  });

  it("sends nothing and reports generic success inside the cooldown", async () => {
    rpcResults.rotate_interest_token = { data: "COOLDOWN", error: null };

    const result = await registerInterest(input());

    expect(result).toEqual({ ok: true, emailed: false });
    expect(mockSendEmail).not.toHaveBeenCalled();
    // Nothing was written: no stamp, no clear, no insert.
    expect(updatePayloads).toEqual([]);
    expect(insertPayloads).toEqual([]);
  });

  it("clears last_link_attempt_at when the send fails, so a retry is immediate", async () => {
    sendEmailReturns = false;

    const result = await registerInterest(input());

    expect(result).toEqual({ ok: true, emailed: false });
    expect(updatePayloads).toContainEqual({ last_link_attempt_at: null });
    expect(at("clearAttempt")).toBeGreaterThan(at("sendEmail"));
  });
});

describe("registerInterest — rate limit", () => {
  it("reports the same generic success and writes and sends nothing", async () => {
    rpcResults.consume_interest_signup_slot = { data: false, error: null };

    const result = await registerInterest(input());

    // Identical to what a permitted resend returns — nothing here tells a
    // script it has been throttled.
    expect(result).toEqual({ ok: true, emailed: false });
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
    expect(timeline).toEqual(["rpc:consume_interest_signup_slot"]);
  });
});
