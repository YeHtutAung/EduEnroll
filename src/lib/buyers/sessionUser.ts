import {
  createClient as createBareClient,
  isAuthApiError,
  isAuthError,
  isAuthSessionMissingError,
} from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { classifyAuthError } from "./authErrors";

// ─── Shared token reading for buyer routes ──────────────────────────────────
//
// requireBuyer and /api/account/profile both read the cookie session and both
// have Auth accept a token. One copy here so the 401/503 rules can't drift.
// Nothing here logs: callers log fixed strings. Never log a token or email.

export type CookieTokenRead =
  | { kind: "token"; token: string }
  | { kind: "none" }
  | { kind: "unavailable" };

export type AuthUser = { id: string; email?: string | null; email_confirmed_at?: string | null };

export type TokenAcceptance =
  | { kind: "ok"; user: AuthUser; token: string }
  | { kind: "rejected" }
  | { kind: "unavailable" };

/**
 * With no session, a getSession() error is "none" (401) only when Auth itself
 * said the session isn't there: AuthSessionMissingError,
 * AuthInvalidTokenResponseError, or a 4xx AuthApiError other than 429.
 * Everything else (a retryable fetch error, AuthUnknownError, an Auth 5xx or
 * 429, or anything that isn't an AuthError) is an outage: 503, never 401.
 */
function sessionErrorIsOutage(error: unknown): boolean {
  if (!isAuthError(error)) return true;
  if (isAuthSessionMissingError(error)) return false;
  if (error.name === "AuthInvalidTokenResponseError") return false;
  if (isAuthApiError(error)) return error.status >= 500 || error.status === 429;
  return true;
}

/**
 * The website's cookie session token. getSession() may refresh a near-expiry
 * session; if that refresh can't reach Auth, or getSession throws, the answer
 * is "unavailable" (503), never "none" (401). A session that comes back is
 * used even when an error comes with it.
 */
export async function readCookieToken(): Promise<CookieTokenRead> {
  try {
    const { data, error } = await createClient().auth.getSession();
    const token = data?.session?.access_token;
    if (token) return { kind: "token", token };
    if (error != null && sessionErrorIsOutage(error)) return { kind: "unavailable" };
    return { kind: "none" };
  } catch {
    return { kind: "unavailable" };
  }
}

/**
 * getUser's answer. auth-js turns a 403 session_not_found (an ended session,
 * e.g. one ensureBuyerProfile signed out) into AuthSessionMissingError, not an
 * AuthApiError, so that is a rejection here. Otherwise classifyAuthError
 * decides: a 4xx other than 429 is rejected, anything else unavailable.
 */
function getUserFailure(error: unknown): TokenAcceptance {
  if (isAuthSessionMissingError(error)) return { kind: "rejected" };
  return classifyAuthError(error) === "rejected" ? { kind: "rejected" } : { kind: "unavailable" };
}

/**
 * Ask the Auth server whether it accepts this exact token. Never a local-only
 * JWT check. Uses a bare client that neither stores nor refreshes a session.
 * A 4xx (except 429) or an ended session is "rejected"; anything else that
 * fails is "unavailable".
 */
export async function acceptToken(token: string): Promise<TokenAcceptance> {
  try {
    const client = createBareClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) return getUserFailure(error);
    return { kind: "ok", user: data.user, token };
  } catch (err) {
    return getUserFailure(err);
  }
}
