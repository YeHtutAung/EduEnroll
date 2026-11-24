import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── GET /auth/callback: the Google (PKCE) return leg ───────────────────────
// Exchanges the code on the cookie client, has Auth accept the new token, then
// ensureBuyerProfile decides where the buyer lands. Every answer is a 303 to
// this request's own origin with Cache-Control: no-store, and nothing secret
// is ever logged.

const cookieClient = {
  auth: { exchangeCodeForSession: vi.fn(), signOut: vi.fn(), verifyOtp: vi.fn() },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: () => cookieClient }));

// The route's own fallback cookie clearing goes through next/headers cookies().
// getAll() here is what the route-handler cookie store holds: the request's
// cookies plus those the exchange just set.
const cookieJar = {
  names: [] as string[],
  getAll: vi.fn(() => cookieJar.names.map((name) => ({ name, value: "v" }))),
  set: vi.fn(),
};
vi.mock("next/headers", () => ({ cookies: () => cookieJar }));

const acceptToken = vi.fn();
vi.mock("@/lib/buyers/sessionUser", () => ({ acceptToken: (...a: unknown[]) => acceptToken(...a) }));

const ensureBuyerProfile = vi.fn();
vi.mock("@/server/buyers/ensureBuyerProfile", () => ({
  ensureBuyerProfile: (...args: unknown[]) => ensureBuyerProfile(...args),
}));

import { GET, dynamic } from "@/app/auth/callback/route";

const ORIGIN = "https://nihon-moment.kuunyi.com";
const CODE = "pkce-code-secret-0123456789abcdef";
const ACCESS = "access-token-secret-abcdef";
const REFRESH = "refresh-token-secret-abcdef";
const HASH = "reissue-hash-secret-0123456789";
const EMAIL = "buyer.secret@example.test";
const USER = { id: "u1", email: EMAIL, email_confirmed_at: "2026-11-01T00:00:00Z" };
const PROFILE = {
  id: "u1",
  email: EMAIL,
  phone_e164: null,
  name: null,
  locale: "my",
  is_reviewer: false,
  created_at: "x",
  updated_at: "x",
  deleted_at: null,
};

