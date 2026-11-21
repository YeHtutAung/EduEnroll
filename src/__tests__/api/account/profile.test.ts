import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";

// ─── /api/account/profile: the website's profile route ──────────────────────
// GET delegates to requireBuyer. POST takes the cookie session only, has Auth
// accept that exact token, then hands the user and token to ensureBuyerProfile.
// An Auth outage is 503 SERVER, never 401.

const cookieClient = { auth: { getSession: vi.fn() } };
vi.mock("@/lib/supabase/server", () => ({ createClient: () => cookieClient }));

const bareClient = { auth: { getUser: vi.fn() } };
vi.mock("@supabase/supabase-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/supabase-js")>();
  return { ...actual, createClient: vi.fn(() => bareClient) };
});

const requireBuyer = vi.fn();
vi.mock("@/lib/buyers/requireBuyer", () => ({ requireBuyer: () => requireBuyer() }));

const ensureBuyerProfile = vi.fn();
vi.mock("@/server/buyers/ensureBuyerProfile", () => ({
  ensureBuyerProfile: (...args: unknown[]) => ensureBuyerProfile(...args),
}));

let profileRead: { data: unknown; error: unknown };
const eqSpy = vi.fn();
const adminFrom = vi.fn(() => {
  const q: Record<string, unknown> = {};
  q.select = vi.fn(() => q);
  q.eq = vi.fn((...a: unknown[]) => {
    eqSpy(...a);
    return q;
  });
  q.maybeSingle = vi.fn(async () => profileRead);
  return q;
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: adminFrom }) }));

import { GET, POST, dynamic } from "@/app/api/account/profile/route";

const USER = { id: "u1", email: "b@example.test", email_confirmed_at: "2026-11-01T00:00:00Z" };
const PROFILE = {
  id: "u1",
  email: "b@example.test",
  phone_e164: null,
  name: "Aung",
  locale: "my",
  is_reviewer: false,
  created_at: "x",
  updated_at: "x",
  deleted_at: null,
};

function post(body?: string): Request {
  return new Request("http://localhost/api/account/profile", {
    method: "POST",
    ...(body === undefined ? {} : { body, headers: { "content-type": "application/json" } }),
  });
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const json = await res.json();
  expect(json).toMatchObject({ error: { code } });
  return json;
}

function expectNoAuthAccepted() {
  expect(bareClient.auth.getUser).not.toHaveBeenCalled();
  expect(ensureBuyerProfile).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  cookieClient.auth.getSession.mockResolvedValue({
    data: { session: { access_token: "session-token" } },
    error: null,
  });
  bareClient.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null });
  ensureBuyerProfile.mockResolvedValue({ ok: true, status: 200, profile: PROFILE });
  requireBuyer.mockResolvedValue({ buyerId: "u1", email: "b@example.test", isReviewer: false, sessionId: "s1" });
  profileRead = { data: { name: "Aung", locale: "my" }, error: null };
});

describe("dynamic", () => {
  it("is force-dynamic", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});

describe("GET", () => {
  it("passes requireBuyer's error response through unchanged", async () => {
    const err = NextResponse.json({ error: { code: "FORBIDDEN", message: "m" } }, { status: 403 });
    requireBuyer.mockResolvedValue(err);
    const res = await GET();
    expect(res).toBe(err);
    expect(adminFrom).not.toHaveBeenCalled();
  });

  it("answers 200 { email, name, locale }, reading the buyer's own row", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "b@example.test", name: "Aung", locale: "my" });
    expect(adminFrom).toHaveBeenCalledWith("buyer_profiles");
    expect(eqSpy).toHaveBeenCalledWith("id", "u1");
  });

  it("answers 503 SERVER when the profile read fails", async () => {
    profileRead = { data: null, error: { code: "57014" } };
    await expectError(await GET(), 503, "SERVER");
  });

  it("answers 401 when the row vanished after requireBuyer", async () => {
    profileRead = { data: null, error: null };
    await expectError(await GET(), 401, "UNAUTHENTICATED");
  });
});

describe("POST — cookie session", () => {
  it("no session and no error → 401", async () => {
    cookieClient.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expectError(await POST(post()), 401, "UNAUTHENTICATED");
    expectNoAuthAccepted();
  });

  it("a real 4xx rejection with no session → 401", async () => {
    cookieClient.auth.getSession.mockResolvedValue({
      data: { session: null },
      error: new AuthApiError("Invalid Refresh Token", 400, "refresh_token_not_found"),
    });
    await expectError(await POST(post()), 401, "UNAUTHENTICATED");
    expectNoAuthAccepted();
  });

  it("an unavailable refresh error → 503 SERVER", async () => {
    cookieClient.auth.getSession.mockResolvedValue({
      data: { session: null },
      error: new AuthRetryableFetchError("fetch failed", 0),
    });
    await expectError(await POST(post()), 503, "SERVER");
    expectNoAuthAccepted();
  });

  it("getSession throwing → 503 SERVER", async () => {
    cookieClient.auth.getSession.mockRejectedValue(new Error("boom"));
    await expectError(await POST(post()), 503, "SERVER");
    expectNoAuthAccepted();
  });

  it("an Auth 429 on refresh is unavailable → 503", async () => {
    cookieClient.auth.getSession.mockResolvedValue({
      data: { session: null },
      error: new AuthApiError("rate limited", 429, "over_request_rate_limit"),
    });
    await expectError(await POST(post()), 503, "SERVER");
    expectNoAuthAccepted();
  });

  it("ignores a Bearer header: the cookie session decides", async () => {
    cookieClient.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const req = new Request("http://localhost/api/account/profile", {
      method: "POST",
      headers: { authorization: "Bearer other-token" },
    });
    await expectError(await POST(req), 401, "UNAUTHENTICATED");
    expectNoAuthAccepted();
  });
});

