import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";

// ─── requireAuth() agent path (#164 Phase 1) ────────────────────────────────
// The middleware suite cannot host these: it mocks only the Supabase session
// refresh and never exercises headers(), createAdminClient(), the tenant/config
// branches, real HMAC verification, or warning emission.
//
// Signatures are REAL (createHmac against the same secret), not a mocked
// verifier. A mocked verifier cannot show that verification happens BEFORE the
// telemetry warning — which is the whole point of T11/T12.

const AGENT_SECRET = "test-agent-secret";

const mockHeaders = vi.fn();
vi.mock("next/headers", () => ({ headers: () => mockHeaders() }));

const mockFrom = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mockFrom }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({}) }));

/**
 * A query terminal exposing BOTH .single() and .maybeSingle().
 *
 * The red run exercises code calling .single(); the green implementation calls
 * .maybeSingle(). A fixture offering only one makes the red run die on
 * "query.single is not a function" — a failure that proves nothing about
 * 404/403 versus 500, and which the plan classes as an INVALID red phase.
 */
function queryResult(result: { data: unknown; error: unknown }) {
  const q: Record<string, unknown> = {};
  q.select = vi.fn(() => q);
  q.eq = vi.fn(() => q);
  q.single = vi.fn(async () => result);
  q.maybeSingle = vi.fn(async () => result);
  return q;
}

const ok = (data: unknown) => queryResult({ data, error: null });

/**
 * Zero rows — and the two terminals disagree about what that means.
 *
 * .single() treats "no rows" as an ERROR (PGRST116); .maybeSingle() returns
 * data null with error null. A fixture returning the same shape from both
 * would make the green run read absence as a query failure and answer 500,
 * which is the very conflation this change removes.
 */
function noRow() {
  const q = queryResult({ data: null, error: null });
  q.single = vi.fn(async () => ({ data: null, error: { code: "PGRST116", message: "no rows" } }));
  q.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  return q;
}

/** A genuine failure — both terminals surface it identically. */
const queryFailed = () => queryResult({ data: null, error: { message: "connection reset" } });

function sign(chatId: string, rawBody: string) {
  return "sha256=" + createHmac("sha256", AGENT_SECRET).update(`${chatId}.${rawBody}`).digest("hex");
}

function agentHeaders(opts: {
  host: string;
  chatId?: string;
  signature?: string;
  slug?: string;
  routeFamily?: string;
}) {
  const map = new Map<string, string>([
    ["host", opts.host],
    ["x-chat-id", opts.chatId ?? "123"],
    ["x-agent-signature", opts.signature ?? sign(opts.chatId ?? "123", "")],
  ]);
  if (opts.slug !== undefined) map.set("x-tenant-slug", opts.slug);
  if (opts.routeFamily !== undefined) map.set("x-agent-route-family", opts.routeFamily);
  return { get: (k: string) => map.get(k.toLowerCase()) ?? null };
}

const ORIGINAL_SECRET = process.env.AGENT_SECRET;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env.AGENT_SECRET = AGENT_SECRET;
  vi.clearAllMocks();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  // Delete-aware: assigning undefined stores the string "undefined".
  if (ORIGINAL_SECRET === undefined) delete process.env.AGENT_SECRET;
  else process.env.AGENT_SECRET = ORIGINAL_SECRET;
  warnSpy.mockRestore();
});

async function callRequireAuth() {
  const { requireAuth } = await import("@/lib/api");
  return requireAuth("");
}

