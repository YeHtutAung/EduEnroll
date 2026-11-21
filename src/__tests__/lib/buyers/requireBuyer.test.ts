import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";

// ─── requireBuyer: Auth-checked buyer guard ─────────────────────────────────
// 401 only for a real Auth rejection; an Auth or DB outage is 503 SERVER.

// Unsigned token with the given payload. tokenClaim only decodes; getUser
// (mocked here) is what accepts or rejects it.
function token(payload: unknown): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc(payload)}.sig`;
}
const GOOD = token({ sub: "u1", session_id: "s1", amr: [{ method: "otp", timestamp: 1 }] });
const NO_SESSION = token({ sub: "u1", amr: [{ method: "otp", timestamp: 1 }] });
const OTHER = token({ sub: "u2", session_id: "s2", amr: [{ method: "otp", timestamp: 1 }] });

const headerMap = new Map<string, string>();
vi.mock("next/headers", () => ({
  headers: () => ({ get: (k: string) => headerMap.get(k.toLowerCase()) ?? null }),
}));

const cookieClient = { auth: { getSession: vi.fn() } };
vi.mock("@/lib/supabase/server", () => ({ createClient: () => cookieClient }));

const bareClient = { auth: { getUser: vi.fn() } };
vi.mock("@supabase/supabase-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/supabase-js")>();
  return { ...actual, createClient: vi.fn(() => bareClient) };
});

type Result = { data: unknown; error: unknown };
const results: Record<string, Result> = {};
function query(table: string) {
  const q: Record<string, unknown> = {};
  q.select = vi.fn(() => q);
  q.eq = vi.fn(() => q);
  q.maybeSingle = vi.fn(async () => results[table]);
  return q;
}
const adminFrom = vi.fn((table: string) => query(table));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: adminFrom }) }));

const tokenClaimSpy = vi.fn();
vi.mock("@/lib/authMethod", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/authMethod")>();
  return {
    ...actual,
    tokenClaim: (t: string | null | undefined, name: string) => {
      tokenClaimSpy(t, name);
      return actual.tokenClaim(t, name);
    },
  };
});

import { requireBuyer } from "@/lib/buyers/requireBuyer";

const PROFILE = { id: "u1", email: "b@example.test", is_reviewer: false, deleted_at: null };

async function expectError(res: unknown, status: number, code: string) {
  expect(res).toBeInstanceOf(NextResponse);
  expect((res as NextResponse).status).toBe(status);
  expect(await (res as NextResponse).json()).toMatchObject({ error: { code } });
}

function tablesRead(): string[] {
  return adminFrom.mock.calls.map((c) => c[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  headerMap.clear();
  cookieClient.auth.getSession.mockResolvedValue({ data: { session: null } });
  bareClient.auth.getUser.mockResolvedValue({
    data: { user: { id: "u1", email: "B@Example.test" } },
    error: null,
  });
  results.users = { data: null, error: null };
  results.buyer_profiles = { data: { ...PROFILE }, error: null };
});

describe("requireBuyer — token", () => {
  it("returns 401 with no header and no cookie session, without asking Auth", async () => {
    await expectError(await requireBuyer(), 401, "UNAUTHENTICATED");
    expect(bareClient.auth.getUser).not.toHaveBeenCalled();
    expect(adminFrom).not.toHaveBeenCalled();
  });

  it("prefers x-supabase-auth over authorization", async () => {
    headerMap.set("x-supabase-auth", `Bearer ${GOOD}`);
    headerMap.set("authorization", `Bearer ${OTHER}`);
    expect(await requireBuyer()).not.toBeInstanceOf(NextResponse);
    expect(bareClient.auth.getUser).toHaveBeenCalledTimes(1);
    expect(bareClient.auth.getUser).toHaveBeenCalledWith(GOOD);
  });

  it("ignores a non-Bearer authorization header and returns 401 with no cookie session", async () => {
    headerMap.set("authorization", "Basic xyz");
    await expectError(await requireBuyer(), 401, "UNAUTHENTICATED");
    expect(bareClient.auth.getUser).not.toHaveBeenCalled();
  });
});

describe("requireBuyer — cookie session read", () => {
  it("returns 503 SERVER when getSession's refresh can't reach Auth", async () => {
    cookieClient.auth.getSession.mockResolvedValue({
      data: { session: null },
      error: new AuthRetryableFetchError("x", 0),
    });
    await expectError(await requireBuyer(), 503, "SERVER");
    expect(bareClient.auth.getUser).not.toHaveBeenCalled();
    expect(adminFrom).not.toHaveBeenCalled();
  });

  it("returns 503 SERVER when getSession throws", async () => {
    cookieClient.auth.getSession.mockRejectedValue(new Error("boom"));
    await expectError(await requireBuyer(), 503, "SERVER");
    expect(bareClient.auth.getUser).not.toHaveBeenCalled();
    expect(adminFrom).not.toHaveBeenCalled();
  });

  it("returns 401 when Auth rejects the refresh token and there is no session", async () => {
    cookieClient.auth.getSession.mockResolvedValue({
      data: { session: null },
      error: new AuthApiError("x", 400, "refresh_token_not_found"),
    });
    await expectError(await requireBuyer(), 401, "UNAUTHENTICATED");
    expect(bareClient.auth.getUser).not.toHaveBeenCalled();
    expect(adminFrom).not.toHaveBeenCalled();
  });
});

describe("requireBuyer — Auth answer", () => {
  beforeEach(() => headerMap.set("authorization", `Bearer ${GOOD}`));

  it("returns 401 when Auth rejects the session (403 session_not_found)", async () => {
    bareClient.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthApiError("Session not found", 403, "session_not_found"),
    });
    await expectError(await requireBuyer(), 401, "UNAUTHENTICATED");
    expect(bareClient.auth.getUser).toHaveBeenCalledWith(GOOD);
    expect(tokenClaimSpy).not.toHaveBeenCalled();
    expect(adminFrom).not.toHaveBeenCalled();
  });

  it("returns 503 SERVER when Auth answers 500", async () => {
    bareClient.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthApiError("boom", 500, "unexpected_failure"),
    });
    await expectError(await requireBuyer(), 503, "SERVER");
    expect(tokenClaimSpy).not.toHaveBeenCalled();
    expect(adminFrom).not.toHaveBeenCalled();
  });

  it("returns 503 SERVER when getUser throws a network error", async () => {
    bareClient.auth.getUser.mockRejectedValue(new AuthRetryableFetchError("network", 0));
    await expectError(await requireBuyer(), 503, "SERVER");
    expect(tokenClaimSpy).not.toHaveBeenCalled();
    expect(adminFrom).not.toHaveBeenCalled();
  });

  it("returns 503 SERVER when Auth rate-limits (429)", async () => {
    bareClient.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthApiError("slow down", 429, "over_request_rate_limit"),
    });
    await expectError(await requireBuyer(), 503, "SERVER");
    expect(tokenClaimSpy).not.toHaveBeenCalled();
    expect(adminFrom).not.toHaveBeenCalled();
  });

  it("returns 401 when the accepted token has no session_id, without reading the DB", async () => {
    headerMap.set("authorization", `Bearer ${NO_SESSION}`);
    await expectError(await requireBuyer(), 401, "UNAUTHENTICATED");
    expect(bareClient.auth.getUser).toHaveBeenCalledWith(NO_SESSION);
    expect(adminFrom).not.toHaveBeenCalled();
  });
});

describe("requireBuyer — staff and profile", () => {
  beforeEach(() => headerMap.set("x-supabase-auth", `Bearer ${GOOD}`));

  it("returns 403 FORBIDDEN for a staff account, without reading buyer_profiles", async () => {
    results.users = { data: { id: "u1" }, error: null };
    await expectError(await requireBuyer(), 403, "FORBIDDEN");
    expect(tablesRead()).toEqual(["users"]);
  });

  it("returns 503 SERVER when the users read fails, without reading buyer_profiles", async () => {
    results.users = { data: null, error: { message: "db down" } };
    await expectError(await requireBuyer(), 503, "SERVER");
    expect(tablesRead()).toEqual(["users"]);
  });

  it("returns 401 when there is no buyer profile", async () => {
    results.buyer_profiles = { data: null, error: null };
    await expectError(await requireBuyer(), 401, "UNAUTHENTICATED");
    expect(tablesRead()).toEqual(["users", "buyer_profiles"]);
  });

  it("returns 401 when the profile is deleted", async () => {
    results.buyer_profiles = { data: { ...PROFILE, deleted_at: "2026-11-20T00:00:00Z" }, error: null };
    await expectError(await requireBuyer(), 401, "UNAUTHENTICATED");
    expect(tablesRead()).toEqual(["users", "buyer_profiles"]);
  });

  it("returns 401 when the profile email differs from the Auth email", async () => {
    results.buyer_profiles = { data: { ...PROFILE, email: "other@example.test" }, error: null };
    await expectError(await requireBuyer(), 401, "UNAUTHENTICATED");
    expect(tablesRead()).toEqual(["users", "buyer_profiles"]);
  });

  it("returns 503 SERVER when the buyer_profiles read fails", async () => {
    results.buyer_profiles = { data: null, error: { message: "db down" } };
    await expectError(await requireBuyer(), 503, "SERVER");
  });
});

describe("requireBuyer — success", () => {
  const EXPECTED = { buyerId: "u1", email: "b@example.test", isReviewer: false, sessionId: "s1" };

  it("returns the buyer context for a Bearer token", async () => {
    headerMap.set("authorization", `Bearer ${GOOD}`);
    expect(await requireBuyer()).toEqual(EXPECTED);
    expect(cookieClient.auth.getSession).not.toHaveBeenCalled();
    expect(bareClient.auth.getUser).toHaveBeenCalledWith(GOOD);
  });

  it("returns the same context for a cookie session, using its access_token", async () => {
    cookieClient.auth.getSession.mockResolvedValue({ data: { session: { access_token: GOOD } } });
    expect(await requireBuyer()).toEqual(EXPECTED);
    expect(bareClient.auth.getUser).toHaveBeenCalledWith(GOOD);
    expect(tokenClaimSpy).toHaveBeenCalledWith(GOOD, "session_id");
  });
});

describe("requireBuyer — logging", () => {
  it("logs on every 503 path without the token, email or user id", async () => {
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const spies = methods.map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      const scenarios: Array<() => void> = [
        () => cookieClient.auth.getSession.mockResolvedValue({
          data: { session: null }, error: new AuthRetryableFetchError("x", 0),
        }),
        () => cookieClient.auth.getSession.mockRejectedValue(new Error(`boom ${GOOD}`)),
        () => {
          headerMap.set("authorization", `Bearer ${GOOD}`);
          bareClient.auth.getUser.mockResolvedValue({
            data: { user: null }, error: new AuthApiError("boom", 500, "unexpected_failure"),
          });
        },
        () => {
          headerMap.set("authorization", `Bearer ${GOOD}`);
          bareClient.auth.getUser.mockRejectedValue(new AuthRetryableFetchError("network", 0));
        },
        () => {
          headerMap.set("authorization", `Bearer ${GOOD}`);
          results.users = { data: null, error: { message: "db down b@example.test" } };
        },
        () => {
          headerMap.set("authorization", `Bearer ${GOOD}`);
          results.buyer_profiles = { data: null, error: { message: "db down b@example.test" } };
        },
      ];
      let logged = 0;
      for (const setup of scenarios) {
        headerMap.clear();
        cookieClient.auth.getSession.mockResolvedValue({ data: { session: null } });
        bareClient.auth.getUser.mockResolvedValue({
          data: { user: { id: "u1", email: "B@Example.test" } }, error: null,
        });
        results.users = { data: null, error: null };
        results.buyer_profiles = { data: { ...PROFILE }, error: null };
        setup();
        const before = spies.reduce((n, s) => n + s.mock.calls.length, 0);
        await expectError(await requireBuyer(), 503, "SERVER");
        const after = spies.reduce((n, s) => n + s.mock.calls.length, 0);
        expect(after).toBeGreaterThan(before);
        logged = after;
      }
      expect(logged).toBeGreaterThan(0);
      const text = spies
        .flatMap((s) => s.mock.calls)
        .map((args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a) ?? String(a))).join(" "))
        .join("\n")
        .toLowerCase();
      expect(text).not.toContain(GOOD.toLowerCase());
      expect(text).not.toContain("b@example.test");
      expect(text).not.toContain("u1");
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