function req(query: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/auth/callback${query}`, { headers });
}
const withCode = (next = "/account") => `?code=${CODE}&next=${encodeURIComponent(next)}`;

function expectRedirect(res: Response, pathAndQuery: string) {
  expect(res.status).toBe(303);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("location")).toBe(`${ORIGIN}${pathAndQuery}`);
}

const consoleMethods = ["log", "info", "warn", "error", "debug"] as const;
let spies: { mock: { calls: unknown[][] }; mockRestore: () => void }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  spies = consoleMethods.map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  cookieClient.auth.exchangeCodeForSession.mockResolvedValue({
    data: { session: { access_token: ACCESS, refresh_token: REFRESH }, user: USER },
    error: null,
  });
  cookieClient.auth.signOut.mockResolvedValue({ error: null });
  cookieClient.auth.verifyOtp.mockResolvedValue({ data: { session: { access_token: "new" } }, error: null });
  acceptToken.mockResolvedValue({ kind: "ok", user: USER, token: ACCESS });
  ensureBuyerProfile.mockResolvedValue({ ok: true, status: 200, profile: PROFILE });
  cookieJar.names = [
    "sb-abcref-auth-token",
    "sb-abcref-auth-token.0",
    "sb-abcref-auth-token.1",
    "sb-abcref-auth-token-code-verifier",
    "x-tenant-slug",
    "sb-abcref-auth-tokenish",
  ];
});

afterEach(() => {
  // Nothing secret reaches any console method, whatever the branch.
  const logged = JSON.stringify(spies.map((s) => s.mock.calls));
  for (const s of spies) s.mockRestore();
  for (const secret of [CODE, ACCESS, REFRESH, HASH, EMAIL]) expect(logged).not.toContain(secret);
});

describe("dynamic", () => {
  it("is force-dynamic", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});

describe("the code exchange", () => {
  it("no code → google_failed, nothing exchanged", async () => {
    expectRedirect(await GET(req("?next=/account")), "/account?notice=google_failed");
    expect(cookieClient.auth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(ensureBuyerProfile).not.toHaveBeenCalled();
  });

  it("Google's own error (buyer cancelled) → google_failed", async () => {
    expectRedirect(await GET(req("?error=access_denied&error_description=denied")), "/account?notice=google_failed");
    expect(cookieClient.auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("exchanges the exact code on the cookie client", async () => {
    await GET(req(withCode()));
    expect(cookieClient.auth.exchangeCodeForSession).toHaveBeenCalledWith(CODE);
  });

  it("an exchange error → google_failed", async () => {
    cookieClient.auth.exchangeCodeForSession.mockResolvedValue({
      data: { session: null, user: null },
      error: { status: 400, message: `bad ${CODE}` },
    });
    expectRedirect(await GET(req(withCode())), "/account?notice=google_failed");
    expect(ensureBuyerProfile).not.toHaveBeenCalled();
  });

  it("an exchange that throws → google_failed", async () => {
    cookieClient.auth.exchangeCodeForSession.mockRejectedValue(new Error(`network ${CODE}`));
    expectRedirect(await GET(req(withCode())), "/account?notice=google_failed");
  });

  it("an exchange with no session → google_failed", async () => {
    cookieClient.auth.exchangeCodeForSession.mockResolvedValue({ data: { session: null, user: null }, error: null });
    expectRedirect(await GET(req(withCode())), "/account?notice=google_failed");
  });
});

describe("Auth accepts the new token before the profile", () => {
  it("passes the accepted user and the exchanged token to ensureBuyerProfile", async () => {
    await GET(req(withCode()));
    expect(acceptToken).toHaveBeenCalledWith(ACCESS);
    expect(ensureBuyerProfile).toHaveBeenCalledWith({ user: USER, accessToken: ACCESS });
  });

  it("a rejected token → sign out locally, google_failed", async () => {
    acceptToken.mockResolvedValue({ kind: "rejected" });
    expectRedirect(await GET(req(withCode())), "/account?notice=google_failed");
    expect(cookieClient.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(ensureBuyerProfile).not.toHaveBeenCalled();
  });

  it("Auth unavailable → keep the session, retry_profile", async () => {
    acceptToken.mockResolvedValue({ kind: "unavailable" });
    expectRedirect(await GET(req(withCode())), "/account?notice=retry_profile");
    expect(cookieClient.auth.signOut).not.toHaveBeenCalled();
    expect(ensureBuyerProfile).not.toHaveBeenCalled();
  });
});

describe("ensureBuyerProfile's answer", () => {
  it("200 → next, no re-issue", async () => {
    expectRedirect(await GET(req(withCode("/account/tickets?x=1"))), "/account/tickets?x=1");
    expect(cookieClient.auth.verifyOtp).not.toHaveBeenCalled();
    expect(cookieClient.auth.signOut).not.toHaveBeenCalled();
  });

  it("201 → re-issues on the cookie client, then next", async () => {
    ensureBuyerProfile.mockResolvedValue({ ok: true, status: 201, profile: PROFILE, reissue: { hashedToken: HASH } });
    const res = await GET(req(withCode()));
    expectRedirect(res, "/account");
    expect(cookieClient.auth.verifyOtp).toHaveBeenCalledWith({ token_hash: HASH, type: "email" });
    expect(res.headers.get("location")).not.toContain(HASH);
  });

  it("200 with a re-issue handle is re-issued too", async () => {
    ensureBuyerProfile.mockResolvedValue({ ok: true, status: 200, profile: PROFILE, reissue: { hashedToken: HASH } });
    expectRedirect(await GET(req(withCode())), "/account");
    expect(cookieClient.auth.verifyOtp).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["reissue null", null, undefined],
    ["verifyOtp error", { hashedToken: HASH }, { data: { session: null }, error: { status: 403, message: HASH } }],
    ["verifyOtp with no session", { hashedToken: HASH }, { data: { session: null }, error: null }],
    ["verifyOtp throws", { hashedToken: HASH }, "throw"],
  ])("201, %s → sign_in_again", async (_n, reissue, verify) => {
    ensureBuyerProfile.mockResolvedValue({ ok: true, status: 201, profile: PROFILE, reissue });
    if (verify === "throw") cookieClient.auth.verifyOtp.mockRejectedValue(new Error(HASH));
    else if (verify) cookieClient.auth.verifyOtp.mockResolvedValue(verify);
    expectRedirect(await GET(req(withCode("/account/tickets"))), "/account?notice=sign_in_again");
  });

  it("403 staff → sign out locally, staff", async () => {
    ensureBuyerProfile.mockResolvedValue({ ok: false, status: 403, code: "FORBIDDEN", reason: "staff" });
    expectRedirect(await GET(req(withCode())), "/account?notice=staff");
    expect(cookieClient.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it.each(["unconfirmed", "not_email_code"] as const)("403 %s → sign out locally, google_failed", async (reason) => {
    ensureBuyerProfile.mockResolvedValue({ ok: false, status: 403, code: "FORBIDDEN", reason });
    expectRedirect(await GET(req(withCode())), "/account?notice=google_failed");
    expect(cookieClient.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("409 → sign out locally, deleting", async () => {
    ensureBuyerProfile.mockResolvedValue({ ok: false, status: 409, code: "DELETION_IN_PROGRESS" });
    expectRedirect(await GET(req(withCode())), "/account?notice=deleting");
    expect(cookieClient.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("503 → keep the session, retry_profile", async () => {
    ensureBuyerProfile.mockResolvedValue({ ok: false, status: 503, code: "SERVER" });
    expectRedirect(await GET(req(withCode())), "/account?notice=retry_profile");
    expect(cookieClient.auth.signOut).not.toHaveBeenCalled();
  });

  it("ensureBuyerProfile throwing → keep the session, retry_profile", async () => {
    ensureBuyerProfile.mockRejectedValue(new Error(EMAIL));
    expectRedirect(await GET(req(withCode())), "/account?notice=retry_profile");
  });

  it("a sign-out that fails still redirects", async () => {
    ensureBuyerProfile.mockResolvedValue({ ok: false, status: 409, code: "DELETION_IN_PROGRESS" });
    cookieClient.auth.signOut.mockRejectedValue(new Error("network"));
    expectRedirect(await GET(req(withCode())), "/account?notice=deleting");
  });
});

describe("no open redirect", () => {
  it.each(["//evil.example", "/\\evil", "https://evil.example", "javascript:alert(1)", "%2F%2Fevil", "/%2F%2Fevil", ""])(
    "next=%s → /account",
    async (next) => {
      expectRedirect(await GET(req(withCode(next))), "/account");
    },
  );

  it("a missing next → /account", async () => {
    expectRedirect(await GET(req(`?code=${CODE}`)), "/account");
  });

  it("ignores X-Forwarded-Host: the redirect stays on the request's origin", async () => {
    const res = await GET(req(withCode(), { "x-forwarded-host": "evil.example", host: "evil.example" }));
    expectRedirect(res, "/account");
  });

  it("error redirects also stay on the request's origin", async () => {
    const res = await GET(req("", { "x-forwarded-host": "evil.example" }));
    expectRedirect(res, "/account?notice=google_failed");
  });
});

// ─── A sign-out that fails must still clear the session cookies ─────────────
// signOut({ scope: "local" }) calls /logout first; on a network error or a 5xx
// it RETURNS { error } without removing the session, so the 303 would carry
// the fresh Google session. The route then deletes the auth cookies itself.
describe("sign-out fallback", () => {
  const AUTH_COOKIES = ["sb-abcref-auth-token", "sb-abcref-auth-token.0", "sb-abcref-auth-token.1"];

  const branches: [string, () => void, string][] = [
    ["rejected token", () => acceptToken.mockResolvedValue({ kind: "rejected" }), "/account?notice=google_failed"],
    [
      "403 staff",
      () => ensureBuyerProfile.mockResolvedValue({ ok: false, status: 403, code: "FORBIDDEN", reason: "staff" }),
      "/account?notice=staff",
    ],
    [
      "403 unconfirmed",
      () => ensureBuyerProfile.mockResolvedValue({ ok: false, status: 403, code: "FORBIDDEN", reason: "unconfirmed" }),
      "/account?notice=google_failed",
    ],
    [
      "409",
      () => ensureBuyerProfile.mockResolvedValue({ ok: false, status: 409, code: "DELETION_IN_PROGRESS" }),
      "/account?notice=deleting",
    ],
    [
      "failed re-issue",
      () => ensureBuyerProfile.mockResolvedValue({ ok: true, status: 201, profile: PROFILE, reissue: null }),
      "/account?notice=sign_in_again",
    ],
  ];

  function deleted(): string[] {
    return cookieJar.set.mock.calls
      .filter(([, value, options]) => value === "" && (options as { maxAge?: number })?.maxAge === 0)
      .map(([name]) => name as string);
  }

  function expectAuthCookiesDeleted() {
    expect(deleted().sort()).toEqual([...AUTH_COOKIES].sort());
    for (const call of cookieJar.set.mock.calls) {
      expect(call[2]).toMatchObject({ path: "/", maxAge: 0 });
    }
  }

  describe.each(branches)("%s", (_name, arrange, target) => {
    it("signOut resolving { error } → the auth cookies are deleted on the response", async () => {
      arrange();
      cookieClient.auth.signOut.mockResolvedValue({ error: { status: 503, name: "AuthRetryableFetchError" } });
      expectRedirect(await GET(req(withCode())), target);
      expect(cookieClient.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
      expectAuthCookiesDeleted();
    });

    it("signOut throwing → the auth cookies are deleted on the response", async () => {
      arrange();
      cookieClient.auth.signOut.mockRejectedValue(new Error("network"));
      expectRedirect(await GET(req(withCode())), target);
      expectAuthCookiesDeleted();
    });

    it("a clean signOut leaves the cookies to supabase-js", async () => {
      arrange();
      expectRedirect(await GET(req(withCode())), target);
      expect(cookieJar.set).not.toHaveBeenCalled();
    });
  });

  it("never touches the code verifier or unrelated cookies", async () => {
    acceptToken.mockResolvedValue({ kind: "rejected" });
    cookieClient.auth.signOut.mockResolvedValue({ error: { status: 500 } });
    await GET(req(withCode()));
    const names = cookieJar.set.mock.calls.map(([n]) => n);
    expect(names).not.toContain("sb-abcref-auth-token-code-verifier");
    expect(names).not.toContain("x-tenant-slug");
    expect(names).not.toContain("sb-abcref-auth-tokenish");
  });

  it("a cookie store that throws still redirects", async () => {
    acceptToken.mockResolvedValue({ kind: "rejected" });
    cookieClient.auth.signOut.mockResolvedValue({ error: { status: 500 } });
    cookieJar.getAll.mockImplementationOnce(() => {
      throw new Error("store");
    });
    expectRedirect(await GET(req(withCode())), "/account?notice=google_failed");
  });
});