// ── Tenant / config lookup outcomes ────────────────────────────────────────
// Four distinct states. Today .single() errors on zero rows and the code
// discards the error, so "absent" and "failed" are indistinguishable.
describe("requireAuth agent path — lookup outcomes", () => {
  it("T14a returns 500 when the tenant query fails", async () => {
    mockHeaders.mockReturnValue(agentHeaders({ host: "flashtic.kuunyi.com", slug: "flashtic" }));
    mockFrom.mockReturnValueOnce(queryFailed());
    const res = await callRequireAuth();
    expect((res as Response).status).toBe(500);
  });

  it("T14b returns 500 when the telegram config query fails", async () => {
    mockHeaders.mockReturnValue(agentHeaders({ host: "flashtic.kuunyi.com", slug: "flashtic" }));
    mockFrom.mockReturnValueOnce(ok({ id: "tenant-1" })).mockReturnValueOnce(queryFailed());
    const res = await callRequireAuth();
    expect((res as Response).status).toBe(500);
  });

  it("T14c returns 404 when the tenant genuinely does not exist", async () => {
    mockHeaders.mockReturnValue(agentHeaders({ host: "flashtic.kuunyi.com", slug: "nope" }));
    mockFrom.mockReturnValueOnce(noRow());
    const res = await callRequireAuth();
    expect((res as Response).status).toBe(404);
  });

  it("T14d returns 403 when the tenant has no telegram config row", async () => {
    mockHeaders.mockReturnValue(agentHeaders({ host: "flashtic.kuunyi.com", slug: "flashtic" }));
    mockFrom.mockReturnValueOnce(ok({ id: "tenant-1" })).mockReturnValueOnce(noRow());
    const res = await callRequireAuth();
    expect((res as Response).status).toBe(403);
  });

  it("T8b rejects a chat id absent from allowed_chat_ids", async () => {
    mockHeaders.mockReturnValue(agentHeaders({ host: "other.kuunyi.com", slug: "other" }));
    mockFrom
      .mockReturnValueOnce(ok({ id: "tenant-2" }))
      .mockReturnValueOnce(ok({ allowed_chat_ids: [999] }));
    const res = await callRequireAuth();
    expect((res as Response).status).toBe(403);
  });
});

// ── Transitional telemetry ─────────────────────────────────────────────────
// Gates the eventual removal of the middleware exception: absence of these
// events is the evidence the bot has migrated. The signal must therefore be
// unforgeable (T12) and must not fire on correctly-migrated traffic (T13) —
// otherwise it can never clear.
describe("requireAuth agent path — root-host telemetry", () => {
  const rootHostEvents = () =>
    warnSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes("[agent-auth] platform-root"));

  it("T11 emits the event for a valid signature on a platform root", async () => {
    mockHeaders.mockReturnValue(agentHeaders({ host: "kuunyi.com", slug: "flashtic" }));
    mockFrom
      .mockReturnValueOnce(ok({ id: "tenant-1" }))
      .mockReturnValueOnce(ok({ allowed_chat_ids: [123] }));
    await callRequireAuth();
    expect(rootHostEvents()).toHaveLength(1);
  });

  it("T11b records the middleware-supplied route family", async () => {
    mockHeaders.mockReturnValue(
      agentHeaders({ host: "kuunyi.com", slug: "flashtic", routeFamily: "intakes" }),
    );
    mockFrom
      .mockReturnValueOnce(ok({ id: "tenant-1" }))
      .mockReturnValueOnce(ok({ allowed_chat_ids: [123] }));
    await callRequireAuth();
    expect(String(rootHostEvents()[0][0])).toContain("routeFamily=intakes");
  });

  it("T11c records 'other' when middleware set no route family", async () => {
    // Reaching requireAuth() from outside the transitional allowlist is worth
    // seeing: it means the bot called a route it was not known to use.
    mockHeaders.mockReturnValue(agentHeaders({ host: "kuunyi.com", slug: "flashtic" }));
    mockFrom
      .mockReturnValueOnce(ok({ id: "tenant-1" }))
      .mockReturnValueOnce(ok({ allowed_chat_ids: [123] }));
    await callRequireAuth();
    expect(String(rootHostEvents()[0][0])).toContain("routeFamily=other");
  });

  it("T12 emits NO event for an invalid signature on a platform root", async () => {
    mockHeaders.mockReturnValue(
      agentHeaders({ host: "kuunyi.com", slug: "flashtic", signature: "sha256=deadbeef" }),
    );
    await callRequireAuth();
    expect(rootHostEvents()).toHaveLength(0);
  });

  it("T13 emits NO event for a valid signature on a tenant host", async () => {
    // Without this, an implementation that logged after every valid signature
    // would pass T11 and T12 — and once the bot migrated correctly, every
    // legitimate request would keep emitting the event, so the removal gate
    // could never clear.
    mockHeaders.mockReturnValue(agentHeaders({ host: "flashtic.kuunyi.com", slug: "flashtic" }));
    mockFrom
      .mockReturnValueOnce(ok({ id: "tenant-1" }))
      .mockReturnValueOnce(ok({ allowed_chat_ids: [123] }));
    await callRequireAuth();
    expect(rootHostEvents()).toHaveLength(0);
  });
});
