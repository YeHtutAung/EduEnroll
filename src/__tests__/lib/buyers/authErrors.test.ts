import { describe, it, expect } from "vitest";
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { classifyAuthError } from "@/lib/buyers/authErrors";

describe("classifyAuthError", () => {
  it.each([
    [new AuthApiError("expired", 401, "bad_jwt")],
    [new AuthApiError("gone", 403, "user_not_found")],
    [new AuthApiError("ended", 403, "session_not_found")],
    [new AuthApiError("bad", 400, "validation_failed")],
  ])("a 4xx answer is a rejection", (err) => {
    expect(classifyAuthError(err)).toBe("rejected");
  });

  it.each([
    [new AuthApiError("slow down", 429, "over_request_rate_limit")],
    [new AuthApiError("boom", 500, "unexpected_failure")],
    [new AuthApiError("bad gateway", 502, undefined as unknown as string)],
    [new AuthRetryableFetchError("network", 0)],
    [new Error("aborted")],
  ])("a 429, a 5xx, a network failure or anything unknown means Auth is unavailable", (err) => {
    expect(classifyAuthError(err)).toBe("unavailable");
  });
});
