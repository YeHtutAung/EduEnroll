import {
  createClient as createBareClient,
  isAuthApiError,
  isAuthRetryableFetchError,
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
 * A getSession() error means Auth couldn't answer only when it is a
 * network/retryable fetch failure, or an Auth 5xx or 429. Anything else
 * (AuthSessionMissingError, AuthInvalidTokenResponseError, a 4xx) is a session
 * that isn't there, which is a 401, not an outage.
 */
function sessionErrorIsOutage(error: unknown): boolean {
  if (isAuthRetryableFetchError(error)) return true;
  if (isAuthApiError(error)) return error.status >= 500 || error.status === 429;
  return false;
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
    if (error && sessionErrorIsOutage(error)) return { kind: "unavailable" };
    return { kind: "none" };
  } catch {
    return { kind: "unavailable" };
  }
}

/**
 * Ask the Auth server whether it accepts this exact token. Never a local-only
 * JWT check. Uses a bare client that neither stores nor refreshes a session.
 * A 4xx (except 429) is "rejected"; anything else that fails is "unavailable".
 */
export async function acceptToken(token: string): Promise<TokenAcceptance> {
  try {
    const client = createBareClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) {
      return classifyAuthError(error) === "rejected" ? { kind: "rejected" } : { kind: "unavailable" };
    }
    return { kind: "ok", user: data.user, token };
  } catch (err) {
    return classifyAuthError(err) === "rejected" ? { kind: "rejected" } : { kind: "unavailable" };
  }
}
