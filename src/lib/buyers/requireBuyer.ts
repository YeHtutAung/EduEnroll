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

/** The bearer token, else the cookie session's token (website). */
async function readToken(): Promise<string | null> {
  const h = headers();
  const header = h.get("x-supabase-auth") ?? h.get("authorization");
  if (header?.startsWith("Bearer ")) return header.substring(7);
  const { data } = await createClient().auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * Guard for every buyer route (web and mobile). Asks the Auth server; never a
 * local-only JWT check, so a deleted user or ended session fails at once.
 */
export async function requireBuyer(): Promise<BuyerContext | NextResponse> {
  const token = await readToken();
  if (!token) return buyerError(401, "UNAUTHENTICATED", "Sign in required.");

  let user: AuthUser;
  try {
    const client = createBareClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) {
      return classifyAuthError(error) === "rejected"
        ? buyerError(401, "UNAUTHENTICATED", "Sign in required.")
        : buyerError(503, "SERVER", "Sign-in service unavailable. Try again.");
    }
    user = data.user;
  } catch (err) {
    return classifyAuthError(err) === "rejected"
      ? buyerError(401, "UNAUTHENTICATED", "Sign in required.")
      : buyerError(503, "SERVER", "Sign-in service unavailable. Try again.");
  }

  // Read only after getUser has accepted this exact token.
  const sessionId = tokenClaim(token, "session_id");
  if (!sessionId) return buyerError(401, "UNAUTHENTICATED", "Sign in required.");

  const admin = createAdminClient();

  const staff = await admin.from("users").select("id").eq("id", user.id).maybeSingle();
  if (staff.error) return buyerError(503, "SERVER", "Try again.");
  if (staff.data) return buyerError(403, "FORBIDDEN", "Staff accounts can't use buyer pages.");

  const profile = await admin
    .from("buyer_profiles")
    .select("id, email, is_reviewer, deleted_at")
    .eq("id", user.id)
    .maybeSingle();
  if (profile.error) return buyerError(503, "SERVER", "Try again.");
  const p = profile.data as { id: string; email: string; is_reviewer: boolean; deleted_at: string | null } | null;
  if (!p || p.deleted_at) return buyerError(401, "UNAUTHENTICATED", "Sign in required.");
  if (p.email !== (user.email ?? "").toLowerCase()) {
    return buyerError(401, "UNAUTHENTICATED", "Sign in required.");
  }

  return { buyerId: p.id, email: p.email, isReviewer: p.is_reviewer, sessionId };
}
