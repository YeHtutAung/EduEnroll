import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from "@supabase/supabase-js";

// ─── /api/account/profile: the website's profile route ──────────────────────
// GET delegates to requireBuyer. POST takes the cookie session only, has Auth
// accept that exact token, then hands the user and token to ensureBuyerProfile.
// An Auth outage is 503 SERVER, never 401.

const cookieClient = { auth: { getSession: vi.fn(), verifyOtp: vi.fn() } };
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
const HASH = "reissue-hash-secret-abcdef0123456789";
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
  cookieClient.auth.verifyOtp.mockResolvedValue({ data: { session: { access_token: "new" } }, error: null });
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

  it("answers 200 { buyerId, email, name, locale }, reading the buyer's own row", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    // buyerId keys the phone's device key on /account/tickets/[id] (plan Task 8).
    expect(await res.json()).toEqual({ buyerId: "u1", email: "b@example.test", name: "Aung", locale: "my" });
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

  it("AuthSessionMissingError with no session → 401", async () => {
    cookieClient.auth.getSession.mockResolvedValue({
      data: { session: null },
      error: new AuthSessionMissingError(),
    });
    await expectError(await POST(post()), 401, "UNAUTHENTICATED");
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

  it("an ended session (AuthSessionMissingError) → 401, ensureBuyerProfile not called", async () => {
    bareClient.auth.getUser.mockResolvedValue({ data: { user: null }, error: new AuthSessionMissingError() });
    await expectError(await POST(post()), 401, "UNAUTHENTICATED");
    expect(ensureBuyerProfile).not.toHaveBeenCalled();
  });

  it("a 4xx AuthApiError (user_not_found) → 401, ensureBuyerProfile not called", async () => {
    bareClient.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthApiError("User not found", 403, "user_not_found"),
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

  it("with a re-issue handle → verifies it on the cookie client and answers without the handle", async () => {
    ensureBuyerProfile.mockResolvedValue({ ok: true, status: 201, profile: PROFILE, reissue: { hashedToken: HASH } });
    const res = await POST(post());
    expect(res.status).toBe(201);
    expect(cookieClient.auth.verifyOtp).toHaveBeenCalledWith({ token_hash: HASH, type: "email" });
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ email: "b@example.test", name: "Aung", locale: "my" });
    expect(text).not.toContain(HASH);
  });

  it("a 200 'existing' with a re-issue handle is also re-issued", async () => {
    ensureBuyerProfile.mockResolvedValue({ ok: true, status: 200, profile: PROFILE, reissue: { hashedToken: HASH } });
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(cookieClient.auth.verifyOtp).toHaveBeenCalledTimes(1);
  });

  it("no re-issue needed (existing profile) → verifyOtp not called", async () => {
    await POST(post());
    expect(cookieClient.auth.verifyOtp).not.toHaveBeenCalled();
  });

  it.each([
    ["reissue null", null, undefined],
    ["verifyOtp error", { hashedToken: "h" }, { data: { session: null }, error: { status: 403, code: "otp_expired" } }],
    ["verifyOtp with no session", { hashedToken: "h" }, { data: { session: null }, error: null }],
    ["verifyOtp throws", { hashedToken: "h" }, "throw"],
  ])("%s → same status with reason sign_in_again", async (_n, reissue, verify) => {
    ensureBuyerProfile.mockResolvedValue({ ok: true, status: 201, profile: PROFILE, reissue });
    if (verify === "throw") cookieClient.auth.verifyOtp.mockRejectedValue(new Error("network"));
    else if (verify) cookieClient.auth.verifyOtp.mockResolvedValue(verify);
    const res = await POST(post());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ email: "b@example.test", name: "Aung", locale: "my", reason: "sign_in_again" });
  });

  it("never logs the re-issue handle", async () => {
    ensureBuyerProfile.mockResolvedValue({ ok: true, status: 201, profile: PROFILE, reissue: { hashedToken: HASH } });
    cookieClient.auth.verifyOtp.mockResolvedValue({ data: { session: null }, error: { status: 403, message: HASH } });
    await POST(post());
    const logged = JSON.stringify((console.error as unknown as { mock: { calls: unknown[] } }).mock.calls);
    expect(logged).not.toContain(HASH);
  });

  it.each(["staff", "unconfirmed", "not_email_code"] as const)("403 %s → FORBIDDEN with reason", async (reason) => {
    ensureBuyerProfile.mockResolvedValue({ ok: false, status: 403, code: "FORBIDDEN", reason });
    const json = await expectError(await POST(post()), 403, "FORBIDDEN");
    expect(json.error.reason).toBe(reason);
    expect(typeof json.error.message).toBe("string");
  });

  it("each 403 reason has its own message", async () => {
    const messages = new Set<string>();
    for (const reason of ["staff", "unconfirmed", "not_email_code"] as const) {
      ensureBuyerProfile.mockResolvedValue({ ok: false, status: 403, code: "FORBIDDEN", reason });
      messages.add((await (await POST(post())).json()).error.message);
    }
    expect(messages.size).toBe(3);
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
    expect(cookieClient.auth.getSession).not.toHaveBeenCalled();
    expect(ensureBuyerProfile).not.toHaveBeenCalled();
    expect(bareClient.auth.getUser).not.toHaveBeenCalled();
  });

  it('{ "email": null } still → 422 (the key alone is refused)', async () => {
    await expectError(await POST(post(JSON.stringify({ email: null }))), 422, "VALIDATION");
    expect(cookieClient.auth.getSession).not.toHaveBeenCalled();
    expect(ensureBuyerProfile).not.toHaveBeenCalled();
  });

  it("malformed JSON → 422 VALIDATION", async () => {
    await expectError(await POST(post("{not json")), 422, "VALIDATION");
    expect(cookieClient.auth.getSession).not.toHaveBeenCalled();
    expect(ensureBuyerProfile).not.toHaveBeenCalled();
  });

  it("a body over 4 KB → 413 VALIDATION, before any Auth call", async () => {
    const big = JSON.stringify({ pad: "x".repeat(5000) });
    await expectError(await POST(post(big)), 413, "VALIDATION");
    expect(cookieClient.auth.getSession).not.toHaveBeenCalled();
    expect(ensureBuyerProfile).not.toHaveBeenCalled();
  });

  it("a content-length over 4 KB → 413 without reading the body", async () => {
    const req = new Request("http://localhost/api/account/profile", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json", "content-length": "10000" },
    });
    await expectError(await POST(req), 413, "VALIDATION");
    expect(cookieClient.auth.getSession).not.toHaveBeenCalled();
  });

  it("a body of exactly 4 KB is fine", async () => {
    const body = JSON.stringify({ pad: "x".repeat(4096 - 10) });
    expect(body.length).toBe(4096);
    expect((await POST(post(body))).status).toBe(200);
  });
});

