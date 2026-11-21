import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── acceptToken against the REAL auth-js client ────────────────────────────
// Only fetch is stubbed, so the error class each Auth answer turns into is
// whatever the installed auth-js produces, not a guess in a mock.

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { acceptToken } from "@/lib/buyers/sessionUser";

const ENV = { ...process.env };

function respond(status: number, body: string, headers: Record<string, string> = {}) {
  const fetchStub = vi.fn(async () =>
    new Response(body, { status, headers: { "content-type": "application/json", ...headers } }),
  );
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://auth.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ENV };
});

describe("acceptToken — real auth-js", () => {
  it("403 session_not_found (2024 API) → rejected", async () => {
    const f = respond(
      403,
      JSON.stringify({ code: "session_not_found", message: "Session from session_id claim in JWT does not exist" }),
      { "x-supabase-api-version": "2024-01-01" },
    );
    expect(await acceptToken("a.b.c")).toEqual({ kind: "rejected" });
    expect(f).toHaveBeenCalled();
  });

  it("403 session_not_found (legacy error_code) → rejected", async () => {
    respond(403, JSON.stringify({ code: 403, error_code: "session_not_found", msg: "x" }));
    expect(await acceptToken("a.b.c")).toEqual({ kind: "rejected" });
  });

  it("403 user_not_found → rejected", async () => {
    respond(403, JSON.stringify({ code: "user_not_found", message: "x" }), { "x-supabase-api-version": "2024-01-01" });
    expect(await acceptToken("a.b.c")).toEqual({ kind: "rejected" });
  });

  it("500 with an HTML body → unavailable", async () => {
    respond(500, "<html>oops</html>", { "content-type": "text/html" });
    expect(await acceptToken("a.b.c")).toEqual({ kind: "unavailable" });
  });

  it("a network failure → unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await acceptToken("a.b.c")).toEqual({ kind: "unavailable" });
  });

  it("200 with a user → ok, same token", async () => {
    respond(200, JSON.stringify({ id: "u1", email: "b@example.test", aud: "authenticated" }));
    const r = await acceptToken("a.b.c");
    expect(r).toMatchObject({ kind: "ok", token: "a.b.c", user: { id: "u1" } });
  });
});
