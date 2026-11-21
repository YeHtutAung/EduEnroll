import { NextResponse } from "next/server";
import { createClient as createBareClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireBuyer } from "@/lib/buyers/requireBuyer";
import { classifyAuthError } from "@/lib/buyers/authErrors";
import { buyerError } from "@/lib/buyers/errors";
import { ensureBuyerProfile, type EnsureResult } from "@/server/buyers/ensureBuyerProfile";

// ─── /api/account/profile: the website's buyer profile ──────────────────────
//
// GET  → requireBuyer(), then { email, name, locale }.
// POST → the website's "POST /me": cookie session only (Bearer belongs to the
//        app's own route), Auth accepts that exact token, then
//        ensureBuyerProfile claims or creates the profile.
//
// An Auth outage is 503 SERVER, never 401: a 401 signs the buyer out.
// Logs fixed strings only: never a token or an email.

export const dynamic = "force-dynamic";

type AuthUser = { id: string; email?: string | null; email_confirmed_at?: string | null };

const unauthenticated = () => buyerError(401, "UNAUTHENTICATED", "Sign in required.");
const authUnavailable = () => buyerError(503, "SERVER", "Sign-in service unavailable. Try again.");

export async function GET(): Promise<NextResponse> {
  const ctx = await requireBuyer();
  if (ctx instanceof NextResponse) return ctx;

  const { data, error } = await createAdminClient()
    .from("buyer_profiles")
    .select("name, locale")
    .eq("id", ctx.buyerId)
    .maybeSingle();
  if (error) {
    console.error("[account/profile] buyer_profiles read failed");
    return buyerError(503, "SERVER", "Try again.");
  }
  // requireBuyer just saw the row; gone now means it was deleted meanwhile.
  if (!data) return unauthenticated();
  const row = data as { name: string | null; locale: "my" | "en" };
  return NextResponse.json({ email: ctx.email, name: row.name, locale: row.locale });
}

/** True when the body is acceptable: empty, or JSON without an `email` key. */
async function bodyIsValid(request: Request): Promise<boolean> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return false;
  }
  if (text.trim() === "") return true;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "email")) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

type SessionRead = { kind: "token"; token: string } | { kind: "none" } | { kind: "unavailable" };

/**
 * The cookie session's token. getSession() may refresh a near-expiry session;
 * if that refresh can't reach Auth (or it throws), the answer is
 * "unavailable" (503), never "none" (401). Same rule as requireBuyer.
 */
async function readCookieSession(): Promise<SessionRead> {
  try {
    const { data, error } = await createClient().auth.getSession();
    if (error && classifyAuthError(error) === "unavailable") return { kind: "unavailable" };
    const token = data.session?.access_token;
    return token ? { kind: "token", token } : { kind: "none" };
  } catch {
    return { kind: "unavailable" };
  }
}

function mapResult(result: EnsureResult): NextResponse {
  if (result.ok) {
    const { email, name, locale } = result.profile;
    return NextResponse.json({ email, name, locale }, { status: result.status });
  }
  switch (result.code) {
    case "FORBIDDEN":
      return NextResponse.json(
        {
          error: {
            code: "FORBIDDEN",
            message:
              result.reason === "staff"
                ? "Staff accounts can't use buyer pages."
                : "Sign in with the code sent to your email.",
            reason: result.reason,
          },
        },
        { status: 403 },
      );
    case "DELETION_IN_PROGRESS":
      return buyerError(409, "DELETION_IN_PROGRESS", "This account is being deleted.");
    case "SERVER":
    default:
      return buyerError(503, "SERVER", "Try again.");
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!(await bodyIsValid(request))) {
    return buyerError(422, "VALIDATION", "Email can't be set here.");
  }

  const read = await readCookieSession();
  if (read.kind === "unavailable") {
    console.error("[account/profile] cookie session read failed");
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
      console.error("[account/profile] Auth getUser unavailable");
      return authUnavailable();
    }
    user = data.user;
  } catch (err) {
    if (classifyAuthError(err) === "rejected") return unauthenticated();
    console.error("[account/profile] Auth getUser threw");
    return authUnavailable();
  }

  // Only now: getUser has accepted this exact token for this user.
  return mapResult(await ensureBuyerProfile({ user, accessToken: token }));
}
