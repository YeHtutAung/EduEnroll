import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { tokenClaim } from "@/lib/authMethod";
import { buyerError } from "./errors";
import { acceptToken, readCookieToken, type AuthUser, type CookieTokenRead } from "./sessionUser";

export interface BuyerContext {
  buyerId: string;
  email: string;
  isReviewer: boolean;
  sessionId: string;
}

const unauthenticated = () => buyerError(401, "UNAUTHENTICATED", "Sign in required.");
const authUnavailable = () => buyerError(503, "SERVER", "Sign-in service unavailable. Try again.");

/**
 * The bearer token, else the cookie session's token (website). The cookie
 * read's 401/503 rule lives in readCookieToken (sessionUser.ts).
 */
async function readToken(): Promise<CookieTokenRead> {
  const h = headers();
  const header = h.get("x-supabase-auth") ?? h.get("authorization");
  if (header?.startsWith("Bearer ")) return { kind: "token", token: header.substring(7) };
  return readCookieToken();
}

/**
 * Guard for every buyer route (web and mobile). Asks the Auth server; never a
 * local-only JWT check, so a deleted user or ended session fails at once.
 * Logs fixed strings only: never a token, email or id.
 */
export async function requireBuyer(): Promise<BuyerContext | NextResponse> {
  const read = await readToken();
  if (read.kind === "unavailable") {
    console.error("[requireBuyer] cookie session read failed");
    return authUnavailable();
  }
  if (read.kind === "none") return unauthenticated();
  const token = read.token;

  const accepted = await acceptToken(token);
  if (accepted.kind === "rejected") return unauthenticated();
  if (accepted.kind === "unavailable") {
    console.error("[requireBuyer] Auth getUser unavailable");
    return authUnavailable();
  }
  const user: AuthUser = accepted.user;

  // Read only after getUser has accepted this exact token.
  const sessionId = tokenClaim(token, "session_id");
  if (!sessionId) return unauthenticated();

  const admin = createAdminClient();

  const staff = await admin.from("users").select("id").eq("id", user.id).maybeSingle();
  if (staff.error) {
    console.error("[requireBuyer] users lookup failed");
    return buyerError(503, "SERVER", "Try again.");
  }
  if (staff.data) return buyerError(403, "FORBIDDEN", "Staff accounts can't use buyer pages.");

  const profile = await admin
    .from("buyer_profiles")
    .select("id, email, is_reviewer, deleted_at")
    .eq("id", user.id)
    .maybeSingle();
  if (profile.error) {
    console.error("[requireBuyer] buyer_profiles lookup failed");
    return buyerError(503, "SERVER", "Try again.");
  }
  const p = profile.data as { id: string; email: string; is_reviewer: boolean; deleted_at: string | null } | null;
  if (!p || p.deleted_at) return unauthenticated();
  if (p.email !== (user.email ?? "").toLowerCase()) return unauthenticated();

  return { buyerId: p.id, email: p.email, isReviewer: p.is_reviewer, sessionId };
}
