import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── registerInterest: ordering and outcomes ────────────────────────────────
//
// Every case here is about ORDER or about what the caller is told — never
// about how the module talks to Supabase internally. The two invariants under
// test:
//
//   1. No token is emailed whose hash is not already stored (persist, then
//      send), and a rotation whose send failed is rolled back rather than
//      left half-applied.
//   2. The whole rotation decision happens under the row lock before any mail
//      goes out — so rotate_interest_token completes BEFORE sendEmail starts.
//
// The timeline below records COMPLETION, not initiation: entries are pushed
// from the awaited terminal of each call, never from the builder method that
// merely queues it. Recording at call time would let an implementation that
// issues the write, sends the mail, and only then awaits the write produce the
// same order and pass — which is exactly the bug these two tests exist to
// catch.

let timeline: string[];
let eqArgs: Array<[string, unknown]>;
let insertPayloads: Array<Record<string, unknown>>;
let updatePayloads: Array<Record<string, unknown>>;
let rpcArgs: Array<[string, Record<string, unknown>]>;

type Canned = { data: unknown; error: ({ message: string } & { code?: string }) | null };

// A queue: successive lookups shift, and the last entry repeats. Only the
// unique-violation case needs more than one.
let lookupResults: Canned[];
let insertResult: Canned;
let rpcResults: Record<string, Canned>;
let sendEmailReturns: boolean;

const mockRpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
  rpcArgs.push([fn, args]);
  // Resolve a microtask first, so the entry lands when the RPC *completes*.
  await Promise.resolve();
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
    insertPayloads.push(payload);
    return chain;
  });
  chain.update = vi.fn((payload: Record<string, unknown>) => {
    updatePayloads.push(payload);
    // .update(...).eq(...) is awaited without a terminal method, so this is
    // the last chance to record it. It is not an ordering assertion subject.
    timeline.push("stampSent");
    return chain;
  });
  chain.maybeSingle = vi.fn(async () =>
    lookupResults.length > 1 ? lookupResults.shift()! : lookupResults[0],
  );
  chain.single = vi.fn(async () => {
    // Resolve a microtask first, so the entry lands when the insert
    // *completes*. Without this the push happens synchronously inside the
    // builder call, which is initiation again wearing an async signature.
    await Promise.resolve();
    timeline.push(`insert:${table}`);
    return insertResult;
  });
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });

  return chain;
});

const mockSendEmail = vi.fn(async () => {
  timeline.push("sendEmail");
  return sendEmailReturns;
});

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
const PREFIX = "OLDPREFX";

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

/** The existing row a repeat signup finds. */
const existingRow = (over: Record<string, unknown> = {}) => ({
  data: { id: ROW_ID, token_prefix: PREFIX, revoked_at: null, ...over },
  error: null,
});

/** Index in the recorded timeline, or -1. */
const at = (event: string) => timeline.indexOf(event);

const rpcCall = (fn: string) => rpcArgs.find(([name]) => name === fn)?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  timeline = [];
  eqArgs = [];
  insertPayloads = [];
  updatePayloads = [];
  rpcArgs = [];
  sendEmailReturns = true;
  lookupResults = [{ data: null, error: null }];
  insertResult = { data: { id: ROW_ID }, error: null };
  rpcResults = {
    consume_interest_signup_slot: { data: true, error: null },
    rotate_interest_token: { data: "ROTATED", error: null },
    rollback_interest_rotation: { data: true, error: null },
  };
});

