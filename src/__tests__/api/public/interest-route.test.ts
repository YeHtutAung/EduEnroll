import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/api", () => ({ resolveTenantId: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/server/interest/registerInterest", () => ({ registerInterest: vi.fn() }));

import { resolveTenantId } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { registerInterest } from "@/server/interest/registerInterest";
import { POST } from "@/app/api/public/interest/route";

// ─── Supabase query builder factory ──────────────────────────────────────────
//
// Same approach as enroll-slug.test.ts: the route chains a variable number of
// `.eq()` / `.in()` / `.order()` calls before awaiting the builder (or calling
// `.maybeSingle()`), so this returns one object that is both chainable and
// awaitable regardless of which methods were called.

function chainable(result: { data: unknown; error?: unknown }) {
  const resolved = { error: null, ...result };
  const obj: Record<string, unknown> = {
    then: (resolve: (v: unknown) => void) => resolve(resolved),
  };
  for (const method of ["select", "eq", "in", "not", "order", "limit", "single", "maybeSingle"]) {
    obj[method] = vi.fn().mockReturnValue(obj);
  }
  return obj;
}

interface MockOptions {
  intake?: { data: unknown; error?: unknown };
  classes?: { data: unknown; error?: unknown };
  tenant?: { data: unknown; error?: unknown };
}

function makeSupabaseMock(opts: MockOptions = {}) {
  const intakeResult = opts.intake ?? { data: null, error: null };
  const classesResult = opts.classes ?? { data: [], error: null };
  const tenantResult = opts.tenant ?? {
    data: { name: "Test School", subdomain: "acme", logo_url: null },
    error: null,
  };

  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "intakes") return chainable(intakeResult);
      if (table === "classes") return chainable(classesResult);
      if (table === "tenants") return chainable(tenantResult);
      return chainable({ data: null, error: null });
    }),
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
const future = (ms: number) => new Date(Date.now() + ms).toISOString();
const past = (ms: number) => new Date(Date.now() - ms).toISOString();

/** An intake whose priority window has not opened yet — the eligible case. */
function eligibleIntake(overrides: Record<string, unknown> = {}) {
  return {
    id: "intake-1",
    name: "Summer Fest",
    slug: "summer-fest",
    status: "open",
    priority_open_at: future(HOUR),
    ...overrides,
  };
}