describe("POST — cross-site refusal", () => {
  function withHeaders(h: Record<string, string>): Request {
    return new Request("http://localhost/api/account/profile", { method: "POST", headers: h });
  }

  it.each(["cross-site", "same-site"])("sec-fetch-site: %s → 403 FORBIDDEN, before any Auth call", async (site) => {
    await expectError(await POST(withHeaders({ "sec-fetch-site": site })), 403, "FORBIDDEN");
    expect(cookieClient.auth.getSession).not.toHaveBeenCalled();
    expect(ensureBuyerProfile).not.toHaveBeenCalled();
  });

  it("an Origin whose host differs from Host → 403", async () => {
    await expectError(
      await POST(withHeaders({ origin: "https://evil.test", host: "kuunyi.com" })),
      403,
      "FORBIDDEN",
    );
    expect(cookieClient.auth.getSession).not.toHaveBeenCalled();
  });

  it("Origin \"null\" → 403", async () => {
    await expectError(await POST(withHeaders({ origin: "null", host: "kuunyi.com" })), 403, "FORBIDDEN");
    expect(cookieClient.auth.getSession).not.toHaveBeenCalled();
  });

  it("same-origin browser request (Origin host = Host, sec-fetch-site same-origin) → allowed", async () => {
    const res = await POST(
      withHeaders({ origin: "https://kuunyi.com", host: "kuunyi.com", "sec-fetch-site": "same-origin" }),
    );
    expect(res.status).toBe(200);
  });

  it("no Origin and no sec-fetch-site (not a browser) → allowed; the cookie still decides", async () => {
    expect((await POST(withHeaders({}))).status).toBe(200);
    expect(cookieClient.auth.getSession).toHaveBeenCalled();
  });
});
