import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AuthApiError,
  AuthInvalidTokenResponseError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthUnknownError,
} from "@supabase/supabase-js";

// ─── sessionUser: the shared cookie read and Auth acceptance ────────────────
// "none" / "rejected" become 401; "unavailable" becomes 503 in the callers.

const cookieClient = { auth: { getSession: vi.fn() } };
vi.mock("@/lib/supabase/server", () => ({ createClient: () => cookieClient }));

const bareClient = { auth: { getUser: vi.fn() } };
const createBare = vi.fn<(...args: unknown[]) => typeof bareClient>(() => bareClient);
vi.mock("@supabase/supabase-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/supabase-js")>();
  return { ...actual, createClient: (...a: unknown[]) => createBare(...a) };
});

import { acceptToken, readCookieToken } from "@/lib/buyers/sessionUser";

const USER = { id: "u1", email: "b@example.test", email_confirmed_at: "2026-11-01T00:00:00Z" };

beforeEach(() => {
  vi.clearAllMocks();
  cookieClient.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
  bareClient.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null });
});

describe("readCookieToken", () => {
  it("returns the session's access_token", async () => {
    cookieClient.auth.getSession.mockResolvedValue({ data: { session: { access_token: "t1" } }, error: null });
    expect(await readCookieToken()).toEqual({ kind: "token", token: "t1" });
  });

  it("returns the token when getSession gives an error AND a session", async () => {
    cookieClient.auth.getSession.mockResolvedValue({
      data: { session: { access_token: "t1" } },
      error: new AuthRetryableFetchError("fetch failed", 0),
    });
    expect(await readCookieToken()).toEqual({ kind: "token", token: "t1" });
  });

  it("no session and no error → none", async () => {
    expect(await readCookieToken()).toEqual({ kind: "none" });
  });

  it.each([
    ["AuthSessionMissingError", new AuthSessionMissingError()],
    ["AuthInvalidTokenResponseError", new AuthInvalidTokenResponseError()],
    ["AuthApiError 400", new AuthApiError("Invalid Refresh Token", 400, "refresh_token_not_found")],
    ["AuthApiError 403", new AuthApiError("User not found", 403, "user_not_found")],
  ])("%s with no session → none", async (_name, error) => {
    cookieClient.auth.getSession.mockResolvedValue({ data: { session: null }, error });
    expect(await readCookieToken()).toEqual({ kind: "none" });
  });

  it.each([
    ["a retryable fetch error", new AuthRetryableFetchError("fetch failed", 0)],
    ["AuthApiError 500", new AuthApiError("boom", 500, "unexpected_failure")],
    ["AuthApiError 503", new AuthApiError("down", 503, "unexpected_failure")],
    ["AuthApiError 429", new AuthApiError("slow down", 429, "over_request_rate_limit")],
    ["AuthUnknownError", new AuthUnknownError("odd", new Error("html"))],
    ["a plain Error (not an AuthError)", new Error("odd")],
    ["a non-error value", { message: "odd" }],
  ])("%s with no session → unavailable", async (_name, error) => {
    cookieClient.auth.getSession.mockResolvedValue({ data: { session: null }, error });
    expect(await readCookieToken()).toEqual({ kind: "unavailable" });
  });

  it("getSession throwing → unavailable", async () => {
    cookieClient.auth.getSession.mockRejectedValue(new Error("boom"));
    expect(await readCookieToken()).toEqual({ kind: "unavailable" });
  });
});

describe("acceptToken", () => {
  it("returns the user and the same token when Auth accepts it", async () => {
    expect(await acceptToken("t1")).toEqual({ kind: "ok", user: USER, token: "t1" });
    expect(bareClient.auth.getUser).toHaveBeenCalledWith("t1");
  });

  it("uses a bare client that neither persists nor refreshes a session", async () => {
    await acceptToken("t1");
    expect(createBare).toHaveBeenCalledTimes(1);
    expect(createBare.mock.calls[0][2]).toEqual({ auth: { persistSession: false, autoRefreshToken: false } });
  });

  it("a 4xx AuthApiError (user_not_found) → rejected", async () => {
    bareClient.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthApiError("User not found", 403, "user_not_found"),
    });
    expect(await acceptToken("t1")).toEqual({ kind: "rejected" });
  });

  it("an ended session (AuthSessionMissingError, auth-js's form of 403 session_not_found) → rejected", async () => {
    bareClient.auth.getUser.mockResolvedValue({ data: { user: null }, error: new AuthSessionMissingError() });
    expect(await acceptToken("t1")).toEqual({ kind: "rejected" });
  });

  it("a thrown AuthSessionMissingError → rejected", async () => {
    bareClient.auth.getUser.mockRejectedValue(new AuthSessionMissingError());
    expect(await acceptToken("t1")).toEqual({ kind: "rejected" });
  });

  it("AuthUnknownError → unavailable", async () => {
    bareClient.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthUnknownError("odd", new Error("html")),
    });
    expect(await acceptToken("t1")).toEqual({ kind: "unavailable" });
  });

  it.each([
    ["5xx", new AuthApiError("boom", 500, "unexpected_failure")],
    ["429", new AuthApiError("slow down", 429, "over_request_rate_limit")],
    ["retryable fetch error", new AuthRetryableFetchError("fetch failed", 0)],
  ])("a %s error → unavailable", async (_name, error) => {
    bareClient.auth.getUser.mockResolvedValue({ data: { user: null }, error });
    expect(await acceptToken("t1")).toEqual({ kind: "unavailable" });
  });

  it("no user and no error → unavailable", async () => {
    bareClient.auth.getUser.mockResolvedValue({ data: { user: null }, error: null });
    expect(await acceptToken("t1")).toEqual({ kind: "unavailable" });
  });

  it("a thrown network error → unavailable", async () => {
    bareClient.auth.getUser.mockRejectedValue(new AuthRetryableFetchError("fetch failed", 0));
    expect(await acceptToken("t1")).toEqual({ kind: "unavailable" });
  });

  it("a thrown 4xx AuthApiError → rejected", async () => {
    bareClient.auth.getUser.mockRejectedValue(new AuthApiError("bad jwt", 401, "bad_jwt"));
    expect(await acceptToken("t1")).toEqual({ kind: "rejected" });
  });
});