/** A tier still behind the window — the covered case. */
const GATED_TIER = { level: "VIP", enrollment_open_at: future(2 * HOUR) };

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://acme.localhost/api/public/interest", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  intake_id: "intake-1",
  name: "Aung Aung",
  email: "Aung@Example.com ",
  phone: "09777000111",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/public/interest", () => {
  const originalSecret = process.env.INTEREST_IP_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INTEREST_IP_SECRET = "test-secret";
    vi.mocked(resolveTenantId).mockResolvedValue("tenant-uuid");
    // Default: eligible intake, one gated tier.
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock({
        intake: { data: eligibleIntake(), error: null },
        classes: { data: [GATED_TIER], error: null },
      }) as never,
    );
    vi.mocked(registerInterest).mockResolvedValue({ ok: true, emailed: true });
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.INTEREST_IP_SECRET;
    else process.env.INTEREST_IP_SECRET = originalSecret;
  });

  // ── Eligibility ────────────────────────────────────────────────────────────

  it("rejects an intake_id belonging to another tenant, and writes nothing", async () => {
    // The route's lookup is scoped to the resolved tenant, so a foreign
    // intake_id finds no row — exactly what the database returns. This is THE
    // cross-tenant guard: the composite FK would happily store a row that is
    // internally consistent with the wrong tenant.
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock({ intake: { data: null, error: null } }) as never,
    );

    const res = await POST(makeRequest(VALID_BODY) as never);

    expect(res.status).toBe(404);
    expect(registerInterest).not.toHaveBeenCalled();
  });

  it("rejects a signup once priority_open_at is in the past", async () => {
    // Signup closes when the window opens. Otherwise anyone could mint
    // themselves a token at that moment and the head start would be available
    // to the general public.
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock({
        intake: { data: eligibleIntake({ priority_open_at: past(HOUR) }), error: null },
        classes: { data: [GATED_TIER], error: null },
      }) as never,
    );

    const res = await POST(makeRequest(VALID_BODY) as never);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRIORITY_WINDOW_OPEN");
    expect(registerInterest).not.toHaveBeenCalled();
  });

  it("rejects a signup when priority_open_at is unset", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock({
        intake: { data: eligibleIntake({ priority_open_at: null }), error: null },
        classes: { data: [GATED_TIER], error: null },
      }) as never,
    );

    const res = await POST(makeRequest(VALID_BODY) as never);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRIORITY_WINDOW_UNSET");
    expect(registerInterest).not.toHaveBeenCalled();
  });

  it("rejects a signup when every tier is already on public sale", async () => {
    // Nothing to be early for.
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock({
        intake: { data: eligibleIntake(), error: null },
        classes: {
          data: [
            { level: "GA", enrollment_open_at: past(HOUR) },
            { level: "EARLY", enrollment_open_at: null },
          ],
          error: null,
        },
      }) as never,
    );

    const res = await POST(makeRequest(VALID_BODY) as never);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("NO_GATED_TIERS");
    expect(registerInterest).not.toHaveBeenCalled();
  });

  it("rejects a closed intake", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock({
        intake: { data: eligibleIntake({ status: "closed" }), error: null },
        classes: { data: [GATED_TIER], error: null },
      }) as never,
    );

    const res = await POST(makeRequest(VALID_BODY) as never);
    const body = await res.json();

    expect(res.status).toBe(410);
    expect(body.code).toBe("INTAKE_UNAVAILABLE");
    expect(registerInterest).not.toHaveBeenCalled();
  });

  // ── Honeypot ───────────────────────────────────────────────────────────────

  it("returns a fake success and writes nothing when the honeypot is filled", async () => {
    const res = await POST(makeRequest({ ...VALID_BODY, __hp: "i am a bot" }) as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    // Indistinguishable from a repeat signup, and carrying no token.
    expect(body).toEqual({ ok: true, emailed: true });
    expect(registerInterest).not.toHaveBeenCalled();
  });

  // ── Success paths ──────────────────────────────────────────────────────────

  it("returns the token on a first signup, with Cache-Control: no-store", async () => {
    vi.mocked(registerInterest).mockResolvedValue({
      ok: true,
      emailed: true,
      token: "raw-token-value",
    });

    const res = await POST(makeRequest(VALID_BODY) as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.token).toBe("raw-token-value");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("passes the eligibility-derived context through to registerInterest", async () => {
    vi.mocked(registerInterest).mockResolvedValue({ ok: true, emailed: true, token: "t" });

    await POST(makeRequest(VALID_BODY) as never);

    const arg = vi.mocked(registerInterest).mock.calls[0][0];
    expect(arg.intakeId).toBe("intake-1");
    expect(arg.tenantId).toBe("tenant-uuid");
    expect(arg.eventName).toBe("Summer Fest");
    expect(arg.coveredTiers).toEqual(["VIP"]);
    expect(arg.linkBase).toMatch(/\/enroll\/summer-fest$/);
    // Hashed, never the raw address — the column CHECK is 64 lowercase hex.
    expect(arg.ipHash).toMatch(/^[0-9a-f]{64}$/);
    // Pre-formatted here; registerInterest formats nothing.
    expect(typeof arg.windowOpensAt).toBe("string");
    expect(arg.windowOpensAt).not.toBe("");
    // Raw values — registerInterest owns trimming and lowercasing.
    expect(arg.email).toBe("Aung@Example.com ");
  });

  it("returns no token on a repeat signup", async () => {
    // Echoing it would let anyone harvest another person's link by typing
    // their address into the public form.
    vi.mocked(registerInterest).mockResolvedValue({ ok: true, emailed: true });

    const res = await POST(makeRequest(VALID_BODY) as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, emailed: true });
    expect(body.token).toBeUndefined();
  });

  it("answers a throttled call exactly as it answers a permitted one", async () => {
    // registerInterest returns one uniform shape for both, so the route must
    // not add anything that reintroduces the distinction — telling a script
    // when it has been throttled only helps it calibrate. Asserting the exact
    // key set is what catches an added flag (or a leaked token).
    vi.mocked(registerInterest).mockResolvedValue({ ok: true, emailed: false });
    const throttled = await POST(makeRequest(VALID_BODY) as never);
    const throttledBody = await throttled.json();

    vi.mocked(registerInterest).mockResolvedValue({ ok: true, emailed: false });
    const permitted = await POST(makeRequest(VALID_BODY) as never);
    const permittedBody = await permitted.json();

    expect(throttled.status).toBe(permitted.status);
    expect(throttledBody).toEqual(permittedBody);
    expect(Object.keys(throttledBody).sort()).toEqual(["emailed", "ok"]);
  });

  // ── Input bounds ───────────────────────────────────────────────────────────

  it("400s an over-length name rather than letting the CHECK fail the write", async () => {
    const res = await POST(makeRequest({ ...VALID_BODY, name: "a".repeat(121) }) as never);

    expect(res.status).toBe(400);
    expect(registerInterest).not.toHaveBeenCalled();
  });

  it("400s an over-length email", async () => {
    const res = await POST(
      makeRequest({ ...VALID_BODY, email: `${"a".repeat(250)}@example.com` }) as never,
    );

    expect(res.status).toBe(400);
    expect(registerInterest).not.toHaveBeenCalled();
  });

  it("400s an over-length phone", async () => {
    const res = await POST(makeRequest({ ...VALID_BODY, phone: "0".repeat(33) }) as never);

    expect(res.status).toBe(400);
    expect(registerInterest).not.toHaveBeenCalled();
  });

  // ── Configuration ──────────────────────────────────────────────────────────

  it("fails closed with a 500 when INTEREST_IP_SECRET is unset", async () => {
    delete process.env.INTEREST_IP_SECRET;

    const res = await POST(makeRequest(VALID_BODY) as never);

    expect(res.status).toBe(500);
    expect(registerInterest).not.toHaveBeenCalled();
  });

  // ── Orchestrator failures ──────────────────────────────────────────────────

  it("reports a failed write as an error, never as a success", async () => {
    vi.mocked(registerInterest).mockResolvedValue({ ok: false, reason: "WRITE_FAILED" });

    const res = await POST(makeRequest(VALID_BODY) as never);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBeUndefined();
  });

  it("reports an unavailable rate limiter as retryable, not as a throttled success", async () => {
    vi.mocked(registerInterest).mockResolvedValue({
      ok: false,
      reason: "RATE_LIMITER_UNAVAILABLE",
    });

    const res = await POST(makeRequest(VALID_BODY) as never);

    expect(res.status).toBe(503);
  });
});
