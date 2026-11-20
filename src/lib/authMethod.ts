// ─── Which sign-in method produced a Supabase session ───────────────────────
//
// Supabase access tokens carry an `amr` claim, e.g.
//   [{ "method": "password", "timestamp": 1763600000 }]
// Staff must sign in with a password. Buyers will sign in with an email code,
// and email codes work for every account in the project, so a staff account
// opened with a code must not reach admin.
//
// DECODES ONLY. It never proves a token is genuine. Call it only with the
// access token of a session that supabase.auth.getUser() has just accepted.
// Uses atob (not Buffer) so it also runs in the middleware's edge runtime.

export function sessionAuthMethods(accessToken: string | null | undefined): string[] {
  if (!accessToken) return [];
  const parts = accessToken.split(".");
  if (parts.length !== 3) return [];
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const claims = JSON.parse(atob(padded)) as { amr?: unknown };
    if (!Array.isArray(claims.amr)) return [];
    return claims.amr
      .map((m) => (m && typeof m === "object" ? (m as { method?: unknown }).method : m))
      .filter((m): m is string => typeof m === "string");
  } catch {
    return [];
  }
}

export function isPasswordSession(accessToken: string | null | undefined): boolean {
  return sessionAuthMethods(accessToken).includes("password");
}
