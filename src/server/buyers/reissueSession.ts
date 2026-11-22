import { createClient } from "@/lib/supabase/server";
import type { Reissue } from "./ensureBuyerProfile";

// ─── Re-issue the session ensureBuyerProfile's password reset ended ─────────
//
// Shared by /api/account/profile and /auth/callback. verifyOtp on the cookie
// server client writes the fresh session cookies through next/headers
// cookies(), which Next merges onto whatever response the route handler
// returns (JSON or redirect). Never throws. Logs a fixed string only: the
// hash is a sign-in credential.

/** Turn the re-issue hash into this browser's new session. */
export async function reissueSession(hashedToken: string, logTag: string): Promise<boolean> {
  try {
    const { data, error } = await createClient().auth.verifyOtp({ token_hash: hashedToken, type: "email" });
    if (error || !data?.session) {
      console.error(`[${logTag}] session re-issue failed`);
      return false;
    }
    return true;
  } catch {
    console.error(`[${logTag}] session re-issue failed`);
    return false;
  }
}

/**
 * true when the caller's session is usable afterwards: no reset ran
 * (`reissue` absent), or the re-issue worked. false means the profile exists
 * but the buyer has to sign in once more.
 */
export async function settleReissue(reissue: Reissue | null | undefined, logTag: string): Promise<boolean> {
  if (reissue === undefined) return true;
  return reissue !== null && (await reissueSession(reissue.hashedToken, logTag));
}
