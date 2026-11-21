import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { createClient as createBareClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { tokenClaim } from "@/lib/authMethod";
import { classifyAuthError } from "./authErrors";
import { buyerError } from "./errors";

export interface BuyerContext {
  buyerId: string;
  email: string;
  isReviewer: boolean;
  sessionId: string;
}

type AuthUser = { id: string; email?: string | null };

type TokenRead =
  | { kind: "token"; token: string }
  | { kind: "none" }
  | { kind: "unavailable" };

const unauthenticated = () => buyerError(401, "UNAUTHENTICATED", "Sign in required.");
const authUnavailable = () => buyerError(503, "SERVER", "Sign-in service unavailable. Try again.");

/**
 * The bearer token, else the cookie session's token (website). getSession()
 * may refresh a near-expiry session; if that refresh can't reach Auth, the
 * answer is "unavailable" (503), never "none" (401).
 */
async function readToken(): Promise<TokenRead> {
  const h = headers();
  const header = h.get("x-supabase-auth") ?? h.get("authorization");
  if (header?.startsWith("Bearer ")) return { kind: "token", token: header.substring(7) };
  try {
    const { data, error } = await createClient().auth.getSession();
    if (error && classifyAuthError(error) === "unavailable") return { kind: "unavailable" };
    const token = data.session?.access_token;
    return token ? { kind: "token", token } : { kind: "none" };
  } catch {
    return { kind: "unavailable" };
  }
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

  let user: AuthUser;
  try {
    const client = createBareClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) {
      if (classifyAuthError(error) === "rejected") return unauthenticated();
      console.error("[requireBuyer] Auth getUser unavailable");
      return authUnavailable();
    }
    user = data.user;
  } catch (err) {
    if (classifyAuthError(err) === "rejected") return unauthenticated();
    console.error("[requireBuyer] Auth getUser threw");
    return authUnavailable();
  }

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