describe("registerInterest — first signup", () => {
  it("writes the row BEFORE sending the email", async () => {
    const result = await registerInterest(input());

    expect(result.ok).toBe(true);
    expect(at("insert:event_interest")).toBeGreaterThanOrEqual(0);
    expect(at("sendEmail")).toBeGreaterThanOrEqual(0);
    expect(at("insert:event_interest")).toBeLessThan(at("sendEmail"));
  });

  it("returns the raw token and emailed:false when the send fails, keeping the row", async () => {
    sendEmailReturns = false;

    const result = await registerInterest(input());

    expect(result).toMatchObject({ ok: true, emailed: false });
    if (result.ok) expect(typeof result.token).toBe("string");
    expect(at("insert:event_interest")).toBeGreaterThanOrEqual(0);
    expect(at("stampSent")).toBe(-1);
  });

  it("never sends and never reports success when the insert fails", async () => {
    insertResult = { data: null, error: { message: "boom" } };

    const result = await registerInterest(input());

    expect(result).toEqual({ ok: false, reason: "WRITE_FAILED" });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("stamps last_link_attempt_at on the insert", async () => {
    await registerInterest(input());

    // The first send is an attempt like any other. Left null, the cooldown
    // would read null on a brand-new row and the very next resend would rotate
    // and send again for free.
    const stamped = insertPayloads[0].last_link_attempt_at;
    expect(typeof stamped).toBe("string");
    expect(Date.parse(stamped as string)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("normalises the email for both the lookup and the stored row", async () => {
    await registerInterest(input({ email: "  Foo@Example.COM " }));

    expect(eqArgs).toContainEqual(["email", "foo@example.com"]);
    expect(insertPayloads[0]).toMatchObject({ email: "foo@example.com" });
  });

  it("takes the repeat path when a concurrent signup won the unique index", async () => {
    // A double-submitted form: both calls saw no row, the loser hits 23505.
    // The signup did succeed, so an error here would report a failure over a
    // record that exists.
    insertResult = { data: null, error: { message: "duplicate key", code: "23505" } };
    lookupResults = [{ data: null, error: null }, existingRow()];
    rpcResults.rotate_interest_token = { data: "COOLDOWN", error: null };

    const result = await registerInterest(input());

    expect(result).toEqual({ ok: true, emailed: false });
    expect(rpcCall("rotate_interest_token")).toBeDefined();
  });
});

describe("registerInterest — repeat signup", () => {
  beforeEach(() => {
    lookupResults = [existingRow()];
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
    expect(updatePayloads).toEqual([]);
    expect(insertPayloads).toEqual([]);
  });

  it("rolls the rotation back when the send fails, restoring the displaced token", async () => {
    sendEmailReturns = false;

    const result = await registerInterest(input());

    expect(result).toEqual({ ok: true, emailed: false });
    // Undone, not merely un-cooled: clearing the cooldown alone would let a
    // second failed send walk the token forward again, leaving the link in the
    // recipient's inbox in neither slot.
    const call = rpcCall("rollback_interest_rotation");
    expect(call).toMatchObject({
      p_interest_id: ROW_ID,
      p_restore_prefix: PREFIX,
    });
    // Guarded on the hash this attempt wrote, so a concurrent rotation is
    // never clobbered.
    expect(typeof call!.p_expected_hash).toBe("string");
    expect(at("rpc:rollback_interest_rotation")).toBeGreaterThan(at("sendEmail"));
    // The old clearAttempt write is gone.
    expect(updatePayloads).toEqual([]);
  });

  it("does not rotate or send for a revoked record", async () => {
    lookupResults = [existingRow({ revoked_at: "2026-08-01T00:00:00.000Z" })];

    const result = await registerInterest(input());

    // Rotating would spend an email on a link the gate refuses.
    expect(result).toEqual({ ok: true, emailed: false });
    expect(rpcCall("rotate_interest_token")).toBeUndefined();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("scopes the lookup to the tenant", async () => {
    await registerInterest(input());

    // Without this, a caller passing another tenant's intakeId would rotate
    // that tenant's record and mail a fresh link to its owner, killing the
    // live token they hold. Nothing is inserted on this branch, so no FK is
    // ever consulted.
    expect(eqArgs).toContainEqual(["tenant_id", TENANT]);
  });
});

describe("registerInterest — failure branches", () => {
  it("reports RATE_LIMITER_UNAVAILABLE when the limiter RPC errors", async () => {
    rpcResults.consume_interest_signup_slot = { data: null, error: { message: "timeout" } };

    const result = await registerInterest(input());

    // Not throttled and not allowed. Failing open would defeat the limiter on
    // the one fault an attacker can provoke; generic success would swallow a
    // legitimate signup in silence.
    expect(result).toEqual({ ok: false, reason: "RATE_LIMITER_UNAVAILABLE" });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("reports LOOKUP_FAILED when the lookup errors", async () => {
    lookupResults = [{ data: null, error: { message: "connection reset" } }];

    const result = await registerInterest(input());

    // Guessing "first signup" here would send an insert into the unique index.
    expect(result).toEqual({ ok: false, reason: "LOOKUP_FAILED" });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("reports ROTATE_FAILED when the rotation RPC errors", async () => {
    lookupResults = [existingRow()];
    rpcResults.rotate_interest_token = { data: null, error: { message: "deadlock detected" } };

    const result = await registerInterest(input());

    expect(result).toEqual({ ok: false, reason: "ROTATE_FAILED" });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("reports ROTATE_FAILED when the rotation returns NOT_FOUND", async () => {
    lookupResults = [existingRow()];
    rpcResults.rotate_interest_token = { data: "NOT_FOUND", error: null };

    const result = await registerInterest(input());

    // The row was found moments ago, so it was deleted in between. Nothing was
    // written and nothing sent; claiming a link is on its way would be false.
    expect(result).toEqual({ ok: false, reason: "ROTATE_FAILED" });
    expect(mockSendEmail).not.toHaveBeenCalled();
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