describe("POST — getUser", () => {
  it("is called with the session's own token", async () => {
    await POST(post());
    expect(bareClient.auth.getUser).toHaveBeenCalledWith("session-token");
  });

  it("a 4xx rejection → 401, ensureBuyerProfile not called", async () => {
    bareClient.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthApiError("bad jwt", 403, "bad_jwt"),
    });
    await expectError(await POST(post()), 401, "UNAUTHENTICATED");
    expect(ensureBuyerProfile).not.toHaveBeenCalled();
  });

  it("a 5xx → 503, ensureBuyerProfile not called", async () => {
    bareClient.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthApiError("upstream", 502, "unexpected_failure"),
    });
    await expectError(await POST(post()), 503, "SERVER");
    expect(ensureBuyerProfile).not.toHaveBeenCalled();
  });

  it("throwing a network error → 503, ensureBuyerProfile not called", async () => {
    bareClient.auth.getUser.mockRejectedValue(new AuthRetryableFetchError("fetch failed", 0));
    await expectError(await POST(post()), 503, "SERVER");
    expect(ensureBuyerProfile).not.toHaveBeenCalled();
  });

  it("no user and no error → 503 (not a rejection Auth gave)", async () => {
    bareClient.auth.getUser.mockResolvedValue({ data: { user: null }, error: null });
    await expectError(await POST(post()), 503, "SERVER");
    expect(ensureBuyerProfile).not.toHaveBeenCalled();
  });
});

describe("POST — ensureBuyerProfile", () => {
  it("receives getUser's user and the session's own token", async () => {
    await POST(post());
    expect(ensureBuyerProfile).toHaveBeenCalledTimes(1);
    expect(ensureBuyerProfile).toHaveBeenCalledWith({ user: USER, accessToken: "session-token" });
  });

  it("200 → { email, name, locale }", async () => {
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "b@example.test", name: "Aung", locale: "my" });
  });

  it("201 → 201 with { email, name, locale }", async () => {
    ensureBuyerProfile.mockResolvedValue({ ok: true, status: 201, profile: { ...PROFILE, name: null, locale: "en" } });
    const res = await POST(post());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ email: "b@example.test", name: null, locale: "en" });
  });

  it.each(["staff", "unconfirmed", "not_email_code"] as const)("403 %s → FORBIDDEN with reason", async (reason) => {
    ensureBuyerProfile.mockResolvedValue({ ok: false, status: 403, code: "FORBIDDEN", reason });
    const json = await expectError(await POST(post()), 403, "FORBIDDEN");
    expect(json.error.reason).toBe(reason);
    expect(typeof json.error.message).toBe("string");
  });

  it("409 → DELETION_IN_PROGRESS", async () => {
    ensureBuyerProfile.mockResolvedValue({ ok: false, status: 409, code: "DELETION_IN_PROGRESS" });
    await expectError(await POST(post()), 409, "DELETION_IN_PROGRESS");
  });

  it("503 → SERVER", async () => {
    ensureBuyerProfile.mockResolvedValue({ ok: false, status: 503, code: "SERVER" });
    await expectError(await POST(post()), 503, "SERVER");
  });
});

describe("POST — body", () => {
  it("an empty body is fine", async () => {
    expect((await POST(post(""))).status).toBe(200);
  });

  it("a body without email is fine", async () => {
    expect((await POST(post(JSON.stringify({ locale: "en" })))).status).toBe(200);
  });

  it('{ "email": … } → 422 VALIDATION, nothing else called', async () => {
    await expectError(await POST(post(JSON.stringify({ email: "x@y.z" }))), 422, "VALIDATION");
    expect(ensureBuyerProfile).not.toHaveBeenCalled();
    expect(bareClient.auth.getUser).not.toHaveBeenCalled();
  });

  it('{ "email": null } still → 422 (the key alone is refused)', async () => {
    await expectError(await POST(post(JSON.stringify({ email: null }))), 422, "VALIDATION");
    expect(ensureBuyerProfile).not.toHaveBeenCalled();
  });

  it("malformed JSON → 422 VALIDATION", async () => {
    await expectError(await POST(post("{not json")), 422, "VALIDATION");
    expect(ensureBuyerProfile).not.toHaveBeenCalled();
  });
});
